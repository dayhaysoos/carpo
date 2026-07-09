#!/usr/bin/env python3
"""Carpo encoder container HTTP server."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_CLIP_LENGTH_SECONDS = 60
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))
JOB_SECRET_HEADER = "X-Carpo-Job-Secret"
MAX_CALLBACK_ATTEMPTS = 5
MAX_INTERMEDIATE_CALLBACK_ATTEMPTS = 3
INITIAL_CALLBACK_BACKOFF_SECONDS = 0.5
DOWNLOAD_TIMEOUT_SECONDS = 600
ENCODE_TIMEOUT_SECONDS = 600
UPLOAD_TIMEOUT_SECONDS = 600
VIDEO_CONTAINER_EXTENSIONS = ("mp4", "mkv", "webm")
DEJAVU_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
KNOWN_FILTER_TYPES = frozenset({"caption"})


def log(message: str) -> None:
    print(message, flush=True)


def post_status(
    callback_url: str,
    status: str,
    error_message: str | None = None,
    *,
    secret: str | None = None,
    required: bool = False,
    max_attempts: int = MAX_CALLBACK_ATTEMPTS,
) -> bool:
    payload: dict[str, Any] = {"status": status}
    if error_message is not None:
        payload["errorMessage"] = error_message

    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if secret:
        headers[JOB_SECRET_HEADER] = secret

    last_error: urllib.error.URLError | None = None
    for attempt in range(max_attempts):
        request = urllib.request.Request(
            callback_url,
            data=data,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                response.read()
            return True
        except urllib.error.URLError as exc:
            last_error = exc
            log(
                f"status callback failed ({status}) attempt {attempt + 1}: {exc}",
            )
            if attempt < max_attempts - 1:
                time.sleep(INITIAL_CALLBACK_BACKOFF_SECONDS * (2**attempt))

    if required:
        message = str(last_error) if last_error else "unknown callback error"
        raise RuntimeError(
            f"Required status callback ({status}) failed after "
            f"{max_attempts} attempts: {message}",
        )
    return False


class ProgressCallbackTracker:
    """Tracks encoder progress callbacks.

    Intermediate updates are best-effort with retries. If one ultimately fails,
    the next successful callback carries the then-current state so polling
    clients catch up without blocking the encode. Terminal callbacks remain
    required and still bound worst-case staleness.
    """

    def __init__(self) -> None:
        self.current_state: str | None = None
        self._needs_resync = False

    def post(
        self,
        callback_url: str,
        status: str,
        *,
        secret: str | None = None,
        required: bool = False,
        error_message: str | None = None,
    ) -> None:
        self.current_state = status
        delivered = post_status(
            callback_url,
            status,
            error_message,
            secret=secret,
            required=required,
            max_attempts=(
                MAX_CALLBACK_ATTEMPTS
                if required
                else MAX_INTERMEDIATE_CALLBACK_ATTEMPTS
            ),
        )
        if delivered:
            self._needs_resync = False
            return

        if required:
            return

        self._needs_resync = True
        log(
            f"intermediate callback ({status}) dropped; "
            f"will piggyback {self.current_state} on next success",
        )

    def post_resync_if_needed(
        self,
        callback_url: str,
        *,
        secret: str | None = None,
    ) -> None:
        if not self._needs_resync or self.current_state is None:
            return

        delivered = post_status(
            callback_url,
            self.current_state,
            secret=secret,
            max_attempts=MAX_INTERMEDIATE_CALLBACK_ATTEMPTS,
        )
        if delivered:
            self._needs_resync = False


def resolve_max_clip_length(value: Any) -> float:
    if value is None:
        return float(MAX_CLIP_LENGTH_SECONDS)
    if not isinstance(value, (int, float)):
        return float(MAX_CLIP_LENGTH_SECONDS)
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float(MAX_CLIP_LENGTH_SECONDS)
    if parsed <= 0:
        return float(MAX_CLIP_LENGTH_SECONDS)
    return parsed


def validate_job(job: dict[str, Any]) -> str | None:
    trim_start = job.get("trimStart")
    trim_end = job.get("trimEnd")
    max_len = resolve_max_clip_length(job.get("maxClipLengthSeconds"))

    if not isinstance(trim_start, (int, float)) or not isinstance(trim_end, (int, float)):
        return "trimStart and trimEnd must be numbers"

    duration = float(trim_end) - float(trim_start)
    if duration <= 0:
        return "trimEnd must be greater than trimStart"
    if duration > max_len:
        return f"Clip length exceeds maximum of {max_len} seconds"

    source = job.get("source")
    if not isinstance(source, dict):
        return "source is required"

    source_type = source.get("type")
    if source_type == "youtube":
        url = source.get("url")
        if not isinstance(url, str) or not url.strip():
            return "YouTube URL is required"
    elif source_type == "file":
        path = source.get("path")
        if not isinstance(path, str) or not Path(path).exists():
            return "Local file path is required for file source"
    elif source_type == "upload":
        return "Upload sources are not supported in slice 1"
    else:
        return "source.type must be youtube, upload, or file"

    return None


def run_command(
    command: list[str],
    cwd: Path | None = None,
    *,
    timeout_seconds: int = ENCODE_TIMEOUT_SECONDS,
) -> None:
    log(f"running: {' '.join(command)}")
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        cmd = " ".join(command)
        raise RuntimeError(
            f"Command timed out after {timeout_seconds}s: {cmd}",
        ) from exc
    if completed.returncode != 0:
        stderr = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(stderr or f"command failed: {' '.join(command)}")


def select_source_file(candidates: list[Path]) -> Path:
    video_files = [
        path
        for path in candidates
        if path.suffix.lstrip(".").lower() in VIDEO_CONTAINER_EXTENSIONS
    ]
    if not video_files:
        names = ", ".join(path.name for path in candidates)
        raise RuntimeError(
            f"yt-dlp produced no video container file (found: {names})",
        )

    def preference_key(path: Path) -> int:
        ext = path.suffix.lstrip(".").lower()
        try:
            return VIDEO_CONTAINER_EXTENSIONS.index(ext)
        except ValueError:
            return len(VIDEO_CONTAINER_EXTENSIONS)

    return min(video_files, key=preference_key)


def download_youtube(url: str, workdir: Path) -> Path:
    output_template = str(workdir / "source.%(ext)s")
    run_command(
        [
            "yt-dlp",
            "--no-playlist",
            "--merge-output-format",
            "mp4",
            "-f",
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "-o",
            output_template,
            url,
        ],
        cwd=workdir,
        timeout_seconds=DOWNLOAD_TIMEOUT_SECONDS,
    )

    merged = workdir / "source.mp4"
    if merged.exists():
        return merged

    candidates = list(workdir.glob("source.*"))
    if not candidates:
        raise RuntimeError("yt-dlp did not produce a source file")
    return select_source_file(candidates)


def build_video_filter_chain(filters: list[Any], workdir: Path) -> str | None:
    """Map composable job filters to an ffmpeg -vf filter chain."""
    if not isinstance(filters, list):
        return None

    parts: list[str] = []
    for index, item in enumerate(filters):
        if not isinstance(item, dict):
            raise RuntimeError(f"filters[{index}] must be an object")

        filter_type = item.get("type")
        if filter_type == "caption":
            text = item.get("text")
            if not isinstance(text, str) or not text.strip():
                raise RuntimeError(f"filters[{index}].text is required for caption")
            parts.append(build_caption_drawtext(text, workdir))
            continue

        if filter_type not in KNOWN_FILTER_TYPES:
            raise RuntimeError(f"Unknown filter type: {filter_type!r}")

    return ",".join(parts) if parts else None


def build_caption_drawtext(text: str, workdir: Path) -> str:
    """Burn caption text with legible styling; textfile avoids drawtext escaping pitfalls."""
    text_path = workdir / f"caption-{len(text)}.txt"
    text_path.write_text(text, encoding="utf-8")

    return (
        f"drawtext=fontfile={DEJAVU_FONT}"
        f":textfile={text_path}"
        ":expansion=none"
        ":fontsize=h/18"
        ":fontcolor=white"
        ":borderw=3"
        ":bordercolor=black@0.85"
        ":box=1"
        ":boxcolor=black@0.45"
        ":boxborderw=8"
        ":x=(w-text_w)/2"
        ":y=h*0.90-text_h"
    )


def encode_clip(
    source: Path,
    trim_start: float,
    trim_end: float,
    output_mp4: Path,
    output_thumb: Path,
    *,
    filters: list[Any] | None = None,
    workdir: Path | None = None,
) -> None:
    duration = trim_end - trim_start
    filter_workdir = workdir or source.parent
    video_filters = build_video_filter_chain(filters or [], filter_workdir)

    encode_command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(trim_start),
        "-i",
        str(source),
        "-t",
        str(duration),
    ]
    if video_filters:
        encode_command.extend(["-vf", video_filters])
    encode_command.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(output_mp4),
        ],
    )
    # Input seeking (-ss before -i) is frame-accurate when re-encoding (not stream
    # copy); verified by scripts/test-encoder-contract.ts against a frame-counter
    # fixture trimmed at a non-keyframe offset (±1 frame).
    run_command(encode_command)

    thumb_command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(trim_start),
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-q:v",
        "2",
    ]
    if video_filters:
        thumb_command.extend(["-vf", video_filters])
    thumb_command.append(str(output_thumb))
    # Same input-seek pattern; thumbnail spot-check included in contract test.
    run_command(thumb_command)


def upload_file(
    upload_url: str,
    local_path: Path,
    content_type: str,
    *,
    secret: str | None = None,
) -> None:
    with local_path.open("rb") as handle:
        data = handle.read()
    headers = {"Content-Type": content_type}
    if secret:
        headers[JOB_SECRET_HEADER] = secret
    request = urllib.request.Request(
        upload_url,
        data=data,
        headers=headers,
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=UPLOAD_TIMEOUT_SECONDS) as response:
        response.read()


def upload_artifacts(
    job: dict[str, Any],
    mp4_path: Path,
    thumb_path: Path,
    *,
    secret: str | None = None,
) -> None:
    upload_urls = job.get("artifactUploadUrls", {})
    mp4_url = upload_urls.get("mp4")
    thumb_url = upload_urls.get("thumbnail")
    if not mp4_url or not thumb_url:
        raise RuntimeError("Artifact upload URLs are not configured")

    upload_file(mp4_url, mp4_path, "video/mp4", secret=secret)
    upload_file(thumb_url, thumb_path, "image/jpeg", secret=secret)


def copy_outputs_locally(job: dict[str, Any], mp4_path: Path, thumb_path: Path) -> None:
    outputs = job.get("outputs", {})
    output_dir = job.get("localOutputDir")
    if not output_dir:
        return

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(mp4_path, out_dir / Path(outputs.get("mp4Key", "clip.mp4")).name)
    shutil.copy2(thumb_path, out_dir / Path(outputs.get("thumbnailKey", "thumbnail.jpg")).name)


def run_result(
    status: str,
    job: dict[str, Any],
    *,
    error_message: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {"status": status}
    if error_message is not None:
        result["errorMessage"] = error_message
    if status == "complete":
        outputs = job.get("outputs", {})
        result["outputs"] = {
            "mp4Key": outputs.get("mp4Key", ""),
            "thumbnailKey": outputs.get("thumbnailKey", ""),
        }
    return result


def process_job(job: dict[str, Any]) -> dict[str, Any]:
    callback_url = job.get("callbackUrl")
    callback_secret = job.get("callbackSecret")
    progress = ProgressCallbackTracker()

    try:
        error = validate_job(job)
        if error:
            return run_result("failed", job, error_message=error)

        trim_start = float(job["trimStart"])
        trim_end = float(job["trimEnd"])
    except Exception as exc:  # noqa: BLE001 - validation bugs become confirmed failures
        message = str(exc) or "Job validation failed"
        return run_result("failed", job, error_message=message)

    with tempfile.TemporaryDirectory(prefix="carpo-encode-") as tmp:
        workdir = Path(tmp)
        source_path: Path | None = None

        try:
            if callback_url:
                progress.post(
                    callback_url,
                    "downloading",
                    secret=callback_secret,
                )

            source = job["source"]
            source_type = source["type"]

            if source_type == "youtube":
                source_path = download_youtube(source["url"], workdir)
            elif source_type == "file":
                source_path = Path(source["path"])
            elif source_type == "upload":
                raise RuntimeError("Upload sources are not supported in slice 1")
            else:
                raise RuntimeError(f"Unsupported source type: {source_type}")

            if callback_url:
                progress.post_resync_if_needed(
                    callback_url,
                    secret=callback_secret,
                )
                progress.post(
                    callback_url,
                    "encoding",
                    secret=callback_secret,
                )

            output_mp4 = workdir / "clip.mp4"
            output_thumb = workdir / "thumbnail.jpg"
            encode_clip(
                source_path,
                trim_start,
                trim_end,
                output_mp4,
                output_thumb,
                filters=job.get("filters") or [],
                workdir=workdir,
            )

            if callback_url:
                progress.post_resync_if_needed(
                    callback_url,
                    secret=callback_secret,
                )
                progress.post(
                    callback_url,
                    "uploading",
                    secret=callback_secret,
                )

            if job.get("localOutputDir"):
                copy_outputs_locally(job, output_mp4, output_thumb)
            else:
                upload_artifacts(
                    job,
                    output_mp4,
                    output_thumb,
                    secret=callback_secret,
                )

            if callback_url:
                progress.post_resync_if_needed(
                    callback_url,
                    secret=callback_secret,
                )
                # Terminal state is carried by the /run response; callbacks are
                # a best-effort fast-path for polling clients.
                progress.post(
                    callback_url,
                    "complete",
                    secret=callback_secret,
                )

            return run_result("complete", job)
        except Exception as exc:  # noqa: BLE001 - report encoder failures to caller
            message = str(exc) or "Encoding failed"
            if callback_url:
                progress.post(
                    callback_url,
                    "failed",
                    secret=callback_secret,
                    error_message=message,
                )
            return run_result("failed", job, error_message=message)


class EncoderHandler(BaseHTTPRequestHandler):
    server_version = "CarpoEncoder/0.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        log("%s - %s" % (self.address_string(), format % args))

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        parsed = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(parsed, dict):
            raise ValueError("JSON body must be an object")
        return parsed

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True})
            return
        self.send_error(404, "Not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/run":
            self.send_error(404, "Not found")
            return

        try:
            job = self._read_json()
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"status": "failed", "errorMessage": str(exc)})
            return

        result = process_job(job)
        status_code = 200 if result.get("status") == "complete" else 500
        self._send_json(status_code, result)


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), EncoderHandler)
    log(f"encoder listening on {HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
