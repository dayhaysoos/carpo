# Carpo

Seize the moment. Carpo turns YouTube videos and uploaded files into looping MP4/WebM clips (with optional GIF export) — fast.

Successor to [gfycat-machine](https://github.com/ndejesus1227/gfycat-machine), rebuilt on Cloudflare now that Gfycat no longer exists.

## Architecture

- **Frontend:** Vite + React + TypeScript, served as static assets from a Cloudflare Worker
- **API:** Cloudflare Worker (create jobs, poll status, library, downloads)
- **Encoder:** Cloudflare Container running `yt-dlp` + `ffmpeg`, one instance per job
- **Storage:** R2 (clips + thumbnails), D1 (clip records)
- **Auth:** Cloudflare Access in front of the whole app

## Status

Planning. See the issue tracker for the PRD and build slices.
