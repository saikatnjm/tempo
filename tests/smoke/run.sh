#!/bin/sh
# End-to-end smoke test: loads the built extension in a throwaway headless GNOME Shell with its
# own home folder, D-Bus session and sound server, exercises every feature, and reports.
# Nothing on your desktop is touched and no window appears.
#
#   tests/smoke/run.sh [output-dir]        (default: build/smoke)
#
# TEMPO_SMOKE_EGO=1 tests the zip made for extensions.gnome.org instead (tools/build.sh ego),
# installed with GNOME's own tool, as it is on a user's computer.
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
if [ "${TEMPO_SMOKE_EGO:-}" = 1 ]; then
    if [ "$variant" = esm ]; then range=gnome45-plus; else range=gnome42-44; fi
    egozip=$ROOT/dist/ego/tempo-$(cat "$ROOT/VERSION")-ego-$range.shell-extension.zip
    [ -f "$egozip" ] || "$ROOT/tools/build.sh" ego >/dev/null || exit 1
else
    [ -d "$ROOT/build/$variant/$UUID" ] || "$ROOT/tools/build.sh" >/dev/null || exit 1
fi

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
if [ "${TEMPO_SMOKE_EGO:-}" = 1 ]; then
    # From GNOME 44 on, installing compiles the settings schema, which the zip for GNOME 45 and
    # later therefore leaves out: only a real install shows that it still finds its settings.
    gnome-extensions install --force "$egozip" || { echo "FAIL  could not install $egozip"; exit 1; }
    tested="$variant build, as packed for extensions.gnome.org"
else
    cp -r "$ROOT/build/$variant/$UUID" "$extensions/"
    tested="$variant build"
fi
cat "$ROOT/tests/smoke/probe/$variant-header.js" "$ROOT/tests/smoke/probe/probe-core.js" \
    "$ROOT/tests/smoke/probe/$variant-footer.js" > "$extensions/$PROBE/extension.js"
printf '{"uuid": "%s", "name": "Tempo test probe", "description": "Test helper", "shell-version": ["%s"]}\n' \
    "$PROBE" "$major" > "$extensions/$PROBE/metadata.json"

export TEMPO_PROBE_OUT="$OUT"
export TEMPO_SMOKE_DIR="$ROOT/tests/smoke"
echo "Smoke test: GNOME Shell $(gnome-shell --version | sed 's/[^0-9]*//'), $tested"
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

# Using a widget after it was destroyed ("has been already disposed"): what a destroy() that
# forgets a timer or a signal leads to. The stock shell logs none of these in this test, up to
# its own shutdown.
gone="has been already (disposed|deallocated|finalized)"
if sed '/Shutting down GNOME Shell/q' "$OUT/shell.log" 2>/dev/null | grep -qE "$gone"; then
    echo "FAIL  a destroyed widget was used ($(sed '/Shutting down GNOME Shell/q' "$OUT/shell.log" | grep -cE "$gone") times):"
    sed '/Shutting down GNOME Shell/q' "$OUT/shell.log" | grep -A8 -E "$gone" | sed -E 's/0x[0-9a-f]+//g' | head -24
    status=1
else
    echo "ok    no destroyed widget was used"
fi

# The same while GNOME Shell shuts down. It does not disable extensions then: it destroys
# everything on screen, and from GNOME 48 on keeps its main loop going for a moment after that,
# in which a timer or a recorder of Tempo's that was not stopped still fires (Tempo stops them
# when its button is destroyed; the test ends with music playing to show it). Here only entries
# with Tempo in their stack trace count: what else the shell logs on its way out is its own.
if sed -n '/Shutting down GNOME Shell/,$p' "$OUT/shell.log" 2>/dev/null | grep -A8 -E "$gone" | grep -q "$UUID"; then
    echo "FAIL  Tempo used a destroyed widget while GNOME Shell was shutting down:"
    sed -n '/Shutting down GNOME Shell/,$p' "$OUT/shell.log" | grep -A8 -E "$gone" | sed -E 's/0x[0-9a-f]+//g' | head -24
    status=1
else
    echo "ok    none was used while GNOME Shell shut down either"
fi

# A call with the wrong number of arguments, which GJS only warns about and which does not name
# the extension. The stock shell logs none in this test. (One way to get there: null for the
# callback of an asynchronous call that GNOME Shell has turned into a promise-style one.)
counted="Too (many|few) arguments to (method|function)"
if grep -qE "$counted" "$OUT/shell.log" 2>/dev/null; then
    echo "FAIL  calls with the wrong number of arguments ($(grep -cE "$counted" "$OUT/shell.log") lines):"
    grep -E "$counted" "$OUT/shell.log" | sed -E 's/^.*JS WARNING: //' | sort | uniq -c | sort -rn | head -8
    status=1
else
    echo "ok    no call with the wrong number of arguments"
fi
echo "Screenshots and logs: $OUT"
exit $status
