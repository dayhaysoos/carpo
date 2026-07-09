#!/bin/sh
# Fake yt-dlp where attempt 1 misaligns (late keyframe snap) and attempt 2
# (--force-keyframes-at-cuts) fails with a classified HTTP 403.
OUTPUT=""
SECTIONS=""
FORCE_KEYFRAMES=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      OUTPUT="$2"
      shift 2
      ;;
    --download-sections)
      SECTIONS="$2"
      shift 2
      ;;
    --force-keyframes-at-cuts)
      FORCE_KEYFRAMES=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$FORCE_KEYFRAMES" -eq 1 ]; then
  cat <<'EOF' >&2
[youtube] Extracting URL: https://www.youtube.com/watch?v=section-fallback-403
[youtube] section-fallback-403: Downloading webpage
[download] Got error: HTTP Error 403: Forbidden
ERROR: unable to download video data: HTTP Error 403: Forbidden
EOF
  exit 1
fi

echo "[download] 100.0% of fixture segment"

OUTFILE=$(printf '%s' "$OUTPUT" | sed 's/%(ext)s/mp4/')
if [ -z "$OUTFILE" ]; then
  echo "missing -o output template" >&2
  exit 1
fi

if [ ! -f /fixture/framecounter.mp4 ]; then
  echo "fixture video missing at /fixture/framecounter.mp4" >&2
  exit 1
fi

if [ -n "$SECTIONS" ]; then
  SECTION_START=$(printf '%s' "$SECTIONS" | sed 's/^\*//' | cut -d- -f1)
  KEYFRAME_SNAP=$(awk -v start="$SECTION_START" 'BEGIN {
    snap = start + 4.0
    printf "%.3f", snap
  }')
  ffmpeg -y -loglevel error -ss "$KEYFRAME_SNAP" -i /fixture/framecounter.mp4 -c copy -copyts "$OUTFILE"
else
  echo "ERROR: --download-sections is required for this contract fixture" >&2
  exit 1
fi
