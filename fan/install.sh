#!/usr/bin/env bash
# Install tempo-fan for this computer:   sudo bash fan/install.sh
# Remove it again:                       sudo bash fan/install.sh remove
#
# Needs systemd (Ubuntu, Debian, Fedora, Arch, openSUSE, RHEL and their relatives all use it).
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
command -v systemctl >/dev/null || { echo "tempo-fan needs systemd, which this system doesn't use."; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = remove ]; then
    systemctl disable --now tempo-fan.service 2>/dev/null || true   # stopping gives the fans back
    rm -f /etc/systemd/system/tempo-fan.service /usr/local/bin/tempo-fan
    rm -rf /var/lib/tempo-fan /run/tempo-fan
    systemctl daemon-reload
    echo "Removed. Every fan is back under its own automatic control."
    exit 0
fi

echo "Fans this computer lets Linux control:"
if "$here/tempo-fan" list | sed 's/^/  /' | tee /dev/stderr | grep -q "no controllable fans"; then
    for d in /sys/class/hwmon/hwmon*; do
        [ "$(cat "$d/name" 2>/dev/null)" = thinkpad ] && \
            echo "ThinkPad: add 'options thinkpad_acpi fan_control=1' to /etc/modprobe.d/thinkpad_acpi.conf and reboot."
    done
    echo "Nothing to control here, so nothing was installed."
    exit 0
fi

install -m 0755 "$here/tempo-fan" /usr/local/bin/tempo-fan
install -m 0644 "$here/tempo-fan.service" /etc/systemd/system/tempo-fan.service
# The mode file belongs to the desktop user, so Tempo can switch modes without a password.
# (The service only ever reads its first word, and ignores anything but cool, max or auto.)
owner=${SUDO_USER:-root}
install -d -m 0755 -o "$owner" /var/lib/tempo-fan
[ -f /var/lib/tempo-fan/mode ] || echo cool > /var/lib/tempo-fan/mode
chown "$owner:" /var/lib/tempo-fan/mode
chmod 0644 /var/lib/tempo-fan/mode
systemctl daemon-reload
systemctl enable --now tempo-fan.service
sleep 2
journalctl -u tempo-fan -b --no-pager -o cat | tail -n 8
echo
echo "Installed, in Cool mode. Change the mode from Tempo's menu, or:"
echo "  echo max > /var/lib/tempo-fan/mode      (cool, max or auto)"
echo "To remove: sudo bash $here/install.sh remove"
