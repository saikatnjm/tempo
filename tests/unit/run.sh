#!/bin/sh
# Unit tests for the parts of Tempo that need no desktop: parsing, formatting and the audio
# maths. Runs under plain gjs.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
{
    printf "const {GLib, Gio} = imports.gi;\n"
    cat "$ROOT/src/core/10-util.js" "$ROOT/src/core/20-sampler.js" "$ROOT/src/core/30-spectrum.js" \
        "$ROOT/tests/unit/tests.js"
} > "$tmp"
gjs "$tmp"
