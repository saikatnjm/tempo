#!/bin/sh
# Runs inside the private D-Bus session started by run.sh.
set -u
UUID=tempo@saikatnjm.github.io
PROBE=tempo-probe@saikatnjm.github.io

# GNOME Shell expects a system bus. Containers have none, so give it an empty private one.
SYSBUS=
if [ ! -S /run/dbus/system_bus_socket ] && [ -z "${DBUS_SYSTEM_BUS_ADDRESS:-}" ]; then
    address="unix:path=$XDG_RUNTIME_DIR/system-bus"
    if SYSBUS=$(dbus-daemon --session --address="$address" --fork --print-pid 2>/dev/null); then
        export DBUS_SYSTEM_BUS_ADDRESS="$address"
    fi
fi

# A private sound server playing a tone into a null sink: real data for the music bars,
# nothing audible, and the user's own sound setup is never touched.
PA=
export TEMPO_PROBE_AUDIO=0
if [ "${TEMPO_SMOKE_AUDIO:-1}" = 1 ] && command -v pulseaudio >/dev/null 2>&1 && command -v parec >/dev/null 2>&1; then
    # The test tone is a 440 Hz sine; TEMPO_SMOKE_SOUND=<file.wav> plays that file in a loop instead.
    if [ -n "${TEMPO_SMOKE_SOUND:-}" ]; then tone=; else tone="module-sine sink=tempo_test frequency=440"; fi
    pulseaudio -n --daemonize=no --exit-idle-time=-1 --log-target=stderr --log-level=error \
        -L "module-native-protocol-unix" \
        -L "module-null-sink sink_name=tempo_test" \
        ${tone:+-L "$tone"} > "$TEMPO_PROBE_OUT/pulseaudio.log" 2>&1 &
    PA=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -S "$XDG_RUNTIME_DIR/pulse/native" ] && break
        sleep 0.3
    done
    if [ -S "$XDG_RUNTIME_DIR/pulse/native" ]; then
        export TEMPO_PROBE_AUDIO=1
        if [ -n "${TEMPO_SMOKE_SOUND:-}" ]; then
            (while paplay --device=tempo_test "$TEMPO_SMOKE_SOUND"; do :; done) >/dev/null 2>&1 &
        fi
    fi
fi

gjs "$TEMPO_SMOKE_DIR/fake-player.js" &
PLAYER=$!

gsettings set org.gnome.shell enabled-extensions "['$UUID', '$PROBE']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '99.0'
gsettings set org.gnome.desktop.interface enable-animations false
if [ "${TEMPO_SMOKE_STYLE:-}" = docs ]; then
    # Plain dark surroundings for the pictures in the documentation.
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    gsettings set org.gnome.desktop.interface gtk-theme Yaru-dark 2>/dev/null || true
    gsettings set org.gnome.desktop.background picture-options none
    gsettings set org.gnome.desktop.background primary-color '#1c1c1e'
fi

# Newer GNOME versions dropped some of these options along with X11, so pass only what exists.
options="--headless --virtual-monitor 1280x720"
for option in --wayland --no-x11; do
    if gnome-shell --help-all 2>/dev/null | grep -q -- "$option "; then options="$options $option"; fi
done
# shellcheck disable=SC2086
timeout "${TEMPO_SMOKE_TIMEOUT:-180}" gnome-shell $options > "$TEMPO_PROBE_OUT/shell.log" 2>&1
echo "gnome-shell exit status: $?" >> "$TEMPO_PROBE_OUT/shell.log"

kill $PLAYER 2>/dev/null
[ -n "$PA" ] && kill "$PA" 2>/dev/null
[ -n "$SYSBUS" ] && kill "$SYSBUS" 2>/dev/null
wait 2>/dev/null
exit 0
