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

## Authentication and private libraries

Production is protected by a hostname-level Cloudflare Access application with
Google as its identity provider. The Worker resolves the verified Access
identity to an internal Carpo user and scopes every user-facing video, clip,
upload, artifact, transcript, and video-agent entry point to that user. An
unknown or unauthenticated production request fails closed; knowing another
record's UUID is not sufficient to read it.

Production requires `AUTH_MODE=cloudflare-access`, the HTTPS
`ACCESS_TEAM_DOMAIN`, and the Access application's `ACCESS_AUD`. The isolated
PR-review and test environments explicitly use `AUTH_MODE=legacy` so their
deterministic flows remain independent of an external identity provider. Local
development may opt into that same mode through an ignored `.dev.vars` file.
Missing or unrecognized auth modes fail closed; never deploy a public or
production environment with `AUTH_MODE=legacy`.

The helper daemon crosses Access with a dedicated service token and continues
to require Carpo's own `HELPER_TOKEN`. Encoder callbacks use only the narrow
`/api/internal/jobs/*` path and remain protected by their per-job secret. Do not
configure a broad Access bypass for either client.

### Public share path

Revocable Clip links use `/share/*` as their only anonymous entry point. In
production, configure a separate, more-specific Cloudflare Access application
for `carpo.ndejesus1227.workers.dev/share/*` with a Bypass policy for Everyone;
keep the existing hostname-level Access application on every other path. Never
bypass `/artifacts/*`: the share handler validates the opaque link, expiry, and
revocation before streaming the single allowed object from R2.

Access does not log requests covered by a Bypass policy. Carpo therefore treats
each share URL as a bearer secret, stores only its SHA-256 hash, sends
`Cache-Control: private, no-store`, and exposes owner-visible revocation. Apply
the D1 migrations before enabling the public path.

## Reusable remote Video sources

Adding a YouTube Video starts a best-effort import of one complete 1080p source
into the owner's private R2 library before Clip creation. Once ready, preview,
transcript work, and every later Clip use that Retained Video Source without
contacting YouTube again. Provider failures remain distinguishable and always
offer owned upload as the reliable recovery path. The retained object is removed
only when its Video is explicitly deleted.

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

## Sampled visual moment search

For an uploaded video, Carpo can check up to eight evenly spaced private frames
for a user-described logo, object, or layout. Results include representative
frames, confidence and uncertainty, the exact source revision, and an editable
proposed range. This is a narrow tracer rather than exhaustive full-video
vision: appearances between sampled frames can be missed. Replacing the source
invalidates its cached observations, and deleting the video removes the private
frame evidence.

The manual workspace, Think, and WebMCP all call the same owner-scoped visual
discovery module. None of them can turn a model observation directly into a
Clip; the existing Clip Proposal Review remains the only path to timestamp
correction, rejection, or explicit creation.

## Optional intelligence and WebMCP

Carpo's manual UI, built-in Think assistant, and external WebMCP agents are
clients of the same application capabilities. Think is an optional first-party
client and has no privileged domain access. Every meaningful Think capability
must also be available manually and through WebMCP, while Carpo continues to own
validation, authorization, human review, and recoverable manual correction. See
[ADR 0002](docs/adr/0002-keep-capabilities-independent-from-intelligence-provider.md)
and the [WebMCP capability contract](docs/webmcp-capability-contract.md).

The WebMCP surface exposes typed browser tools that explain Carpo's authority
boundary, read revision-bound evidence, and prepare transcript- or sampled-
frame-grounded drafts in the existing editable Clip Proposal Review. The tools
cannot approve, create, encode, publish, or share clips; browsers without WebMCP
continue to use the normal manual and Think interfaces.

## Caption outputs

The current editor can burn one static text overlay into an entire Clip. Carpo's
caption contract extends this with one editable Timed Caption Track that can
produce both themed social-video captions permanently rendered into the picture
and toggleable WebVTT/SubRip closed-caption artifacts for browser and publishing
workflows such as YouTube. Manual, Think, and WebMCP clients must all be able to
generate, correct, configure, preview, and export the applicable caption forms.

## Status

Planning. See the issue tracker for the PRD and build slices.
