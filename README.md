# Carpo

Seize the moment. Carpo turns YouTube videos and uploaded files into looping MP4/WebM clips (with optional GIF export) — fast.

Successor to [gfycat-machine](https://github.com/ndejesus1227/gfycat-machine), rebuilt on Cloudflare now that Gfycat no longer exists.

## Architecture

- **Frontend:** Vite + React + TypeScript, served as static assets from a Cloudflare Worker
- **API:** Cloudflare Worker (create jobs, poll status, library, downloads)
- **Encoder:** Cloudflare Container running `yt-dlp` + `ffmpeg`, one instance per job
- **Storage:** R2 (retained source videos, transcripts, clips, and thumbnails), D1 (video and clip records)
- **Auth:** Cloudflare Access in front of the whole app

## Helper daemon

For reliable YouTube downloads from a residential IP, see [helper/README.md](helper/README.md).

## Reusable YouTube sources

The first server-side clip from a YouTube video imports a complete 1080p source
into R2. Later clips stage that retained source directly into the encoder and do
not contact YouTube again. The retained object is removed only when its video is
explicitly deleted.

## Transcript-aware clipping

Think can search a YouTube video's subtitles or automatic captions for an exact
spoken word or phrase. Carpo normalizes the caption cues once, retains the
transcript in R2, and turns matches into the same adjustable clip-review flow
used for manual timestamps. Exact searches are case-insensitive and token-based,
so `code` does not match `decode`.

This first slice uses captions supplied by YouTube. Uploaded videos and YouTube
videos without captions do not yet fall back to speech-to-text.

## Status

Planning. See the issue tracker for the PRD and build slices.
