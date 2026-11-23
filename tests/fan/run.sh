#!/bin/bash
# Tests for fan/tempo-fan against a fake /sys/class/hwmon: a Dell-style laptop fan (speed steps,
# no enable switch), a desktop board with two fans (auto/manual switches), an AMD graphics card
# with its own temperature, a fan hub with a speed but no switch, a fan that refuses to be
# driven, a read-only fan, and a bogus "acpitz" sensor listed before the real one. No hardware
# is touched.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d); PID=; PID2=
trap 'kill $PID $PID2 2>/dev/null; rm -rf "$W"' EXIT
H=$W/hwmon; mkdir -p "$H"/hwmon{0,1,2,3,4,5,9}
put() { printf '%s\n' "$2" > "$1"; }
# hwmon0 is first in line, and is the sensor many desktop boards have stuck at 27.8 °C. The
# processor's real sensor (hwmon9) must win, or every check below fails.
put $H/hwmon0/name acpitz;      put $H/hwmon0/temp1_input 27800
CPU=$H/hwmon9/temp1_input
put $H/hwmon9/name k10temp;     put $CPU 50000
put $H/hwmon1/name dell_smm;    put $H/hwmon1/pwm1 255; put $H/hwmon1/fan1_input 0
put $H/hwmon2/name nct6798;     put $H/hwmon2/pwm1 120; put $H/hwmon2/pwm1_enable 5; put $H/hwmon2/pwm2 90; put $H/hwmon2/pwm2_enable 2; put $H/hwmon2/temp1_input 40000
put $H/hwmon3/name amdgpu;      put $H/hwmon3/pwm1 60;  put $H/hwmon3/pwm1_enable 2; put $H/hwmon3/temp1_input 50000
# A ThinkPad without fan_control=1: the fan is there, but refuses every write to its switch.
put $H/hwmon4/name thinkpad;    put $H/hwmon4/fan1_input 2000; put $H/hwmon4/pwm1 200; put $H/hwmon4/pwm1_enable 2; chmod 444 $H/hwmon4/pwm1_enable
# A fan hub: a speed, no switch, and nothing that takes over when it is left alone.
put $H/hwmon5/name corsaircpro; put $H/hwmon5/pwm1 100
put $W/mode cool
export TEMPO_FAN_HWMON=$H TEMPO_FAN_MODE=$W/mode TEMPO_FAN_STATE=$W/run TEMPO_FAN_INTERVAL=0.1
F=$ROOT/fan/tempo-fan

pass=0 fail=0
v() { local x=; read -r x < "$1"; printf '%s' "$x"; }
check() { # check <name> <file> <expected>
    local got; got=$(v "$2")
    if [ "$got" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL  $1: got $got, expected $3"; fi
}
ok() { # ok <name> <command...>
    local name=$1; shift
    if "$@"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL  $name"; fi
}
settle() { sleep 0.5; }
listed() { "$F" list | grep -q "$1"; }

ok "list: the laptop fan, with its speed steps" listed "dell_smm pwm1: speed steps"
ok "list: the fan hub, never stopped" listed "corsaircpro pwm1: speed only"
ok "list: fans follow the processor's own sensor, not acpitz" listed "nct6798 pwm1: .*hwmon9/temp1_input"
ok "list: the graphics card's fan follows the card" listed "amdgpu pwm1: .*hwmon3/temp1_input"
if [ "$(id -u)" -ne 0 ]; then        # root may write anywhere, so the refusal cannot be staged
    ok "list: a fan that refuses control is left out" listed "skipping thinkpad pwm1: it refuses"
    [ "$("$F" list | grep -c ": .*follows")" = 5 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL list count: $("$F" list)"; }
fi
check "listing changes nothing: desktop fan switch" $H/hwmon2/pwm1_enable 5
check "listing changes nothing: laptop fan"         $H/hwmon1/pwm1 255

bash "$F" > $W/log 2>&1 & PID=$!
settle
check "cool, 50 °C: laptop fan off"        $H/hwmon1/pwm1 0
check "cool, 50 °C: desktop fan at floor"  $H/hwmon2/pwm1 77
check "cool: desktop fan switched to manual" $H/hwmon2/pwm1_enable 1
check "cool: second desktop fan manual"    $H/hwmon2/pwm2_enable 1
check "cool, GPU 50 °C: GPU fan at floor"  $H/hwmon3/pwm1 77
check "cool, 50 °C: fan hub at floor, not off" $H/hwmon5/pwm1 77

put $CPU 69000; settle
check "69 °C: step fan still off"          $H/hwmon1/pwm1 0
put $CPU 72000; settle
check "72 °C: step fan on low"             $H/hwmon1/pwm1 128
check "72 °C: desktop fan half way"        $H/hwmon2/pwm1 162
check "72 °C: fan hub follows the same curve" $H/hwmon5/pwm1 162
check "GPU still cool: GPU fan unchanged"  $H/hwmon3/pwm1 77

put $H/hwmon3/temp1_input 90000; settle
check "GPU 90 °C: GPU fan full"            $H/hwmon3/pwm1 255

put $CPU 70000; settle
check "fall of 2 °C is ignored"            $H/hwmon2/pwm1 162
put $CPU 67000; settle
check "fall of 5 °C is followed"           $H/hwmon2/pwm1 126
put $CPU 60000; settle
check "60 °C: step fan stays on (off only below 58)" $H/hwmon1/pwm1 128
put $CPU 86000; settle
check "86 °C: step fan high"               $H/hwmon1/pwm1 255
put $CPU 77000; settle
check "77 °C: step fan stays high (low only below 76)" $H/hwmon1/pwm1 255
put $CPU 75000; settle
check "75 °C: step fan back to low"        $H/hwmon1/pwm1 128
put $CPU 57000; settle
check "57 °C: step fan off"                $H/hwmon1/pwm1 0
check "57 °C: fan hub at its floor, still turning" $H/hwmon5/pwm1 77
put $CPU 66000; settle
check "66 °C: step fan stays off (on only at 70)" $H/hwmon1/pwm1 0

put $CPU garbage; sleep 0.3
check "unreadable sensor: full speed"      $H/hwmon2/pwm1 255
put $CPU 55000; settle
ok "a short spell without a reading does not stop the service" kill -0 $PID

put $W/mode max; settle
check "max: laptop fan full"               $H/hwmon1/pwm1 255
check "max: desktop fan full"              $H/hwmon2/pwm1 255
check "max: fan hub full"                  $H/hwmon5/pwm1 255

put $W/mode auto; settle
check "auto: desktop fan 1 back to its own mode (5)" $H/hwmon2/pwm1_enable 5
check "auto: desktop fan 2 back to automatic (2)"    $H/hwmon2/pwm2_enable 2
check "auto: GPU fan back to automatic"    $H/hwmon3/pwm1_enable 2
check "auto: laptop fan handed back"       $H/hwmon1/pwm1 0
check "auto: fan hub back at the speed it had" $H/hwmon5/pwm1 100
put $H/hwmon2/pwm1 33; settle
check "auto: nothing touched afterwards"   $H/hwmon2/pwm1 33

put $W/mode cool; settle
check "cool again: manual again"           $H/hwmon2/pwm1_enable 1

# Handing back a laptop fan while the machine is hot must not switch it off there and then.
put $CPU 88000; settle
check "88 °C: step fan high"               $H/hwmon1/pwm1 255
put $W/mode auto; settle
check "auto while hot: the laptop fan is not switched off" $H/hwmon1/pwm1 255
check "auto while hot: the other fans are handed back all the same" $H/hwmon2/pwm1_enable 5
put $CPU 62000; settle
check "auto, cooling: still left to the firmware" $H/hwmon1/pwm1 255
put $CPU 56000; settle
check "auto, cooled down: now it is switched off" $H/hwmon1/pwm1 0
put $H/hwmon1/pwm1 128; settle
check "auto: and never touched again"      $H/hwmon1/pwm1 128
put $CPU 55000; put $W/mode cool; settle
check "cool once more: fans taken again"   $H/hwmon2/pwm1_enable 1
check "cool once more: laptop fan off at 55 °C" $H/hwmon1/pwm1 0
grep -q "mode=cool fans=5" $W/run/status && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL status file: $(cat $W/run/status 2>&1)"; }

# The mode file is the desktop user's: odd contents must never confuse the service.
printf 'max' > $W/mode; settle
check "a mode without a final newline is read"  $H/hwmon2/pwm1 255
put $W/mode "maximum overdrive"; settle
check "an unknown mode means cool"              $H/hwmon2/pwm1 77
put $W/real max; rm $W/mode; ln -s $W/real $W/mode; settle
check "a link in place of the mode file is ignored" $H/hwmon2/pwm1 77
rm $W/mode; put $W/mode cool; settle

# The loop must not start programs: count new processes system-wide while it runs.
c0=$(awk '/^processes/{print $2}' /proc/stat); sleep 2; c1=$(awk '/^processes/{print $2}' /proc/stat)
echo "new processes on the whole machine in 2 s (about 20 rounds): $((c1 - c0))"
ok "nothing is complained about while it runs" [ "$(grep -c "No such file\|rror" $W/log)" = 0 ]

# Stopping: the loop must end at once on SIGTERM; systemd then runs "tempo-fan restore".
kill -TERM $PID
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $PID 2>/dev/null || break; sleep 0.1; done
if kill -0 $PID 2>/dev/null; then fail=$((fail+1)); echo "FAIL  stop: still running 1 s after SIGTERM"; kill -9 $PID; else pass=$((pass+1)); fi
"$F" restore success > /dev/null
check "stop: desktop fan 1 back to its own mode" $H/hwmon2/pwm1_enable 5
check "stop: GPU fan back to automatic"    $H/hwmon3/pwm1_enable 2
check "stop: laptop fan handed back"       $H/hwmon1/pwm1 0
check "stop: fan hub back at the speed it had" $H/hwmon5/pwm1 100

# A fan that can no longer be set (its driver was reloaded): the service must give up with an
# error, so that systemd hands the fans back and starts it afresh.
bash "$F" > $W/log2 2>&1 & PID=$!
settle
check "second run: fans taken again"       $H/hwmon2/pwm1_enable 1
rm $H/hwmon2/pwm1; mkdir $H/hwmon2/pwm1; put $CPU 80000
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do kill -0 $PID 2>/dev/null || break; sleep 0.1; done
if kill -0 $PID 2>/dev/null; then
    fail=$((fail+1)); echo "FAIL  a fan that cannot be set: still running"; kill -9 $PID
else
    wait $PID; code=$?
    ok "a fan that cannot be set: the service ends with an error (got $code)" [ "$code" = 1 ]
fi
ok "a fan that cannot be set: it says so" grep -q "can no longer be set; starting over" $W/log2
rmdir $H/hwmon2/pwm1; put $H/hwmon2/pwm1 120
"$F" restore exit-code > /dev/null
check "after a failure: laptop fan full speed"  $H/hwmon1/pwm1 255
check "after a failure: fan hub full speed"     $H/hwmon5/pwm1 255
check "after a failure: desktop fan back to its own mode" $H/hwmon2/pwm1_enable 5
# What was remembered survives the failure: the next clean stop still knows the originals.
bash "$F" > $W/log3 2>&1 & PID=$!
settle
kill -TERM $PID; wait $PID 2>/dev/null
"$F" restore success > /dev/null
check "after a failure and a restart: the original mode is still known" $H/hwmon2/pwm1_enable 5

# A temperature that stays unreadable: the same, after a few rounds.
bash "$F" > $W/log4 2>&1 & PID=$!
settle
put $CPU garbage
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do kill -0 $PID 2>/dev/null || break; sleep 0.1; done
if kill -0 $PID 2>/dev/null; then
    fail=$((fail+1)); echo "FAIL  a sensor that stays unreadable: still running"; kill -9 $PID
else
    wait $PID; code=$?
    ok "a sensor that stays unreadable: the service ends with an error (got $code)" [ "$code" = 1 ]
fi
put $CPU 50000
"$F" restore exit-code > /dev/null

# At boot the fan drivers may not be there yet: the service must wait for them, not give up.
E=$W/later; mkdir -p $E
TEMPO_FAN_HWMON=$E TEMPO_FAN_STATE=$W/run2 TEMPO_FAN_WAIT=0.1 TEMPO_FAN_SLOW=0.2 bash "$F" > $W/log5 2>&1 & PID2=$!
sleep 1.2
ok "no fans yet: the service keeps waiting" kill -0 $PID2
ok "no fans yet: it says so once" [ "$(grep -c "no controllable fans found yet" $W/log5)" = 1 ]
mkdir -p $E/hwmon0 $E/hwmon1
put $E/hwmon0/name coretemp; put $E/hwmon0/temp1_input 50000
put $E/hwmon1/name it8688; put $E/hwmon1/pwm1 200; put $E/hwmon1/pwm1_enable 2
sleep 1
check "fans that appear later are taken"   $E/hwmon1/pwm1 77
kill -TERM $PID2; wait $PID2 2>/dev/null
TEMPO_FAN_HWMON=$E TEMPO_FAN_STATE=$W/run2 "$F" restore success > /dev/null
check "and given back at the end"          $E/hwmon1/pwm1_enable 2

echo "$pass checks passed, $fail failed"
[ $fail -eq 0 ]
