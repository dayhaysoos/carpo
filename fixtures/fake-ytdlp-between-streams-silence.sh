#!/bin/sh
# Simulates bestvideo completing then total silence before audio starts.
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

printf '[download] Destination: source.f399.mp4\n'
printf '[download]  50.0%% of ~5.00MiB at 1.00MiB/s ETA 00:05\n'
printf '[download] 100.0%% of ~5.00MiB at 1.00MiB/s ETA 00:00\n'
sleep 3600
