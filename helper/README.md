# Carpo Helper

Local daemon that runs on your Mac and helps Carpo download YouTube sections over your residential IP (with your browser cookies) when datacenter downloads fail.

## Prerequisites

- Python 3.10+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp` — also installs ffmpeg)
- A running Carpo server with `HELPER_TOKEN` configured

## Install

From the repo root:

```bash
bash helper/install.sh
```

The installer creates `~/.config/carpo-helper/config.json`, installs a launchd agent (`com.carpo.helper`), and starts it at login.

## Config

Default path: `~/.config/carpo-helper/config.json` (override with `--config` or `CARPO_HELPER_CONFIG`).

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `baseUrl` | yes | — | Carpo server URL (no trailing slash) |
| `helperToken` | yes | — | Must match server `HELPER_TOKEN` |
| `cookiesFromBrowser` | no | `"chrome"` | Passed to `yt-dlp --cookies-from-browser`; empty/null disables |
| `pollIntervalSeconds` | no | `5` | Seconds between claim polls when idle |
| `ytDlpPath` | no | `"yt-dlp"` | Path to yt-dlp binary |
| `ffprobePath` | no | `"ffprobe"` | Path to ffprobe (used to verify section alignment) |
| `cfAccessClientId` | no | — | Cloudflare Access service token ID |
| `cfAccessClientSecret` | no | — | Cloudflare Access service token secret |

Both CF Access fields must be set together; when present, they are sent on every API request.

## How it works

1. **Claim** — `POST /api/helper/claim` picks the oldest pending YouTube job.
2. **Download** — yt-dlp fetches a padded section (`trimStart−3` … `trimEnd+3`) with `--force-keyframes-at-cuts` using your browser cookies.
3. **Upload** — requests a presigned URL, `PUT`s the file to R2.
4. **Fulfill** — `POST /api/helper/jobs/{id}/fulfill` with `uploadKey` and `sectionStart`; the server encodes the clip from the uploaded source.

Claims expire after 5 minutes. On any failure after claim, the daemon calls `/fail` so the server immediately falls back to the container encoder.

## Manual run

```bash
python3 helper/carpo_helper.py --config ~/.config/carpo-helper/config.json
python3 helper/carpo_helper.py --once          # process at most one job
python3 helper/carpo_helper.py --once --dry-run # download only, then fail with "dry run"
```

## Logs

```bash
tail -f ~/Library/Logs/carpo-helper.log
```

## Troubleshooting

- **Keychain prompt on first run** — macOS asks for Chrome cookie access when yt-dlp reads browser cookies. Allow it once.
- **Helper offline** — the server waits briefly, then falls back to datacenter YouTube download automatically.
- **Upload too large** — padded sections over ~200MB are rejected; the job fails and the server uses the container path.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.carpo.helper 2>/dev/null || launchctl unload -w ~/Library/LaunchAgents/com.carpo.helper.plist
rm ~/Library/LaunchAgents/com.carpo.helper.plist
```

Config and logs are left in place.
