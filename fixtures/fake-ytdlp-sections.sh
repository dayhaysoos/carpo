#!/bin/sh
# Fake yt-dlp that honors --download-sections and copies the frame-counter fixture.
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

cp /fixture/framecounter.mp4 "$OUTFILE"
