# Carpo encoder container

Debian slim image with **yt-dlp**, **Deno** (external JS runtime for YouTube EJS and BotGuard challenges), the pinned **BgUtils PO-token provider**, and **ffmpeg**.

## YouTube PO-token mode

The image defaults `YOUTUBE_PO_TOKEN_MODE=bgutil`. Every YouTube download:

1. Selects yt-dlp's `mweb` player client.
2. Invokes the pinned BgUtils script provider through Deno.
3. Supplies the generated token to yt-dlp's Google Video Server request.

Set `YOUTUBE_PO_TOKEN_MODE=off` to restore yt-dlp's default client selection for an A/B comparison. PO tokens improve client attestation but do not guarantee that YouTube will accept Cloudflare's egress IP.

The same yt-dlp/PO-token path retrieves YouTube subtitle or automatic-caption
tracks for transcript-aware clipping. Caption tracks are normalized into timed
cues by the container and retained as JSON in R2 by the Worker.

## YouTube maintenance ritual

When YouTube breaks extraction (new player JS, `nsig extraction failed`, throttled downloads ~50kB/s, or widespread `video unavailable` errors):

1. **Check upstream** — read the [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) and [EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Deno remains the recommended runtime; pip installs need the `[default]` extra for `yt-dlp-ejs`.
2. **Bump pins in `Dockerfile`** — update `YTDLP_VERSION`, `BGUTIL_PROVIDER_VERSION` + its source archive SHA-256, and `DENO_VERSION` / `DENO_SHA256` when their minimums rise.
3. **Rebuild and test locally** — `npm run test:encoder` (fake-yt-dlp fixtures + real-binary smoke).
4. **Deploy** — `npx wrangler deploy` and wait ~2 minutes for the container image rollout.
5. **Live smoke** — clip a short known-good video (e.g. `jNQXAC9IVRw` 1–4s) and confirm container logs show Deno, the BgUtils plugin, `youtube:player_client=mweb`, and sane download speeds.

Datacenter IP reputation issues are separate from extractor breakage; fast classified failures (`YouTube is blocking…`) are expected for some videos and are not fixed by bumping yt-dlp alone.
