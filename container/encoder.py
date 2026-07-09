#!/usr/bin/env python3
"""Carpo encoder container HTTP server."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
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
YOUTUBE_SOCKET_TIMEOUT_SECONDS = 15
YOUTUBE_STALL_TIMEOUT_SECONDS = int(
    os.environ.get("YOUTUBE_STALL_TIMEOUT_SECONDS", "45"),
)
YOUTUBE_POST_100_GRACE_TIMEOUT_SECONDS = int(
    os.environ.get("YOUTUBE_POST_100_GRACE_TIMEOUT_SECONDS", "90"),
)
YOUTUBE_DOWNLOAD_MAX_SECONDS = int(
    os.environ.get("YOUTUBE_DOWNLOAD_MAX_SECONDS", "600"),
)
YOUTUBE_STDERR_MAX_LINES = 200
YOUTUBE_SECTION_PADDING_SECONDS = 3
YOUTUBE_SECTION_START_DRIFT_TOLERANCE_SECONDS = 0.25
YOUTUBE_USE_DOWNLOAD_SECTIONS = True
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
YOUTUBE_STALL_MESSAGE = (
    "YouTube appears to be blocking/stalling downloads from this server. "
    "Try uploading the video file instead."
)
VALID_QUALITIES = frozenset({"720p", "1080p"})
DEFAULT_QUALITY = "1080p"
QUALITY_MAX_HEIGHT = {"720p": 720, "1080p": 1080}
YOUTUBE_SECTION_EXACT_FALLBACK_MESSAGE = (
    "Section-only download failed after retry with exact cuts. "
    "Try a wider trim range or upload the video file instead."
)
YOUTUBE_DOWNLOAD_TIMEOUT_MESSAGE = (
    "YouTube download timed out. "
    "Try uploading the video file instead."
)
YOUTUBE_FORCE_KEYFRAMES_FFMPEG_PRESET = "veryfast"
ENCODE_DURATION_TOLERANCE_SECONDS = 0.5
# Probe rounding slack only; anything meaningfully shorter must re-encode.
STREAM_COPY_SHORT_SOURCE_EPSILON_SECONDS = 0.05


def resolve_quality(value: Any) -> str:
    if value is None:
        return DEFAULT_QUALITY
    if isinstance(value, str) and value in VALID_QUALITIES:
        return value
    return DEFAULT_QUALITY


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


def output_scale_filter(max_height: int) -> str:
    return f"scale=-2:'min(ih\\,{max_height})'"
ENCODE_FAILURE_MESSAGE = (
    "Encoding failed for this video format. "
    "Try a shorter clip or upload the file instead."
)


def log(message: str) -> None:
    print(message, flush=True)


def log_ytdlp_environment() -> None:
    """Log yt-dlp version, EJS package, and detected JS runtime at job start."""
    try:
        version = subprocess.run(
            ["yt-dlp", "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if version.stdout.strip():
            log(f"yt-dlp env: version {version.stdout.strip()}")
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"yt-dlp env: failed to probe version ({exc})")
        return

    try:
        verbose = subprocess.run(
            ["yt-dlp", "-v"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"yt-dlp env: failed to probe runtime ({exc})")
        return

    combined_output = "\n".join(
        (verbose.stderr or "").splitlines() + (verbose.stdout or "").splitlines()
    )
    for line in combined_output.splitlines():
        if "JS runtimes:" in line or "yt_dlp_ejs" in line:
            log(f"yt-dlp env: {line.strip()}")


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

    quality = job.get("quality")
    if quality is not None and (
        not isinstance(quality, str) or quality not in VALID_QUALITIES
    ):
        return "quality must be '720p' or '1080p'"

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


def classify_encode_error(_output: str, *, timed_out: bool = False) -> str:
    """Map ffmpeg stderr/stdout to a user-facing encode error."""
    del timed_out  # reserved for future timeout-specific copy
    return ENCODE_FAILURE_MESSAGE


def run_command(
    command: list[str],
    cwd: Path | None = None,
    *,
    timeout_seconds: int = ENCODE_TIMEOUT_SECONDS,
    friendly_failure: bool = False,
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
        if friendly_failure:
            log(f"encode command timed out after {timeout_seconds}s: {cmd}")
            raise RuntimeError(
                classify_encode_error("", timed_out=True),
            ) from exc
        raise RuntimeError(
            f"Command timed out after {timeout_seconds}s: {cmd}",
        ) from exc
    if completed.returncode != 0:
        stderr = completed.stderr.strip() or completed.stdout.strip()
        if friendly_failure:
            log(f"encode command failed: {' '.join(command)}")
            if stderr:
                log(f"ffmpeg stderr:\n{stderr}")
            raise RuntimeError(classify_encode_error(stderr))
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


def _is_user_facing_ytdlp_error(message: str) -> bool:
    """Return True when run_ytdlp already mapped stderr to a user-facing error."""
    if message in (
        YOUTUBE_BLOCKED_MESSAGE,
        YOUTUBE_STALL_MESSAGE,
        YOUTUBE_DOWNLOAD_TIMEOUT_MESSAGE,
    ):
        return True
    if message.startswith("This YouTube video is"):
        return True
    if message.startswith("The URL is not a supported YouTube link."):
        return True
    if message.startswith("Enter a valid YouTube URL."):
        return True
    if message.startswith("Failed to download YouTube video"):
        return True
    return False


def _append_capped_line(lines: list[str], line: str, max_lines: int) -> None:
    lines.append(line)
    overflow = len(lines) - max_lines
    if overflow > 0:
        del lines[:overflow]


def _ytdlp_command_with_newline(command: list[str]) -> list[str]:
    if "--newline" in command:
        return command
    return [command[0], "--newline", *command[1:]]


_YTDLP_POSTPROCESS_MARKERS = (
    "[Merger]",
    "[ExtractAudio]",
    "[FixupM3u8]",
    "[ffmpeg]",
)


def _ytdlp_line_indicates_postprocess(line: str) -> bool:
    text = line.strip()
    if not text:
        return False
    return any(marker in text for marker in _YTDLP_POSTPROCESS_MARKERS)


def _ytdlp_line_is_download_destination(line: str) -> bool:
    text = line.strip()
    return "[download]" in text and "Destination:" in text


def _ytdlp_line_download_percent(line: str) -> float | None:
    text = line.strip()
    if "[download]" not in text:
        return None
    match = re.search(r"\b(\d+(?:\.\d+)?)%", text)
    if not match:
        return None
    return float(match.group(1))


def _ytdlp_download_line_enables_stall_detection(line: str) -> bool:
    if _ytdlp_line_is_download_destination(line):
        return True
    percent = _ytdlp_line_download_percent(line)
    return percent is not None and percent < 100


def _ytdlp_download_line_disables_stall_detection(line: str) -> bool:
    percent = _ytdlp_line_download_percent(line)
    return percent is not None and percent >= 100


def _combined_ytdlp_output(
    stderr_lines: list[str],
    stdout_lines: list[str],
) -> str:
    return "\n".join([*stderr_lines, *stdout_lines])


def _classify_stall_error(
    stderr_lines: list[str],
    stdout_lines: list[str],
) -> str:
    combined_text = _combined_ytdlp_output(stderr_lines, stdout_lines)
    if not combined_text.strip():
        return YOUTUBE_STALL_MESSAGE
    classified = classify_ytdlp_error(combined_text)
    if classified == "Failed to download YouTube video." or classified.startswith(
        "Failed to download YouTube video:",
    ):
        return YOUTUBE_STALL_MESSAGE
    return classified


def _signal_process_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        return
    except PermissionError:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return


def _kill_process_group(pid: int) -> None:
    """Terminate a yt-dlp process group, including ffmpeg merge children."""
    _signal_process_group(pid, signal.SIGTERM)

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            return
        time.sleep(0.1)

    _signal_process_group(pid, signal.SIGKILL)


def _wait_for_process_after_kill(proc: subprocess.Popen[Any]) -> None:
    """Wait for a killed yt-dlp process; retry SIGKILL if it does not exit."""
    try:
        proc.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        log(
            f"WARNING: yt-dlp process {proc.pid} did not exit within 10s "
            "after kill; retrying SIGKILL",
        )

    if proc.poll() is None and proc.pid is not None:
        _signal_process_group(proc.pid, signal.SIGKILL)

    try:
        proc.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        log(
            f"CRITICAL: yt-dlp process {proc.pid} is unkillable after SIGKILL",
        )
        raise RuntimeError(
            "YouTube download process could not be terminated. "
            "Try uploading the video file instead.",
        )


def probe_media_stream_value(path: Path, field: str) -> float | int | None:
    """Return a numeric ffprobe stream/format field when present."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                field,
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    raw = result.stdout.strip()
    if not raw:
        return None
    try:
        if "." in raw:
            return float(raw)
        return int(raw)
    except ValueError:
        return None


def probe_media_start_time(path: Path) -> float | None:
    """Return container start_time from ffprobe when present."""
    value = probe_media_stream_value(path, "format=start_time")
    return float(value) if isinstance(value, (float, int)) else None


def probe_media_duration(path: Path) -> float | None:
    """Return container duration from ffprobe when present."""
    value = probe_media_stream_value(path, "format=duration")
    return float(value) if isinstance(value, (float, int)) else None


def probe_media_height(path: Path) -> int | None:
    """Return the primary video stream height from ffprobe when present."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=height",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    raw = result.stdout.strip()
    if not raw:
        return None
    try:
        height = int(float(raw))
    except ValueError:
        return None
    return height if height > 0 else None


def resolve_section_encode_bounds(
    source_path: Path,
    trim_start: float,
    trim_end: float,
    section_start: float,
) -> tuple[float, float]:
    """Map requested trim bounds to offsets within a section download."""
    if not YOUTUBE_USE_DOWNLOAD_SECTIONS:
        return trim_start, trim_end

    probed_start = probe_media_start_time(source_path)
    if probed_start is not None and probed_start > 0:
        if (
            probed_start
            > trim_start + YOUTUBE_SECTION_START_DRIFT_TOLERANCE_SECONDS
        ):
            raise RuntimeError(
                "Downloaded section does not contain the requested trim range. "
                "Try a wider trim range or upload the video file instead.",
            )
        base = probed_start
    else:
        base = section_start

    encode_trim_start = max(0.0, trim_start - base)
    encode_trim_end = trim_end - base
    if encode_trim_end <= encode_trim_start:
        raise RuntimeError(
            "Downloaded section does not contain the requested trim range. "
            "Try a wider trim range or upload the video file instead.",
        )

    return encode_trim_start, encode_trim_end


def section_exact_encode_bounds(
    trim_start: float,
    trim_end: float,
    section_start: float,
) -> tuple[float, float]:
    """Map trim bounds using exact section-start math (force-keyframes path)."""
    encode_trim_start = max(0.0, trim_start - section_start)
    encode_trim_end = trim_end - section_start
    if encode_trim_end <= encode_trim_start:
        raise RuntimeError(
            "Downloaded section does not contain the requested trim range. "
            "Try a wider trim range or upload the video file instead.",
        )
    return encode_trim_start, encode_trim_end


def run_ytdlp(command: list[str], workdir: Path) -> None:
    command = _ytdlp_command_with_newline(command)
    log(f"running: {' '.join(command)}")

    proc = subprocess.Popen(
        command,
        cwd=str(workdir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    activity_lock = threading.Lock()
    last_activity = time.monotonic()
    started = time.monotonic()
    stall_detection_enabled = True
    post_process_latched = False

    def mark_activity() -> None:
        nonlocal last_activity
        with activity_lock:
            last_activity = time.monotonic()

    def note_ytdlp_line(line: str) -> None:
        nonlocal stall_detection_enabled, post_process_latched
        if _ytdlp_line_indicates_postprocess(line):
            with activity_lock:
                post_process_latched = True
                stall_detection_enabled = False
            return
        if _ytdlp_download_line_enables_stall_detection(line):
            with activity_lock:
                stall_detection_enabled = True
            return
        if _ytdlp_download_line_disables_stall_detection(line):
            with activity_lock:
                stall_detection_enabled = False

    def read_stream(stream: Any, *, is_stderr: bool) -> None:
        if stream is None:
            return
        for line in stream:
            if is_stderr:
                _append_capped_line(
                    stderr_lines,
                    line.rstrip("\n"),
                    YOUTUBE_STDERR_MAX_LINES,
                )
            else:
                _append_capped_line(
                    stdout_lines,
                    line.rstrip("\n"),
                    YOUTUBE_STDERR_MAX_LINES,
                )
            note_ytdlp_line(line)
            if line.strip():
                mark_activity()

    stdout_thread = threading.Thread(
        target=read_stream,
        args=(proc.stdout,),
        kwargs={"is_stderr": False},
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=read_stream,
        args=(proc.stderr,),
        kwargs={"is_stderr": True},
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()

    stall_killed = False
    overall_timeout = False

    while proc.poll() is None:
        now = time.monotonic()
        with activity_lock:
            idle_seconds = now - last_activity
            stall_enabled = stall_detection_enabled
            latched = post_process_latched
        if not latched:
            idle_limit = (
                YOUTUBE_STALL_TIMEOUT_SECONDS
                if stall_enabled
                else YOUTUBE_POST_100_GRACE_TIMEOUT_SECONDS
            )
            if idle_seconds > idle_limit:
                stall_killed = True
                _kill_process_group(proc.pid)
                break
        if now - started > YOUTUBE_DOWNLOAD_MAX_SECONDS:
            overall_timeout = True
            _kill_process_group(proc.pid)
            break
        time.sleep(0.25)

    if stall_killed or overall_timeout:
        _wait_for_process_after_kill(proc)
    else:
        proc.wait()
    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)

    if stall_killed:
        raise RuntimeError(_classify_stall_error(stderr_lines, stdout_lines))
    if overall_timeout:
        raise RuntimeError(YOUTUBE_DOWNLOAD_TIMEOUT_MESSAGE)
    if proc.returncode != 0:
        raise RuntimeError(
            classify_ytdlp_error(_combined_ytdlp_output(stderr_lines, stdout_lines)),
        )


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


def youtube_section_bounds(
    trim_start: float,
    trim_end: float,
    *,
    exact: bool = False,
) -> tuple[float, float]:
    if exact:
        return trim_start, trim_end
    section_start = max(0.0, trim_start - YOUTUBE_SECTION_PADDING_SECONDS)
    section_end = trim_end + YOUTUBE_SECTION_PADDING_SECONDS
    return section_start, section_end


def _ytdlp_download_command(
    url: str,
    output_template: str,
    *,
    trim_start: float,
    trim_end: float,
    use_sections: bool,
    force_keyframes: bool = False,
    quality: str = DEFAULT_QUALITY,
) -> tuple[list[str], float]:
    section_start = 0.0
    format_sort, format_selector = ytdlp_format_for_quality(quality)
    command = [
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
        "--concurrent-fragments",
        "8",
        "--socket-timeout",
        str(YOUTUBE_SOCKET_TIMEOUT_SECONDS),
        "--merge-output-format",
        "mp4",
        "-S",
        format_sort,
        "-f",
        format_selector,
    ]
    if use_sections:
        section_start, section_end = youtube_section_bounds(
            trim_start,
            trim_end,
            exact=force_keyframes,
        )
        command.extend(
            [
                "--download-sections",
                f"*{section_start}-{section_end}",
            ],
        )
        if force_keyframes:
            command.extend(
                [
                    "--force-keyframes-at-cuts",
                    "--ppa",
                    f"ffmpeg:-preset {YOUTUBE_FORCE_KEYFRAMES_FFMPEG_PRESET}",
                ],
            )
    command.extend(
        [
            "-o",
            output_template,
            url,
        ],
    )
    return command, section_start


def _resolve_ytdlp_source_path(workdir: Path) -> Path:
    merged = workdir / "source.mp4"
    if merged.exists():
        return merged

    candidates = list(workdir.glob("source.*"))
    if not candidates:
        raise RuntimeError("yt-dlp did not produce a source file")
    return select_source_file(candidates)


def _clear_ytdlp_source_files(workdir: Path) -> None:
    for stale in workdir.glob("source.*"):
        stale.unlink(missing_ok=True)


def download_youtube(
    url: str,
    workdir: Path,
    *,
    trim_start: float,
    trim_end: float,
    quality: str = DEFAULT_QUALITY,
) -> tuple[Path, float, float]:
    """Download a YouTube source and return encode trim bounds relative to the file."""
    if not YOUTUBE_USE_DOWNLOAD_SECTIONS:
        raise RuntimeError(
            "YouTube section downloads are required; full-video download is disabled",
        )

    output_template = str(workdir / "source.%(ext)s")
    section_command, section_start = _ytdlp_download_command(
        url,
        output_template,
        trim_start=trim_start,
        trim_end=trim_end,
        use_sections=True,
        quality=quality,
    )
    attempt1_started = time.monotonic()
    run_ytdlp(section_command, workdir)
    log(
        "phase timing: section download attempt 1: "
        f"{time.monotonic() - attempt1_started:.1f}s",
    )
    source_path = _resolve_ytdlp_source_path(workdir)

    probed_start = probe_media_start_time(source_path)
    if probed_start is not None and probed_start > 0:
        try:
            encode_trim_start, encode_trim_end = resolve_section_encode_bounds(
                source_path,
                trim_start,
                trim_end,
                section_start,
            )
            return source_path, encode_trim_start, encode_trim_end
        except RuntimeError as exc:
            if "does not contain the requested trim range" not in str(exc):
                raise
            log(
                "YouTube section download does not contain the requested "
                f"trim range (start_time={probed_start}); "
                "re-downloading section with force-keyframes-at-cuts",
            )
    else:
        if probed_start is None:
            alignment_detail = "unavailable"
        else:
            alignment_detail = f"{probed_start}"
        log(
            "YouTube section download has unknown alignment "
            f"(start_time={alignment_detail}); "
            "re-downloading section with force-keyframes-at-cuts",
        )

    _clear_ytdlp_source_files(workdir)
    exact_command, section_start = _ytdlp_download_command(
        url,
        output_template,
        trim_start=trim_start,
        trim_end=trim_end,
        use_sections=True,
        force_keyframes=True,
        quality=quality,
    )
    try:
        fallback_started = time.monotonic()
        run_ytdlp(exact_command, workdir)
        log(
            "phase timing: section download force-keyframes fallback: "
            f"{time.monotonic() - fallback_started:.1f}s",
        )
    except RuntimeError as exc:
        message = str(exc)
        if _is_user_facing_ytdlp_error(message):
            raise
        raise RuntimeError(YOUTUBE_SECTION_EXACT_FALLBACK_MESSAGE) from exc

    source_path = _resolve_ytdlp_source_path(workdir)
    encode_trim_start, encode_trim_end = section_exact_encode_bounds(
        trim_start,
        trim_end,
        section_start,
    )
    return source_path, encode_trim_start, encode_trim_end


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


def _can_stream_copy_encode(
    source: Path,
    trim_start: float,
    trim_end: float,
    *,
    caption_filters: str | None,
    max_output_height: int,
) -> bool:
    if caption_filters:
        return False
    if trim_start != 0:
        return False
    source_height = probe_media_height(source)
    if source_height is None or source_height > max_output_height:
        return False
    source_duration = probe_media_duration(source)
    if source_duration is None:
        return False
    expected_duration = trim_end - trim_start
    # Longer sources are safe: the -c copy invocation caps output with -t.
    # Shorter sources would silently truncate the clip, so force a re-encode
    # path there, which surfaces the mismatch instead of hiding it.
    if source_duration < expected_duration - STREAM_COPY_SHORT_SOURCE_EPSILON_SECONDS:
        return False
    return (
        source_duration - expected_duration
        <= ENCODE_DURATION_TOLERANCE_SECONDS
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
    max_output_height: int = 1080,
) -> None:
    duration = trim_end - trim_start
    filter_workdir = workdir or source.parent
    caption_filters = build_video_filter_chain(filters or [], filter_workdir)
    scale_filter = output_scale_filter(max_output_height)
    video_filters = (
        f"{scale_filter},{caption_filters}"
        if caption_filters
        else scale_filter
    )
    stream_copy = _can_stream_copy_encode(
        source,
        trim_start,
        trim_end,
        caption_filters=caption_filters,
        max_output_height=max_output_height,
    )

    if stream_copy:
        log("encode: stream-copy (no re-encode needed)")
        encode_command = [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-t",
            str(duration),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output_mp4),
        ]
    else:
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
    run_command(encode_command, friendly_failure=True)

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
    if not stream_copy and video_filters:
        thumb_command.extend(["-vf", video_filters])
    elif not stream_copy:
        thumb_command.extend(["-vf", scale_filter])
    thumb_command.append(str(output_thumb))
    # Same input-seek pattern; thumbnail spot-check included in contract test.
    run_command(thumb_command, friendly_failure=True)


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
        quality = resolve_quality(job.get("quality"))
        max_output_height = QUALITY_MAX_HEIGHT[quality]
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

            encode_trim_start = trim_start
            encode_trim_end = trim_end
            if source_type == "youtube":
                log_ytdlp_environment()
                download_started = time.monotonic()
                source_path, encode_trim_start, encode_trim_end = download_youtube(
                    source["url"],
                    workdir,
                    trim_start=trim_start,
                    trim_end=trim_end,
                    quality=quality,
                )
                log(
                    "phase timing: download total: "
                    f"{time.monotonic() - download_started:.1f}s",
                )
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
            encode_started = time.monotonic()
            encode_clip(
                source_path,
                encode_trim_start,
                encode_trim_end,
                output_mp4,
                output_thumb,
                filters=job.get("filters") or [],
                workdir=workdir,
                max_output_height=max_output_height,
            )
            log(
                "phase timing: encode: "
                f"{time.monotonic() - encode_started:.1f}s",
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
