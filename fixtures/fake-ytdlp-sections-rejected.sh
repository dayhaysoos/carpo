#!/bin/sh
# Fake yt-dlp where a section download has known alignment (start_time > 0)
# but the keyframe snap lands after trimEnd, so encode bounds are rejected.
# Full-video fallback (no --download-sections) copies the complete fixture.
OUTPUT=""
SECTIONS=""
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
    *)
      shift
      ;;
  esac
done

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
  # Keyframe snap late enough that probed start_time exceeds trimEnd (9.5).
  KEYFRAME_SNAP=$(awk -v start="$SECTION_START" 'BEGIN {
    snap = start + 5.5
    printf "%.3f", snap
  }')
  ffmpeg -y -loglevel error -ss "$KEYFRAME_SNAP" -i /fixture/framecounter.mp4 -c copy -copyts "$OUTFILE"
else
  cp /fixture/framecounter.mp4 "$OUTFILE"
fi
