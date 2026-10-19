#!/usr/bin/env bash
# Renders a scenes file to <name>-vertical.mp4 and <name>-16x9.mp4, with soundtrack.
#   ./make.sh swarm /path/to/outdir
# Both aspects render in parallel; expect about 15 minutes for a minute of video.
set -euo pipefail
name="${1:?scenes name, e.g. swarm}"
out="${2:-.}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

node "$here/render.mjs" "$name" v info "$work/info.json"
python3 "$here/audio.py" "$work/info.json" "$work/audio.wav" &
node "$here/render.mjs" "$name" v video "$work/v.mp4" > "$work/v.log" 2>&1 &
node "$here/render.mjs" "$name" h video "$work/h.mp4" > "$work/h.log" 2>&1 &
wait
grep -q DONE "$work/v.log" && grep -q DONE "$work/h.log" || { cat "$work/v.log" "$work/h.log"; exit 1; }

for pair in "v:vertical" "h:16x9"; do
  ffmpeg -y -loglevel error -i "$work/${pair%%:*}.mp4" -i "$work/audio.wav" \
    -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out/$name-${pair##*:}.mp4"
done
ls -la "$out/$name-vertical.mp4" "$out/$name-16x9.mp4"
