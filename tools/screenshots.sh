#!/bin/sh
# Remake the pictures in docs/assets/ from a real (headless, throwaway) GNOME Shell running the
# current build, with generated music so the bars have something to dance to.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=$ROOT/build/screens
mkdir -p "$OUT.tmp" "$ROOT/docs/assets"
gjs "$ROOT/tools/make-sound.js" "$OUT.tmp/sound.wav"
"$ROOT/tools/build.sh" >/dev/null
TEMPO_SMOKE_STYLE=docs TEMPO_SMOKE_SOUND="$OUT.tmp/sound.wav" "$ROOT/tests/smoke/run.sh" "$OUT" | tail -3
gjs "$ROOT/tools/crop-screenshots.js" "$OUT" "$ROOT/docs/assets"
rm -rf "$OUT.tmp"
