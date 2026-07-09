#!/bin/sh
# Fake yt-dlp that honors --download-sections and simulates keyframe snap.
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

if [ -z "$SECTIONS" ]; then
  echo "ERROR: --download-sections is required for this contract fixture" >&2
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

SECTION_START=$(printf '%s' "$SECTIONS" | sed 's/^\*//' | cut -d- -f1)
KEYFRAME_SNAP=$(awk -v start="$SECTION_START" 'BEGIN {
  snap = start - 2
  if (snap < 0) snap = 0
  printf "%.3f", snap
}')

ffmpeg -y -loglevel error -ss "$KEYFRAME_SNAP" -i /fixture/framecounter.mp4 -c copy -copyts "$OUTFILE"
