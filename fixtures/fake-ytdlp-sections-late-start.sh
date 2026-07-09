#!/bin/sh
# Fake yt-dlp for rebased-timestamp section downloads (start_time=0) and
# force-keyframes fallback with exact section cuts.
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

echo "[download] 100.0% of fixture segment"
if [ -n "$SECTIONS" ]; then
  echo "[Merger] Merging formats into mp4"
fi

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
  SECTION_RANGE=$(printf '%s' "$SECTIONS" | sed 's/^\*//')
  SECTION_START=$(printf '%s' "$SECTION_RANGE" | cut -d- -f1)
  SECTION_END=$(printf '%s' "$SECTION_RANGE" | cut -d- -f2)
  SECTION_DURATION=$(awk -v start="$SECTION_START" -v end="$SECTION_END" 'BEGIN {
    printf "%.3f", end - start
  }')

  if [ "$FORCE_KEYFRAMES" -eq 1 ]; then
    ffmpeg -y -loglevel error \
      -ss "$SECTION_START" \
      -i /fixture/framecounter.mp4 \
      -t "$SECTION_DURATION" \
      -c copy \
      "$OUTFILE"
  else
    ffmpeg -y -loglevel error \
      -ss "$SECTION_START" \
      -i /fixture/framecounter.mp4 \
      -t "$SECTION_DURATION" \
      -c copy \
      "$OUTFILE"
  fi
else
  echo "ERROR: --download-sections is required for this contract fixture" >&2
  exit 1
fi
