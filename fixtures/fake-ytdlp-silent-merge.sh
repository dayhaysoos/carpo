#!/bin/sh
# Simulates yt-dlp finishing download then going silent during ffmpeg merge.
OUTPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      OUTPUT="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

printf '[download] 100.0%% of ~10.00MiB at 1.00MiB/s ETA 00:00\n'
sleep 12

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
