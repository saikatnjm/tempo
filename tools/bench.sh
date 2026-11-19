#!/bin/sh
# Measure Tempo's cost in a clean room: a hidden, throwaway GNOME Shell with nothing else running,
# its own silent sound server, and generated music playing. Prints how much processor time the
# shell uses with Tempo's parts off, on, and at different music-bar frame rates.
#
#   tools/bench.sh [seconds per state]      default: 20
#
# Numbers from here are lower than on a real desktop (no screen is driven), so use them to
# compare states with each other. tools/measure.sh measures your actual desktop.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=$ROOT/build/bench
SECONDS_EACH=${1:-20}
mkdir -p "$OUT.tmp"
gjs "$ROOT/tools/make-sound.js" "$OUT.tmp/sound.wav" >/dev/null
"$ROOT/tools/build.sh" >/dev/null
TEMPO_PROBE_MODE=bench TEMPO_BENCH_SECONDS="$SECONDS_EACH" TEMPO_SMOKE_TIMEOUT=$((SECONDS_EACH * 8 + 130)) \
    TEMPO_SMOKE_SOUND="$OUT.tmp/sound.wav" "$ROOT/tests/smoke/run.sh" "$OUT" | grep -v '^ok '
rm -rf "$OUT.tmp"
