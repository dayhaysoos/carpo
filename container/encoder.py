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
STAGED_UPLOAD_PATH = "/tmp/carpo-upload-source.mp4"
STAGE_SOURCE_CHUNK_SIZE = 1024 * 1024
JOB_SECRET_HEADER = "X-Carpo-Job-Secret"
MAX_CALLBACK_ATTEMPTS = 5
MAX_INTERMEDIATE_CALLBACK_ATTEMPTS = 3
INITIAL_CALLBACK_BACKOFF_SECONDS = 0.5
DOWNLOAD_TIMEOUT_SECONDS = 600
YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS = 45
YOUTUBE_SOCKET_TIMEOUT_SECONDS = 15
ENCODE_TIMEOUT_SECONDS = 600
UPLOAD_TIMEOUT_SECONDS = 600
VIDEO_CONTAINER_EXTENSIONS = ("mp4", "mkv", "webm")
DEFERRED_OUTPUT_DIR = Path("/tmp/carpo-output")
GIF_OUTPUT_NAME = "clip.gif"
GIF_FPS = 12
GIF_MAX_WIDTH = 480
DEJAVU_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
KNOWN_FILTER_TYPES = frozenset({"caption"})
YOUTUBE_BLOCKED_MESSAGE = (
    "YouTube is blocking downloads from this server. "
    "Try uploading the video file instead."
)


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
        fetch_url = job.get("sourceFetchUrl")
        if not isinstance(fetch_url, str) or not fetch_url.strip():
            return "sourceFetchUrl is required for upload sources"
    else:
        return "source.type must be youtube, upload, or file"

    return None


def validate_gif_job(job: dict[str, Any]) -> str | None:
    source = job.get("source")
    if not isinstance(source, dict):
        return "source is required"

    source_type = source.get("type")
    if source_type != "file":
        return "GIF jobs require a local file source"
    path = source.get("path")
    if not isinstance(path, str) or not Path(path).exists():
        return "Local file path is required for GIF source"

    outputs = job.get("outputs")
    if not isinstance(outputs, dict) or not outputs.get("gifKey"):
        return "outputs.gifKey is required"

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


def classify_ytdlp_error(output: str) -> str:
    """Map yt-dlp stderr/stdout to a user-facing download error."""
    text = output.lower()

    blocked_markers = (
        "http error 403",
        "403: forbidden",
        "403 forbidden",
        "sign in to confirm you're not a bot",
        "confirm you are not a bot",
        "cookies are required",
        "this content isn't available",
        "http error 429",
    )
    if any(marker in text for marker in blocked_markers):
        return YOUTUBE_BLOCKED_MESSAGE

    if "private video" in text or "this is a private video" in text:
        return (
            "This YouTube video is private. "
            "Try uploading the video file instead."
        )

    if "members-only" in text or "join this channel" in text:
        return (
            "This YouTube video is members-only. "
            "Try uploading the video file instead."
        )

    if (
        "video unavailable" in text
        or "this video is unavailable" in text
        or "video has been removed" in text
    ):
        return (
            "This YouTube video is unavailable. "
            "It may have been deleted or restricted."
        )

    if (
        "geo restricted" in text
        or "not made this video available in your country" in text
        or "not available in your country" in text
    ):
        return "This YouTube video is not available in your region."

    if "unsupported url" in text or "no video formats" in text:
        return "The URL is not a supported YouTube link."

    if "invalid youtube url" in text or "url is not valid" in text:
        return "Enter a valid YouTube URL."

    trimmed = output.strip()
    if trimmed:
        first_line = trimmed.splitlines()[0]
        if len(first_line) > 240:
            first_line = first_line[:237] + "..."
        return f"Failed to download YouTube video: {first_line}"

    return "Failed to download YouTube video."


def run_ytdlp(command: list[str], workdir: Path) -> None:
    log(f"running: {' '.join(command)}")
    try:
        completed = subprocess.run(
            command,
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            "YouTube download timed out. "
            "Try uploading the video file instead.",
        ) from exc
    if completed.returncode != 0:
        output = "\n".join(
            part.strip()
            for part in (completed.stderr, completed.stdout)
            if part and part.strip()
        )
        raise RuntimeError(classify_ytdlp_error(output))


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


def download_upload(
    fetch_url: str,
    workdir: Path,
    *,
    secret: str | None = None,
) -> Path:
    headers: dict[str, str] = {}
    if secret:
        headers[JOB_SECRET_HEADER] = secret

    request = urllib.request.Request(fetch_url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            content_type = response.headers.get("Content-Type", "video/mp4")
            ext = "mp4"
            normalized = content_type.split(";")[0].strip().lower()
            if normalized == "video/webm":
                ext = "webm"
            elif normalized == "video/quicktime":
                ext = "mov"
            elif normalized == "video/x-matroska":
                ext = "mkv"

            destination = workdir / f"source.{ext}"
            with destination.open("wb") as handle:
                shutil.copyfileobj(response, handle)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Failed to fetch upload source ({exc.code}): {exc.reason}",
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to fetch upload source: {exc}") from exc

    if not destination.exists() or destination.stat().st_size == 0:
        raise RuntimeError("Upload source download produced an empty file")
    return destination


def download_youtube(url: str, workdir: Path) -> Path:
    output_template = str(workdir / "source.%(ext)s")
    run_ytdlp(
        [
            "yt-dlp",
            "--no-playlist",
            "--retries",
            "1",
            "--fragment-retries",
            "1",
            "--extractor-retries",
            "1",
            "--file-access-retries",
            "1",
            "--socket-timeout",
            str(YOUTUBE_SOCKET_TIMEOUT_SECONDS),
            "--merge-output-format",
            "mp4",
            "-f",
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "-o",
            output_template,
            url,
        ],
        workdir,
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
            parts.append(build_caption_drawtext(text, workdir, index))
            continue

        if filter_type not in KNOWN_FILTER_TYPES:
            raise RuntimeError(f"Unknown filter type: {filter_type!r}")

    return ",".join(parts) if parts else None


def build_caption_drawtext(text: str, workdir: Path, index: int) -> str:
    """Burn caption text with legible styling; textfile avoids drawtext escaping pitfalls."""
    text_path = workdir / f"caption-{index}.txt"
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


def encode_gif(source_mp4: Path, output_gif: Path, workdir: Path) -> None:
    """Palette-optimized two-pass GIF encode from a trimmed MP4."""
    palette_path = workdir / "palette.png"
    scale_filter = f"fps={GIF_FPS},scale={GIF_MAX_WIDTH}:-1:flags=lanczos"

    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_mp4),
            "-vf",
            f"{scale_filter},palettegen=stats_mode=diff",
            str(palette_path),
        ],
    )

    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_mp4),
            "-i",
            str(palette_path),
            "-lavfi",
            f"{scale_filter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5",
            "-loop",
            "0",
            str(output_gif),
        ],
    )


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


class TruncatedBodyError(ValueError):
    """Raised when fewer bytes were received than Content-Length declared."""


def stream_upload_source(rfile, length: int) -> None:
    path = Path(STAGED_UPLOAD_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)

    received = 0
    try:
        with path.open("wb") as handle:
            while received < length:
                to_read = min(STAGE_SOURCE_CHUNK_SIZE, length - received)
                chunk = rfile.read(to_read)
                if not chunk:
                    break
                handle.write(chunk)
                received += len(chunk)

        if received != length:
            raise TruncatedBodyError(
                f"Expected {length} bytes, received {received}",
            )
        if received == 0:
            raise RuntimeError("Staged upload source is empty")
    except Exception:
        path.unlink(missing_ok=True)
        raise


def run_result(
    status: str,
    job: dict[str, Any],
    *,
    error_message: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {"status": status}
    if error_message is not None:
        result["errorMessage"] = error_message
    if status in ("complete", "staged"):
        outputs = job.get("outputs", {})
        if job.get("jobType") == "gif":
            result["outputs"] = {
                "gifKey": outputs.get("gifKey", ""),
            }
        else:
            result["outputs"] = {
                "mp4Key": outputs.get("mp4Key", ""),
                "thumbnailKey": outputs.get("thumbnailKey", ""),
            }
    return result


def process_gif_job(job: dict[str, Any]) -> dict[str, Any]:
    try:
        error = validate_gif_job(job)
        if error:
            return run_result("failed", job, error_message=error)
    except Exception as exc:  # noqa: BLE001
        message = str(exc) or "GIF job validation failed"
        return run_result("failed", job, error_message=message)

    with tempfile.TemporaryDirectory(prefix="carpo-gif-") as tmp:
        workdir = Path(tmp)
        try:
            source = job["source"]
            source_path = Path(source["path"])
            output_gif = workdir / GIF_OUTPUT_NAME
            encode_gif(source_path, output_gif, workdir)

            defer_upload = bool(job.get("deferArtifactUpload"))
            local_output_dir = job.get("localOutputDir")
            if local_output_dir:
                out_dir = Path(local_output_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                outputs = job.get("outputs", {})
                shutil.copy2(
                    output_gif,
                    out_dir / Path(outputs.get("gifKey", GIF_OUTPUT_NAME)).name,
                )
            elif defer_upload:
                DEFERRED_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(output_gif, DEFERRED_OUTPUT_DIR / GIF_OUTPUT_NAME)
            else:
                raise RuntimeError("GIF artifact upload is not configured")

            if defer_upload:
                return run_result("staged", job)
            return run_result("complete", job)
        except Exception as exc:  # noqa: BLE001
            message = str(exc) or "GIF encoding failed"
            return run_result("failed", job, error_message=message)


def process_job(job: dict[str, Any]) -> dict[str, Any]:
    if job.get("jobType") == "gif":
        return process_gif_job(job)

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
                fetch_url = job.get("sourceFetchUrl")
                if not isinstance(fetch_url, str) or not fetch_url.strip():
                    raise RuntimeError("sourceFetchUrl is required for upload sources")
                source_path = download_upload(
                    fetch_url,
                    workdir,
                    secret=callback_secret,
                )
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

            defer_upload = bool(job.get("deferArtifactUpload"))

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
            elif defer_upload:
                DEFERRED_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(output_mp4, DEFERRED_OUTPUT_DIR / "clip.mp4")
                shutil.copy2(output_thumb, DEFERRED_OUTPUT_DIR / "thumbnail.jpg")
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
                if not defer_upload:
                    # Terminal state is carried by the /run response; callbacks are
                    # a best-effort fast-path for polling clients.
                    progress.post(
                        callback_url,
                        "complete",
                        secret=callback_secret,
                    )

            if defer_upload:
                return run_result("staged", job)
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
        if self.path == "/outputs/clip.mp4":
            return self._send_file(DEFERRED_OUTPUT_DIR / "clip.mp4", "video/mp4")
        if self.path == "/outputs/thumbnail.jpg":
            return self._send_file(
                DEFERRED_OUTPUT_DIR / "thumbnail.jpg",
                "image/jpeg",
            )
        if self.path == "/outputs/clip.gif":
            return self._send_file(DEFERRED_OUTPUT_DIR / GIF_OUTPUT_NAME, "image/gif")
        self.send_error(404, "Not found")

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self.send_error(404, "Not found")
            return
        file_size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.end_headers()
        with path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/stage-source":
            content_length = self.headers.get("Content-Length")
            if content_length is None or not content_length.strip():
                self.send_error(411, "Length Required")
                return
            try:
                length = int(content_length)
            except ValueError:
                self.send_error(411, "Length Required")
                return
            if length < 0:
                self.send_error(411, "Length Required")
                return
            try:
                stream_upload_source(self.rfile, length)
            except TruncatedBodyError:
                self.send_error(400, "Bad Request")
                return
            except Exception as exc:  # noqa: BLE001
                self._send_json(500, {"status": "failed", "errorMessage": str(exc)})
                return
            self.send_response(204)
            self.end_headers()
            return

        if self.path != "/run":
            self.send_error(404, "Not found")
            return

        try:
            job = self._read_json()
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"status": "failed", "errorMessage": str(exc)})
            return

        result = process_job(job)
        status_code = 200 if result.get("status") in ("complete", "staged") else 500
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
