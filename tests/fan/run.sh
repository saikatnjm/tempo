#!/bin/bash
# Tests for fan/tempo-fan against a fake /sys/class/hwmon: a Dell-style laptop fan (speed steps,
# no enable switch), a desktop board with two fans (auto/manual switches), an AMD graphics card
# with its own temperature, and a read-only fan. No hardware is touched.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d); trap 'kill $PID 2>/dev/null; rm -rf "$W"' EXIT
H=$W/hwmon; mkdir -p "$H"/hwmon{0,1,2,3,4}
put() { printf '%s\n' "$2" > "$1"; }
put $H/hwmon0/name k10temp;  put $H/hwmon0/temp1_input 50000
put $H/hwmon1/name dell_smm; put $H/hwmon1/pwm1 255; put $H/hwmon1/fan1_input 0
put $H/hwmon2/name nct6798;  put $H/hwmon2/pwm1 120; put $H/hwmon2/pwm1_enable 5; put $H/hwmon2/pwm2 90; put $H/hwmon2/pwm2_enable 2; put $H/hwmon2/temp1_input 40000
put $H/hwmon3/name amdgpu;   put $H/hwmon3/pwm1 60;  put $H/hwmon3/pwm1_enable 2; put $H/hwmon3/temp1_input 50000
put $H/hwmon4/name thinkpad; put $H/hwmon4/fan1_input 2000
put $W/mode cool
export TEMPO_FAN_HWMON=$H TEMPO_FAN_MODE=$W/mode TEMPO_FAN_STATE=$W/run TEMPO_FAN_INTERVAL=0.1
F=$ROOT/fan/tempo-fan

pass=0 fail=0
v() { local x; read -r x < "$1"; printf '%s' "$x"; }
check() { # check <name> <file> <expected>
    local got; got=$(v "$2")
    if [ "$got" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL  $1: got $got, expected $3"; fi
}
settle() { sleep 0.5; }

echo "$("$F" list)" | grep -q "dell_smm pwm1" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL list"; }
[ "$("$F" list | grep -c pwm)" = 4 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL list count: $("$F" list)"; }

bash "$F" > $W/log 2>&1 & PID=$!
settle
check "cool, 50 °C: laptop fan off"        $H/hwmon1/pwm1 0
check "cool, 50 °C: desktop fan at floor"  $H/hwmon2/pwm1 77
check "cool: desktop fan switched to manual" $H/hwmon2/pwm1_enable 1
check "cool: second desktop fan manual"    $H/hwmon2/pwm2_enable 1
check "cool, GPU 50 °C: GPU fan at floor"  $H/hwmon3/pwm1 77

put $H/hwmon0/temp1_input 72000; settle
check "72 °C: laptop fan half way"         $H/hwmon1/pwm1 122
check "72 °C: desktop fan half way"        $H/hwmon2/pwm1 162
check "GPU still cool: GPU fan unchanged"  $H/hwmon3/pwm1 77

put $H/hwmon3/temp1_input 90000; settle
check "GPU 90 °C: GPU fan full"            $H/hwmon3/pwm1 255

put $H/hwmon0/temp1_input 70000; settle
check "fall of 2 °C is ignored"            $H/hwmon2/pwm1 162
put $H/hwmon0/temp1_input 67000; settle
check "fall of 5 °C is followed"           $H/hwmon2/pwm1 126

put $H/hwmon0/temp1_input 99000; put $H/hwmon0/temp1_input garbage; settle
check "unreadable sensor: full speed"      $H/hwmon2/pwm1 255
put $H/hwmon0/temp1_input 55000; settle

put $W/mode max; settle
check "max: laptop fan full"               $H/hwmon1/pwm1 255
check "max: desktop fan full"              $H/hwmon2/pwm1 255

put $W/mode auto; settle
check "auto: desktop fan 1 back to its own mode (5)" $H/hwmon2/pwm1_enable 5
check "auto: desktop fan 2 back to automatic (2)"    $H/hwmon2/pwm2_enable 2
check "auto: GPU fan back to automatic"    $H/hwmon3/pwm1_enable 2
check "auto: laptop fan handed back"       $H/hwmon1/pwm1 0
put $H/hwmon2/pwm1 33; settle
check "auto: nothing touched afterwards"   $H/hwmon2/pwm1 33

put $W/mode cool; settle
check "cool again: manual again"           $H/hwmon2/pwm1_enable 1
grep -q "mode=cool fans=4" $W/run/status && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL status file"; }

# The loop must not start programs: count new processes system-wide while it runs.
c0=$(awk '/^processes/{print $2}' /proc/stat); sleep 2; c1=$(awk '/^processes/{print $2}' /proc/stat)
echo "new processes on the whole machine in 2 s (about 20 rounds): $((c1 - c0))"

# Stopping: the loop must end at once on SIGTERM; systemd then runs "tempo-fan restore".
kill -TERM $PID
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $PID 2>/dev/null || break; sleep 0.1; done
if kill -0 $PID 2>/dev/null; then fail=$((fail+1)); echo "FAIL  stop: still running 1 s after SIGTERM"; kill -9 $PID; else pass=$((pass+1)); fi
"$F" restore success > /dev/null
check "stop: desktop fan 1 back to its own mode" $H/hwmon2/pwm1_enable 5
check "stop: GPU fan back to automatic"    $H/hwmon3/pwm1_enable 2
check "stop: laptop fan handed back"       $H/hwmon1/pwm1 0

put $H/hwmon2/pwm1_enable 1; "$F" restore failed > /dev/null
check "after a crash: laptop fan full speed" $H/hwmon1/pwm1 255
check "after a crash: desktop fan automatic" $H/hwmon2/pwm1_enable 5

echo "$pass checks passed, $fail failed"
[ $fail -eq 0 ]
