#!/bin/sh
# Unit tests for the parts of Tempo that need no desktop: parsing, formatting and the audio
# maths. Runs under plain gjs.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
{
    printf "const {GLib, Gio} = imports.gi;\n"
    # Files 55 to 65 define desktop widgets too; those are only defined here, never created, so
    # their pure helpers can be tested without a desktop.
    cat "$ROOT/src/core/10-util.js" "$ROOT/src/core/20-sampler.js" "$ROOT/src/core/30-spectrum.js" \
        "$ROOT/src/core/55-screen.js" "$ROOT/src/core/60-widgets.js" "$ROOT/src/core/65-float.js" \
        "$ROOT/tests/unit/tests.js"
} > "$tmp"
gjs "$tmp"
