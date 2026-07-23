#!/bin/sh
# Fake yt-dlp for retained-source contracts. It requires a full download and
# writes the complete mounted fixture to the requested output template.
OUTPUT=""
SAW_REMUX=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      OUTPUT="$2"
      shift 2
      ;;
    --remux-video)
      [ "$2" = "mp4" ] || exit 1
      SAW_REMUX=1
      shift 2
      ;;
    --download-sections)
      echo "ERROR: retained source must not use --download-sections" >&2
      exit 1
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$SAW_REMUX" -ne 1 ]; then
  echo "ERROR: retained source must be remuxed to mp4" >&2
  exit 1
fi

OUTFILE=$(printf '%s' "$OUTPUT" | sed 's/%(ext)s/mp4/')
if [ -z "$OUTFILE" ] || [ ! -f /fixture/framecounter.mp4 ]; then
  echo "ERROR: output template or fixture is missing" >&2
  exit 1
fi

echo "[download] 100.0% of full fixture"
cp /fixture/framecounter.mp4 "$OUTFILE"
