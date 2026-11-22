# tempo-fan: an optional fan curve

Some computers start their fans late. A Dell Inspiron 3505, for example, keeps its fan off
until the processor reaches about 90 °C, so everyday work sits at 75–90 °C. tempo-fan runs the
fans from their temperature instead, and Tempo's menu gets a **Fan mode** switch:

| Mode | What the fans do |
|---|---|
| **Cool** (default) | Rise evenly from 60 °C and reach full speed at 85 °C |
| **Full speed** | Run at full speed |
| **Automatic** | Hands off: the computer's own fan control, as if tempo-fan weren't there |

## Works on

Any Linux distribution that uses systemd, with any fan that the kernel lets software set,
through its standard `hwmon` interface:

- **Desktop motherboards** (Nuvoton, ITE, Fintek chips): every fan header, never below 30 %
- **AMD graphics cards**: their fans follow the card's own temperature
- **Laptops**: Dell (speed steps: off, low, high), ASUS, Framework and others that expose fan control;
  ThinkPads after `options thinkpad_acpi fan_control=1` in `/etc/modprobe.d/thinkpad_acpi.conf`

Fans Linux can only read (many laptops, NVIDIA cards on the official driver) are left alone and
still shown in Tempo's menu. If nothing on a computer can be controlled, the installer says so
and installs nothing.

## Install and remove

```sh
sudo bash fan/install.sh          # lists the fans it will control, then starts in Cool mode
sudo bash fan/install.sh remove   # every fan goes back to its own automatic control
```

Change the mode from Tempo's menu, or with `echo max > /var/lib/tempo-fan/mode`
(`cool`, `max` or `auto`). The log shows what it does: `journalctl -u tempo-fan`.

## Safe by design

- When the service stops for any reason, every fan goes back to its own automatic control.
  After a crash, fans that have no automatic mode to return to are set to full speed, never off.
- An unreadable or nonsensical temperature counts as hot.
- A fan only slows down once its temperature has dropped 4 °C, so it doesn't hunt up and down.

## Cost

A small bash loop: every 5 seconds it reads one temperature file per sensor and writes a fan
setting only when the speed should change. It starts no programs while running (only bash
built-ins, even for the wait), holds no network access, and is capped at 16 MB of memory.
`tests/fan/run.sh` checks all of this against fake fan hardware.
