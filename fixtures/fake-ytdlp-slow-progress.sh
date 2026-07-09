#!/bin/sh
# Simulates a slow but active yt-dlp download that should not be stall-killed.
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

percent=0
while [ "$percent" -lt 100 ]; do
  printf '[download] %s%% of ~10.00MiB at 1.00MiB/s ETA 00:10\n' "$percent"
  percent=$((percent + 25))
  sleep 2
done

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
