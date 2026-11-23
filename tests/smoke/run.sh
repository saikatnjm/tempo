#!/bin/sh
# End-to-end smoke test: loads the built extension in a throwaway headless GNOME Shell with its
# own home folder, D-Bus session and sound server, exercises every feature, and reports.
# Nothing on your desktop is touched and no window appears.
#
#   tests/smoke/run.sh [output-dir]        (default: build/smoke)
#
# Needs: gnome-shell 42+, gjs, dbus-run-session. With pulseaudio + parec present the music bars
# are tested with real captured sound; otherwise that part is skipped.
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
UUID=tempo@saikatnjm.github.io
PROBE=tempo-probe@saikatnjm.github.io
OUT=${1:-$ROOT/build/smoke}

major=$(gnome-shell --version | sed 's/[^0-9]*\([0-9][0-9]*\).*/\1/')
if [ "$major" -ge 45 ]; then variant=esm; else variant=legacy; fi
[ -d "$ROOT/build/$variant/$UUID" ] || "$ROOT/tools/build.sh" >/dev/null || exit 1

mkdir -p "$OUT"
rm -rf "${OUT:?}"/* 2>/dev/null || true
OUT=$(CDPATH= cd -- "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export HOME="$WORK/home"
export XDG_RUNTIME_DIR="$WORK/run"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME WAYLAND_DISPLAY DISPLAY \
    PULSE_SERVER DBUS_SESSION_BUS_ADDRESS XDG_SESSION_ID XDG_SEAT 2>/dev/null
extensions="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$extensions/$PROBE" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
cp -r "$ROOT/build/$variant/$UUID" "$extensions/"
cat "$ROOT/tests/smoke/probe/$variant-header.js" "$ROOT/tests/smoke/probe/probe-core.js" \
    "$ROOT/tests/smoke/probe/$variant-footer.js" > "$extensions/$PROBE/extension.js"
printf '{"uuid": "%s", "name": "Tempo test probe", "description": "Test helper", "shell-version": ["%s"]}\n' \
    "$PROBE" "$major" > "$extensions/$PROBE/metadata.json"

export TEMPO_PROBE_OUT="$OUT"
export TEMPO_SMOKE_DIR="$ROOT/tests/smoke"
echo "Smoke test: GNOME Shell $(gnome-shell --version | sed 's/[^0-9]*//'), $variant build"
dbus-run-session -- sh "$ROOT/tests/smoke/session.sh" > "$OUT/session.log" 2>&1

status=0
if [ ! -f "$OUT/report.json" ]; then
    echo "FAIL  no report: the shell or the probe did not get far enough"
    grep -iE "tempo|JS ERROR|error" "$OUT/shell.log" 2>/dev/null | head -20
    exit 1
fi
LC_ALL=C.UTF-8 gjs "$ROOT/tests/smoke/summary.js" "$OUT/report.json" || status=1

# Any error Tempo logs (its messages start with "Tempo: "), and any JavaScript error or warning
# that names it, fails the test even if every check passed.
if grep -nE "Tempo: |(JS ERROR|JS WARNING|CRITICAL|had error).*tempo@saikatnjm" "$OUT/shell.log" "$OUT/session.log" \
        > "$OUT/errors.txt" 2>/dev/null; then
    echo "FAIL  errors mentioning Tempo in the shell log:"
    head -20 "$OUT/errors.txt"
    status=1
elif grep -B2 -A12 -E "JS ERROR" "$OUT/shell.log" 2>/dev/null | grep -q "$UUID"; then
    echo "FAIL  a JavaScript error has Tempo in its stack trace:"
    grep -B2 -A12 -E "JS ERROR" "$OUT/shell.log" | grep -B6 -A6 "$UUID" | head -30
    status=1
else
    echo "ok    no Tempo errors in the shell log"
fi

# Two warnings GNOME Shell logs when widgets are handled carelessly: placing them by hand in the
# middle of a layout pass, and asking a widget that is not on screen yet for its style. The stock
# shell logs neither in this test, so every one of them comes from Tempo's widgets.
careless="Can't update stage views|st_widget_get_theme_node called on the widget"
if grep -qE "$careless" "$OUT/shell.log" 2>/dev/null; then
    echo "FAIL  layout or style warnings in the shell log ($(grep -cE "$careless" "$OUT/shell.log") lines):"
    grep -E "$careless" "$OUT/shell.log" | sed -E 's/^.*\*\*: [0-9:.]+: //; s/0x[0-9a-f]+//g' | sort | uniq -c | sort -rn | head -8
    status=1
else
    echo "ok    no layout or style warnings in the shell log"
fi
echo "Screenshots and logs: $OUT"
exit $status
