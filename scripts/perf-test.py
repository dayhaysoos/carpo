#!/usr/bin/env python3
"""End-to-end performance probe for the Carpo clip pipeline.

Uploads a video once, creates several clips from it (mirroring the
rapid-clipping flow), times each phase, exports one GIF, and deletes
everything it created.

Usage:
    python3 scripts/perf-test.py <video-file> [base-url]

base-url defaults to http://localhost:8787 for local runs.
"""
import json
import sys
import time
import urllib.request

HEADERS = {"User-Agent": "carpo-perf-test/1.0"}
TRIMS = [(0, 4), (3, 8), (1, 9)]
POLL_TIMEOUT_SECONDS = 300


def api(base, method, path, body=None, raw=None, content_type="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body else None)
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={**HEADERS, "Content-Type": content_type},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = r.read()
        return json.loads(payload) if payload else None


def poll_clip(base, clip_id):
    start = time.monotonic()
    while time.monotonic() - start < POLL_TIMEOUT_SECONDS:
        clip = api(base, "GET", f"/api/clips/{clip_id}")
        if clip["status"] in ("complete", "failed"):
            return clip
        time.sleep(0.5)
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    file_path = sys.argv[1]
    base = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8787").rstrip("/")

    data = open(file_path, "rb").read()
    print(f"target: {base}")
    print(f"file: {len(data) / 1024 / 1024:.1f} MB")

    t0 = time.monotonic()
    slot = api(base, "POST", "/api/upload-url", {
        "contentType": "video/mp4", "sizeBytes": len(data), "filename": "perf.mp4",
    })
    upload_path = slot["uploadUrl"]
    if upload_path.startswith(base):
        upload_path = upload_path[len(base):]
    put = api(base, "PUT", upload_path, raw=data, content_type="video/mp4")
    print(f"upload: {time.monotonic() - t0:.1f}s")

    clip_ids = []
    completed_ids = []
    durations = []
    try:
        for i, (a, b) in enumerate(TRIMS, 1):
            t0 = time.monotonic()
            clip = api(base, "POST", "/api/clips", {
                "title": f"perf {i} ({a}-{b}s)",
                "source": {"type": "upload", "key": put["key"]},
                "trimStart": a, "trimEnd": b,
                "filters": [{"type": "caption", "text": "perf"}] if i == 3 else [],
            })
            clip_ids.append(clip["id"])
            final = poll_clip(base, clip["id"])
            total = time.monotonic() - t0
            status = final["status"] if final else "timeout"
            err = (final or {}).get("errorMessage")
            if status == "complete":
                completed_ids.append(clip["id"])
                durations.append(total)
            print(f"clip {i} [{a}-{b}s]{' +caption' if i == 3 else ''}: "
                  f"{total:.1f}s -> {status}{' ' + err if err else ''}")

        if completed_ids:
            cid = completed_ids[0]
            t0 = time.monotonic()
            api(base, "POST", f"/api/clips/{cid}/gif")
            while time.monotonic() - t0 < 180:
                c = api(base, "GET", f"/api/clips/{cid}")
                if c["gifStatus"] in ("complete", "failed"):
                    print(f"gif export: {time.monotonic() - t0:.1f}s -> {c['gifStatus']}")
                    break
                time.sleep(0.5)
    finally:
        for cid in clip_ids:
            try:
                req = urllib.request.Request(
                    f"{base}/api/clips/{cid}", method="DELETE", headers=HEADERS,
                )
                urllib.request.urlopen(req, timeout=30)
            except Exception as exc:
                print(f"cleanup failed for {cid[:8]}: {exc}", file=sys.stderr)
        print("cleaned up test clips")

    if durations:
        print(f"\nsummary: {len(durations)} clips complete, "
              f"fastest {min(durations):.1f}s, slowest {max(durations):.1f}s")


if __name__ == "__main__":
    main()
