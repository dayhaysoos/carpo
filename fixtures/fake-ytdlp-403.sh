#!/bin/sh
# Simulates yt-dlp failing with Cloudflare-datacenter 403 blocking (no network).
cat <<'EOF' >&2
[youtube] Extracting URL: https://www.youtube.com/watch?v=dQw4w9WgXcQ
[youtube] dQw4w9WgXcQ: Downloading webpage
[youtube] dQw4w9WgXcQ: Downloading ios player API JSON
[youtube] dQw4w9WgXcQ: Downloading m3u8 information
[info] dQw4w9WgXcQ: Downloading 1 format(s): 398+140
[download] Got error: HTTP Error 403: Forbidden
ERROR: fragment 1 not found, unable to continue
ERROR: unable to download video data: HTTP Error 403: Forbidden
EOF
exit 1
