# Carpo encoder container

Debian slim image with **yt-dlp**, **Deno** (external JS runtime for YouTube EJS challenges), and **ffmpeg**.

## YouTube maintenance ritual

When YouTube breaks extraction (new player JS, `nsig extraction failed`, throttled downloads ~50kB/s, or widespread `video unavailable` errors):

1. **Check upstream** — read the [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) and [EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Deno remains the recommended runtime; pip installs need the `[default]` extra for `yt-dlp-ejs`.
2. **Bump pins in `Dockerfile`** — update `YTDLP_VERSION` (and `DENO_VERSION` / `DENO_SHA256` if Deno minimum rises).
3. **Rebuild and test locally** — `npm run test:encoder` (fake-yt-dlp fixtures + real-binary smoke).
4. **Deploy** — `npx wrangler deploy` and wait ~2 minutes for the container image rollout.
5. **Live smoke** — clip a short known-good video (e.g. `jNQXAC9IVRw` 1–4s) and confirm container logs show `yt-dlp env: [debug] JS runtimes: deno-…` plus sane download speeds.

Datacenter IP reputation issues are separate from extractor breakage; fast classified failures (`YouTube is blocking…`) are expected for some videos and are not fixed by bumping yt-dlp alone.
