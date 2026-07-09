#!/usr/bin/env python3
"""Carpo helper daemon: claims YouTube jobs, downloads sections locally, uploads."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HELPER_TOKEN_HEADER = "X-Carpo-Helper-Token"
DEFAULT_CONFIG_PATH = Path.home() / ".config" / "carpo-helper" / "config.json"
SECTION_PADDING_SECONDS = 3
YTDLP_SUBPROCESS_TIMEOUT_SECONDS = 180
# 60s safety margin under the server's 5-minute claim sweep.
JOB_DEADLINE_SECONDS = 240.0
MIN_PUT_BUDGET_SECONDS = 15.0
DEADLINE_EXCEEDED_MESSAGE = "helper deadline exceeded"
YTDLP_UPDATE_INTERVAL_SECONDS = 24 * 60 * 60
YTDLP_UPDATE_TIMEOUT_SECONDS = 60
ERROR_MESSAGE_MAX_LENGTH = 500
ALLOWED_EXTENSIONS = {
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
}
QUALITY_MAX_HEIGHT = {"720p": 720, "1080p": 1080}
DEFAULT_QUALITY = "1080p"

_shutdown_requested = False


class JobAborted(Exception):
    def __init__(self, clip_id: str):
        super().__init__("helper shutting down")
        self.clip_id = clip_id


def remaining_budget(deadline: float, now: float) -> float:
    return max(0.0, deadline - now)


def ytdlp_timeout_for_budget(
    budget: float,
    base_timeout: float = YTDLP_SUBPROCESS_TIMEOUT_SECONDS,
) -> float:
    return max(0.0, min(base_timeout, budget))


def render_config_json(
    base_url: str,
    helper_token: str,
    cookies_from_browser: str,
) -> str:
    return json.dumps(
        {
            "baseUrl": base_url,
            "helperToken": helper_token,
            "cookiesFromBrowser": cookies_from_browser,
        },
        indent=2,
    )


def section_bounds(trim_start: float, trim_end: float) -> tuple[float, float]:
    section_start = max(0.0, trim_start - SECTION_PADDING_SECONDS)
    section_end = trim_end + SECTION_PADDING_SECONDS
    return section_start, section_end


def ytdlp_format_for_quality(quality: str) -> tuple[str, str]:
    max_height = QUALITY_MAX_HEIGHT.get(quality, 1080)
    av1_cap = min(max_height, 720)
    format_sort = f"res:{max_height},+codec:h264"
    format_selector = (
        f"bestvideo[height<={max_height}][vcodec^=avc1]+bestaudio/"
        f"bestvideo[height<={max_height}]+bestaudio/"
        f"best[height<={max_height}]/"
        f"bestvideo[vcodec^=av01][height<={av1_cap}]+bestaudio/"
        f"bestvideo[height<={av1_cap}]+bestaudio/"
        "best"
    )
    return format_sort, format_selector


def build_ytdlp_command(
    *,
    yt_dlp_path: str,
    url: str,
    section_start: float,
    section_end: float,
    quality: str,
    output_dir: Path,
    cookies_from_browser: str | None,
) -> list[str]:
    format_sort, format_selector = ytdlp_format_for_quality(quality)
    command = [
        yt_dlp_path,
        "--no-playlist",
        "--download-sections",
        f"*{section_start}-{section_end}",
        "--force-keyframes-at-cuts",
        "--merge-output-format",
        "mp4",
        "-S",
        format_sort,
        "-f",
        format_selector,
        "--socket-timeout",
        "30",
        "-o",
        str(output_dir / "source.%(ext)s"),
        url,
    ]
    if cookies_from_browser:
        command[1:1] = ["--cookies-from-browser", cookies_from_browser]
    return command


def resolve_upload_url(base_url: str, upload_url: str) -> str:
    if upload_url.startswith(("http://", "https://")):
        return upload_url
    base = base_url.rstrip("/")
    if upload_url.startswith("/"):
        return f"{base}{upload_url}"
    return f"{base}/{upload_url}"


def truncate_error_message(message: str, max_length: int = ERROR_MESSAGE_MAX_LENGTH) -> str:
    if len(message) <= max_length:
        return message
    return message[: max_length - 3] + "..."


def content_type_for_path(path: Path) -> str | None:
    ext = path.suffix.lstrip(".").lower()
    return ALLOWED_EXTENSIONS.get(ext)


def validate_config(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("Config must be a JSON object")

    base_url = raw.get("baseUrl")
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("baseUrl is required and must be a non-empty string")
    base_url = base_url.strip().rstrip("/")

    helper_token = raw.get("helperToken")
    if not isinstance(helper_token, str) or not helper_token.strip():
        raise ValueError("helperToken is required and must be a non-empty string")

    cookies_raw = raw.get("cookiesFromBrowser", "chrome")
    if cookies_raw is None or cookies_raw == "":
        cookies_from_browser: str | None = None
    elif isinstance(cookies_raw, str):
        cookies_from_browser = cookies_raw.strip() or None
    else:
        raise ValueError("cookiesFromBrowser must be a string or null")

    poll_raw = raw.get("pollIntervalSeconds", 5)
    if not isinstance(poll_raw, (int, float)) or poll_raw <= 0:
        raise ValueError("pollIntervalSeconds must be a positive number")
    poll_interval_seconds = float(poll_raw)

    yt_dlp_path = raw.get("ytDlpPath", "yt-dlp")
    if not isinstance(yt_dlp_path, str) or not yt_dlp_path.strip():
        raise ValueError("ytDlpPath must be a non-empty string")

    cf_id = raw.get("cfAccessClientId")
    cf_secret = raw.get("cfAccessClientSecret")
    if (cf_id is None) ^ (cf_secret is None):
        raise ValueError(
            "cfAccessClientId and cfAccessClientSecret must both be set or both omitted",
        )
    if cf_id is not None:
        if not isinstance(cf_id, str) or not cf_id.strip():
            raise ValueError("cfAccessClientId must be a non-empty string")
        if not isinstance(cf_secret, str) or not cf_secret.strip():
            raise ValueError("cfAccessClientSecret must be a non-empty string")

    return {
        "baseUrl": base_url,
        "helperToken": helper_token.strip(),
        "cookiesFromBrowser": cookies_from_browser,
        "pollIntervalSeconds": poll_interval_seconds,
        "ytDlpPath": yt_dlp_path.strip(),
        "cfAccessClientId": cf_id.strip() if isinstance(cf_id, str) else None,
        "cfAccessClientSecret": cf_secret.strip() if isinstance(cf_secret, str) else None,
    }


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ValueError(f"Config file not found: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in config file: {exc}") from exc
    return validate_config(raw)


def resolve_config_path(cli_path: str | None) -> Path:
    env_path = os.environ.get("CARPO_HELPER_CONFIG")
    if cli_path:
        return Path(cli_path).expanduser()
    if env_path:
        return Path(env_path).expanduser()
    return DEFAULT_CONFIG_PATH


def api_headers(config: dict[str, Any], *, include_helper_token: bool = False) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if include_helper_token:
        headers[HELPER_TOKEN_HEADER] = config["helperToken"]
    cf_id = config.get("cfAccessClientId")
    cf_secret = config.get("cfAccessClientSecret")
    if cf_id and cf_secret:
        headers["CF-Access-Client-Id"] = cf_id
        headers["CF-Access-Client-Secret"] = cf_secret
    return headers


def api_request(
    config: dict[str, Any],
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    include_helper_token: bool = False,
) -> tuple[int, bytes, dict[str, str]]:
    url = f"{config['baseUrl']}{path}"
    data = None
    headers = api_headers(config, include_helper_token=include_helper_token)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def find_downloaded_file(workdir: Path) -> Path:
    merged = workdir / "source.mp4"
    if merged.exists():
        return merged
    candidates = sorted(workdir.glob("source.*"))
    if not candidates:
        raise RuntimeError("yt-dlp did not produce a source file")
    return candidates[0]


def run_ytdlp(command: list[str], timeout_seconds: float) -> None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"yt-dlp timed out after {timeout_seconds:.0f}s") from exc
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        detail = stderr or stdout or f"exit code {result.returncode}"
        raise RuntimeError(f"yt-dlp failed: {detail}")


def upload_file_put(
    config: dict[str, Any],
    upload_url: str,
    file_path: Path,
    content_type: str,
    timeout_seconds: float,
) -> None:
    resolved = resolve_upload_url(config["baseUrl"], upload_url)
    file_size = file_path.stat().st_size
    headers = {
        "Content-Type": content_type,
        "Content-Length": str(file_size),
    }
    cf_id = config.get("cfAccessClientId")
    cf_secret = config.get("cfAccessClientSecret")
    if cf_id and cf_secret:
        headers["CF-Access-Client-Id"] = cf_id
        headers["CF-Access-Client-Secret"] = cf_secret

    with file_path.open("rb") as handle:
        request = urllib.request.Request(
            resolved,
            data=handle,
            headers=headers,
            method="PUT",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                if response.status not in (200, 201):
                    raise RuntimeError(f"Upload failed with status {response.status}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Upload failed ({exc.code}): {body}") from exc


def post_fail(config: dict[str, Any], clip_id: str, error_message: str) -> None:
    try:
        status, body, _ = api_request(
            config,
            "POST",
            f"/api/helper/jobs/{clip_id}/fail",
            body={"errorMessage": truncate_error_message(error_message)},
            include_helper_token=True,
        )
        if status not in (200, 202):
            detail = body.decode("utf-8", errors="replace")
            logging.error("fail request for %s returned %s: %s", clip_id, status, detail)
    except Exception as exc:
        logging.error(
            "fail request for %s errored: %s (server claim sweep is the backstop)",
            clip_id,
            exc,
        )


def check_abort(clip_id: str) -> None:
    if _shutdown_requested:
        raise JobAborted(clip_id)


def check_deadline(deadline: float, minimum_budget: float = 0.0) -> float:
    budget = remaining_budget(deadline, time.monotonic())
    if budget <= minimum_budget:
        raise RuntimeError(DEADLINE_EXCEEDED_MESSAGE)
    return budget


def process_job(
    config: dict[str, Any],
    job: dict[str, Any],
    *,
    dry_run: bool = False,
) -> None:
    clip_id = job["clipId"]
    deadline = time.monotonic() + JOB_DEADLINE_SECONDS
    url = job["url"]
    trim_start = float(job["trimStart"])
    trim_end = float(job["trimEnd"])
    quality = job.get("quality") or DEFAULT_QUALITY

    logging.info("claimed clipId=%s quality=%s trim=%.1f-%.1f", clip_id, quality, trim_start, trim_end)

    workdir: Path | None = None
    try:
        section_start, section_end = section_bounds(trim_start, trim_end)
        workdir = Path(tempfile.mkdtemp(prefix="carpo-helper-"))
        command = build_ytdlp_command(
            yt_dlp_path=config["ytDlpPath"],
            url=url,
            section_start=section_start,
            section_end=section_end,
            quality=quality,
            output_dir=workdir,
            cookies_from_browser=config.get("cookiesFromBrowser"),
        )

        download_budget = check_deadline(deadline)
        download_started = time.monotonic()
        run_ytdlp(command, ytdlp_timeout_for_budget(download_budget))
        source_path = find_downloaded_file(workdir)
        size_bytes = source_path.stat().st_size
        size_mb = size_bytes / (1024 * 1024)
        elapsed = time.monotonic() - download_started
        logging.info(
            "downloaded clipId=%s in %.1fs, %.1f MB",
            clip_id,
            elapsed,
            size_mb,
        )

        check_abort(clip_id)
        content_type = content_type_for_path(source_path)
        if content_type is None:
            raise RuntimeError(
                f"Unsupported output format ({source_path.suffix}); expected mp4, webm, mov, or mkv",
            )

        if dry_run:
            logging.info("dry-run clipId=%s — skipping upload", clip_id)
            post_fail(config, clip_id, "dry run")
            logging.info("failed clipId=%s: dry run", clip_id)
            return

        check_abort(clip_id)
        check_deadline(deadline)
        status, body, _ = api_request(
            config,
            "POST",
            "/api/upload-url",
            body={
                "contentType": content_type,
                "sizeBytes": size_bytes,
                "filename": source_path.name,
            },
        )
        if status != 200:
            detail = body.decode("utf-8", errors="replace")
            if "exceeds maximum upload size" in detail.lower():
                raise RuntimeError(
                    f"Section too large for helper upload ({size_mb:.0f}MB)",
                )
            raise RuntimeError(f"upload-url request failed ({status}): {detail}")

        upload_info = json.loads(body.decode("utf-8"))
        upload_key = upload_info["key"]
        upload_url = upload_info["uploadUrl"]
        max_size_bytes = upload_info.get("maxSizeBytes", size_bytes)
        if size_bytes > max_size_bytes:
            raise RuntimeError(
                f"Section too large for helper upload ({size_mb:.0f}MB)",
            )

        check_abort(clip_id)
        put_budget = check_deadline(deadline, MIN_PUT_BUDGET_SECONDS)
        upload_file_put(config, upload_url, source_path, content_type, put_budget)
        logging.info("uploaded clipId=%s key=%s", clip_id, upload_key)

        check_abort(clip_id)
        check_deadline(deadline)
        fulfill_status, fulfill_body, _ = api_request(
            config,
            "POST",
            f"/api/helper/jobs/{clip_id}/fulfill",
            body={"uploadKey": upload_key, "sectionStart": section_start},
            include_helper_token=True,
        )
        if fulfill_status not in (200, 202):
            detail = fulfill_body.decode("utf-8", errors="replace")
            raise RuntimeError(f"fulfill request failed ({fulfill_status}): {detail}")

        logging.info("fulfilled clipId=%s sectionStart=%.1f", clip_id, section_start)
    except JobAborted:
        raise
    except Exception as exc:
        logging.exception("job failed clipId=%s", clip_id)
        post_fail(config, clip_id, str(exc))
        logging.info("failed clipId=%s: %s", clip_id, truncate_error_message(str(exc)))
    finally:
        if workdir and workdir.exists():
            shutil.rmtree(workdir, ignore_errors=True)


def try_claim(config: dict[str, Any]) -> dict[str, Any] | None:
    status, body, _ = api_request(
        config,
        "POST",
        "/api/helper/claim",
        include_helper_token=True,
    )
    if status == 204:
        return None
    if status == 200:
        return json.loads(body.decode("utf-8"))
    detail = body.decode("utf-8", errors="replace")
    raise RuntimeError(f"claim request failed ({status}): {detail}")


def update_ytdlp(config: dict[str, Any]) -> None:
    command = [config["ytDlpPath"], "-U"]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=YTDLP_UPDATE_TIMEOUT_SECONDS,
            check=False,
        )
        if result.returncode == 0:
            output = (result.stdout or result.stderr or "").strip()
            logging.info("yt-dlp update: %s", output or "ok")
        else:
            output = (result.stderr or result.stdout or "").strip()
            logging.warning("yt-dlp update failed: %s", output or f"exit {result.returncode}")
    except subprocess.TimeoutExpired:
        logging.warning("yt-dlp update timed out after %ss", YTDLP_UPDATE_TIMEOUT_SECONDS)
    except OSError as exc:
        logging.warning("yt-dlp update error: %s", exc)


def handle_shutdown_signal(_signum: int, _frame: Any) -> None:
    global _shutdown_requested
    _shutdown_requested = True


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


def run_loop(config: dict[str, Any], *, once: bool = False, dry_run: bool = False) -> None:
    update_ytdlp(config)
    last_update = time.monotonic()
    backoff_seconds = config["pollIntervalSeconds"]

    while not _shutdown_requested:
        try:
            try:
                job = try_claim(config)
                backoff_seconds = config["pollIntervalSeconds"]
            except Exception as exc:
                logging.error("claim error: %s", exc)
                time.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 60.0)
                if once:
                    return
                continue

            if job is None:
                if once:
                    return
                time.sleep(config["pollIntervalSeconds"])
                continue

            process_job(config, job, dry_run=dry_run)
        except JobAborted as exc:
            logging.info("shutdown requested; failing claimed clipId=%s", exc.clip_id)
            post_fail(config, exc.clip_id, "helper shutting down")
            return
        except Exception:
            logging.exception("unexpected error in job cycle; continuing")

        if once:
            return

        if time.monotonic() - last_update >= YTDLP_UPDATE_INTERVAL_SECONDS:
            update_ytdlp(config)
            last_update = time.monotonic()


def main() -> int:
    configure_logging()

    parser = argparse.ArgumentParser(description="Carpo helper daemon")
    parser.add_argument("--config", help="Path to config JSON file")
    parser.add_argument("--once", action="store_true", help="Process at most one job then exit")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Download only; fail job with 'dry run' instead of uploading",
    )
    args = parser.parse_args()

    try:
        config_path = resolve_config_path(args.config)
        config = load_config(config_path)
    except ValueError as exc:
        logging.error("%s", exc)
        return 1

    signal.signal(signal.SIGTERM, handle_shutdown_signal)
    signal.signal(signal.SIGINT, handle_shutdown_signal)

    logging.info("starting carpo helper (baseUrl=%s)", config["baseUrl"])
    run_loop(config, once=args.once, dry_run=args.dry_run)
    logging.info("carpo helper stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
