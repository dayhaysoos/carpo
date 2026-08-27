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

Carpo can search YouTube and uploaded videos for an exact spoken word or phrase.
Carpo uses YouTube subtitles when available, falls back to speech-to-text over
the retained source, normalizes the timestamped cues once, and retains the
transcript in R2. Exact searches are case-insensitive and token-based, so `code`
does not match `decode`.

The editor exposes that same grounded transcript for searching, seeking, and
selecting a trim range. An agent can also find meaning-based moments such as an
argument or explanation. Semantic results must reference real transcript block
IDs; Carpo derives the proposed timestamps from those blocks before sending them
through the same adjustable clip-review flow used for manual timestamps.

## Optional intelligence and WebMCP

Carpo's manual UI, built-in Think assistant, and external WebMCP agents are
clients of the same application capabilities. Think is an optional first-party
client and has no privileged domain access. Every meaningful Think capability
must also be available manually and through WebMCP, while Carpo continues to own
validation, authorization, human review, and recoverable manual correction. See
[ADR 0002](docs/adr/0002-keep-capabilities-independent-from-intelligence-provider.md)
and the [WebMCP capability contract](docs/webmcp-capability-contract.md).

## Caption outputs

The current editor can burn one static text overlay into an entire Clip. Carpo's
caption contract extends this with one editable Timed Caption Track that can
produce both themed social-video captions permanently rendered into the picture
and toggleable WebVTT/SubRip closed-caption artifacts for browser and publishing
workflows such as YouTube. Manual, Think, and WebMCP clients must all be able to
generate, correct, configure, preview, and export the applicable caption forms.

## Status

Planning. See the issue tracker for the PRD and build slices.
