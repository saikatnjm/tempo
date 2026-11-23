#!/bin/sh
# Measure what Tempo costs on this desktop, the same way the numbers in the README were made.
#
# It switches Tempo's parts off and on through its settings, and for each state reads how much
# processor time GNOME Shell (and the sound recorder) used. Your settings are put back at the end.
#
#   tools/measure.sh [seconds per reading] [rounds]      default: 30 seconds, 4 rounds
#
# For the music rows, have a media player playing for the whole run. The floating panels are
# switched on for their rows and put back as they were. Leave the mouse and
# keyboard alone while it runs, and close other busy apps if you can: anything that animates on
# screen adds noise to GNOME Shell's numbers. The summary uses medians to ride out that noise.
set -eu

SECONDS_EACH=${1:-30}
ROUNDS=${2:-4}
UUID=tempo@saikatnjm.github.io
SCHEMA=org.gnome.shell.extensions.tempo
DIR=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID
[ -d "$DIR/schemas" ] || { echo "Tempo is not installed for this user." >&2; exit 1; }
SHELL_PID=$(pgrep -u "$(id -u)" -x gnome-shell | head -n 1)
[ -n "$SHELL_PID" ] || { echo "GNOME Shell is not running." >&2; exit 1; }
TICKS=$(getconf CLK_TCK)

get() { gsettings --schemadir "$DIR/schemas" get $SCHEMA "$1"; }
put() { gsettings --schemadir "$DIR/schemas" set $SCHEMA "$1" "$2"; }
cpu_ticks() { awk '{print $14 + $15}' "/proc/$1/stat" 2>/dev/null || echo 0; }

KEYS="show-cpu show-memory show-temperature show-network music-visuals music-style float-stats float-viz"
saved=""
for key in $KEYS; do saved="$saved $key=$(get "$key")"; done
restore() { for pair in $saved; do put "${pair%%=*}" "${pair#*=}"; done; }
trap restore EXIT INT TERM

state() { # state <readings on/off> <music on/off> <bars|strip> <system panel on/off> <visualizer panel on/off>
    for key in show-cpu show-memory show-temperature show-network; do put "$key" "$1"; done
    put music-style "$3"
    put music-visuals "$2"
    put float-stats "$4"
    put float-viz "$5"
    sleep 4
}

# reading <label>: prints "shell%  recorder%  recorderMB" (percent of one core)
reading() {
    recorder=$(pgrep -u "$(id -u)" -x parec | head -n 1 || true)
    s0=$(cpu_ticks "$SHELL_PID"); r0=0
    [ -n "$recorder" ] && r0=$(cpu_ticks "$recorder")
    sleep "$SECONDS_EACH"
    s1=$(cpu_ticks "$SHELL_PID"); r1=0; rss=0
    if [ -n "$recorder" ] && [ -d "/proc/$recorder" ]; then
        r1=$(cpu_ticks "$recorder")
        rss=$(awk '/VmRSS/ {print $2}' "/proc/$recorder/status")
    fi
    awk -v s="$((s1 - s0))" -v r="$((r1 - r0))" -v t="$TICKS" -v n="$SECONDS_EACH" -v m="$rss" \
        'BEGIN { printf "%.2f %.2f %.1f\n", 100 * s / (t * n), 100 * r / (t * n), m / 1024 }'
}

echo "GNOME Shell $(gnome-shell --version | sed 's/[^0-9]*//'), $ROUNDS rounds of $SECONDS_EACH s per state."
echo "All figures are percent of ONE processor core."
echo
printf '%-7s %-26s %12s %12s %12s\n' round state "GNOME Shell" recorder "recorder MB"
results=$(mktemp)
round=1
while [ "$round" -le "$ROUNDS" ]; do
    for spec in "off:false:false:bars:false:false" "readings:true:false:bars:false:false" \
            "bars:true:true:bars:false:false" "line:true:true:strip:false:false" \
            "system-panel:true:false:bars:true:false" "visualizer:true:true:bars:false:true"; do
        old_ifs=$IFS; IFS=:
        # shellcheck disable=SC2086
        set -- $spec
        IFS=$old_ifs
        name=$1
        state "$2" "$3" "$4" "$5" "$6"
        set -- $(reading)
        printf '%-7s %-26s %11s%% %11s%% %12s\n' "$round" "$name" "$1" "$2" "$3"
        echo "$round $name $1 $2 $3" >> "$results"
    done
    round=$((round + 1))
done
echo
# Medians, and the median of each round's own differences, so one noisy reading cannot skew it.
awk '
    function median(values, count,    i, j, t) {
        for (i = 2; i <= count; i++)
            for (j = i; j > 1 && values[j - 1] > values[j]; j--) { t = values[j]; values[j] = values[j - 1]; values[j - 1] = t }
        return count % 2 ? values[(count + 1) / 2] : (values[count / 2] + values[count / 2 + 1]) / 2
    }
    { shell[$2, $1] = $3; recorder[$2, $1] = $4; if ($5 > memory) memory = $5; if ($1 > rounds) rounds = $1 }
    END {
        split("off readings bars line system-panel visualizer", order, " ")
        printf "%-26s %12s %12s\n", "median", "GNOME Shell", "recorder"
        for (i = 1; i <= 6; i++) {
            for (r = 1; r <= rounds; r++) { a[r] = shell[order[i], r]; b[r] = recorder[order[i], r] }
            printf "%-26s %11.2f%% %11.2f%%\n", order[i], median(a, rounds), median(b, rounds)
        }
        for (r = 1; r <= rounds; r++) {
            d1[r] = shell["readings", r] - shell["off", r]
            d2[r] = shell["bars", r] - shell["readings", r]
            d3[r] = shell["line", r] - shell["readings", r]
            d4[r] = shell["system-panel", r] - shell["off", r]
            d5[r] = shell["visualizer", r] - shell["readings", r]
            rec[r] = recorder["bars", r]
        }
        printf "\nReadings (rings, temperature, network) add %+.2f%% of one core.\n", median(d1, rounds)
        printf "The recorder uses %.2f%% and %.1f MB while music is shown, whatever the style.\n", median(rec, rounds), memory
        printf "In GNOME Shell: small bars add %+.2f%%, the level line %+.2f%%.\n", median(d2, rounds), median(d3, rounds)
        printf "Floating panels: the system panel adds %+.2f%% (its fan turns only while the real one does),\n", median(d4, rounds)
        printf "the visualizer panel %+.2f%%. A panel behind a window costs the same as one you can see.\n", median(d5, rounds)
    }' "$results"
rm -f "$results"
