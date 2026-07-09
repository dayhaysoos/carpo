#!/bin/sh
# Simulates yt-dlp writing 403 diagnostics to stdout only (no stderr).
cat <<'EOF'
[youtube] Extracting URL: https://www.youtube.com/watch?v=dQw4w9WgXcQ
[youtube] dQw4w9WgXcQ: Downloading webpage
[download] Got error: HTTP Error 403: Forbidden
ERROR: unable to download video data: HTTP Error 403: Forbidden
EOF
exit 1
