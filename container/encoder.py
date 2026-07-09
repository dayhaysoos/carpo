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
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_CLIP_LENGTH_SECONDS = 60
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))


def log(message: str) -> None:
    print(message, flush=True)


def post_status(callback_url: str, status: str, error_message: str | None = None) -> None:
    payload: dict[str, Any] = {"status": status}
    if error_message is not None:
        payload["errorMessage"] = error_message

    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        callback_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except urllib.error.URLError as exc:
        log(f"status callback failed ({status}): {exc}")


def validate_job(job: dict[str, Any]) -> str | None:
    trim_start = job.get("trimStart")
    trim_end = job.get("trimEnd")
    max_len = job.get("maxClipLengthSeconds", MAX_CLIP_LENGTH_SECONDS)

    if not isinstance(trim_start, (int, float)) or not isinstance(trim_end, (int, float)):
        return "trimStart and trimEnd must be numbers"

    duration = float(trim_end) - float(trim_start)
    if duration <= 0:
        return "trimEnd must be greater than trimStart"
    if duration > float(max_len):
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
        key = source.get("key")
        if not isinstance(key, str) or not key.strip():
            return "Upload key is required"
    else:
        return "source.type must be youtube, upload, or file"

    return None


def run_command(command: list[str], cwd: Path | None = None) -> None:
    log(f"running: {' '.join(command)}")
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(stderr or f"command failed: {' '.join(command)}")


def download_youtube(url: str, workdir: Path) -> Path:
    output_template = str(workdir / "source.%(ext)s")
    run_command(
        [
            "yt-dlp",
            "--no-playlist",
            "-f",
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "-o",
            output_template,
            url,
        ],
        cwd=workdir,
    )

    candidates = sorted(workdir.glob("source.*"))
    if not candidates:
        raise RuntimeError("yt-dlp did not produce a source file")
    return candidates[0]


def encode_clip(source: Path, trim_start: float, trim_end: float, output_mp4: Path, output_thumb: Path) -> None:
    duration = trim_end - trim_start
    run_command(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(trim_start),
            "-i",
            str(source),
            "-t",
            str(duration),
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
        ]
    )

    run_command(
        [
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
            str(output_thumb),
        ]
    )


def upload_file(upload_url: str, local_path: Path, content_type: str) -> None:
    with local_path.open("rb") as handle:
        data = handle.read()
    request = urllib.request.Request(
        upload_url,
        data=data,
        headers={"Content-Type": content_type},
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        response.read()


def upload_artifacts(job: dict[str, Any], mp4_path: Path, thumb_path: Path) -> None:
    upload_urls = job.get("artifactUploadUrls", {})
    mp4_url = upload_urls.get("mp4")
    thumb_url = upload_urls.get("thumbnail")
    if mp4_url and thumb_url:
        upload_file(mp4_url, mp4_path, "video/mp4")
        upload_file(thumb_url, thumb_path, "image/jpeg")
        return

    r2 = job.get("r2", {})
    if all(
        [
            r2.get("endpoint"),
            r2.get("bucket"),
            r2.get("accessKeyId"),
            r2.get("secretAccessKey"),
        ]
    ):
        outputs = job.get("outputs", {})
        upload_to_r2(job, mp4_path, outputs.get("mp4Key", "clip.mp4"))
        upload_to_r2(job, thumb_path, outputs.get("thumbnailKey", "thumbnail.jpg"))
        return

    raise RuntimeError("No artifact upload destination configured")


def upload_to_r2(job: dict[str, Any], local_path: Path, object_key: str) -> None:
    r2 = job.get("r2", {})
    endpoint = r2.get("endpoint")
    bucket = r2.get("bucket")
    access_key = r2.get("accessKeyId")
    secret_key = r2.get("secretAccessKey")

    if not all([endpoint, bucket, access_key, secret_key]):
        raise RuntimeError("R2 credentials are not configured")

    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )
    client.upload_file(str(local_path), bucket, object_key)


def copy_outputs_locally(job: dict[str, Any], mp4_path: Path, thumb_path: Path) -> None:
    outputs = job.get("outputs", {})
    output_dir = job.get("localOutputDir")
    if not output_dir:
        return

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(mp4_path, out_dir / Path(outputs.get("mp4Key", "clip.mp4")).name)
    shutil.copy2(thumb_path, out_dir / Path(outputs.get("thumbnailKey", "thumbnail.jpg")).name)


def process_job(job: dict[str, Any]) -> dict[str, Any]:
    error = validate_job(job)
    if error:
        return {"status": "failed", "errorMessage": error}

    callback_url = job.get("callbackUrl")
    trim_start = float(job["trimStart"])
    trim_end = float(job["trimEnd"])
    outputs = job.get("outputs", {})
    mp4_key = outputs.get("mp4Key", "clip.mp4")
    thumb_key = outputs.get("thumbnailKey", "thumbnail.jpg")

    with tempfile.TemporaryDirectory(prefix="carpo-encode-") as tmp:
        workdir = Path(tmp)
        source_path: Path | None = None

        try:
            if callback_url:
                post_status(callback_url, "downloading")

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
                post_status(callback_url, "encoding")

            output_mp4 = workdir / "clip.mp4"
            output_thumb = workdir / "thumbnail.jpg"
            encode_clip(source_path, trim_start, trim_end, output_mp4, output_thumb)

            if callback_url:
                post_status(callback_url, "uploading")

            if job.get("localOutputDir"):
                copy_outputs_locally(job, output_mp4, output_thumb)
            else:
                upload_artifacts(job, output_mp4, output_thumb)

            return {"status": "complete"}
        except Exception as exc:  # noqa: BLE001 - report encoder failures to caller
            message = str(exc) or "Encoding failed"
            if callback_url:
                post_status(callback_url, "failed", message)
            return {"status": "failed", "errorMessage": message}


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
