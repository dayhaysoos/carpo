#!/bin/sh
# Simulates yt-dlp emitting 403 stderr then hanging (stall-kill with classified error).
cat <<'EOF' >&2
[youtube] Extracting URL: https://www.youtube.com/watch?v=dQw4w9WgXcQ
[youtube] dQw4w9WgXcQ: Downloading webpage
[download] Got error: HTTP Error 403: Forbidden
ERROR: unable to download video data: HTTP Error 403: Forbidden
EOF
sleep 3600
