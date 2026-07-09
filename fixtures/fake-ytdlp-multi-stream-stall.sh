#!/bin/sh
# Simulates bestvideo+bestaudio: video completes, audio starts, then stalls.
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
sleep 1
printf '[download] Destination: source.f140.m4a\n'
printf '[download]  10.0%% of ~1.00MiB at 1.00MiB/s ETA 00:09\n'
sleep 3600
