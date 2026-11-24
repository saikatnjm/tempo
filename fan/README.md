# tempo-fan: an optional fan curve

Some computers start their fans late. A Dell Inspiron 3505, for example, keeps its fan off
until the processor reaches about 90 °C, so everyday work sits at 75–90 °C. tempo-fan runs the
fans from their temperature instead, and Tempo's menu gets a **Fan mode** switch:

| Mode | What the fans do |
|---|---|
| **Cool** (default) | Run at 30 % below 60 °C, rise evenly from there and reach full speed at 85 °C. Dell laptop fans, which only know off, low and high, switch at fixed points with wide gaps: low from 70 °C until it drops below 58 °C, high from 85 °C until it drops below 76 °C |
| **Full speed** | Run at full speed |
| **Automatic** | Hands off: the computer's own fan control, as if tempo-fan weren't there |

## Works on

Any Linux distribution that uses systemd, with any fan that the kernel lets software set,
through its standard `hwmon` interface:

- **Desktop motherboards** (Nuvoton, ITE, Fintek chips): every fan header, never below 30 %
- **AMD graphics cards**: their fans follow the card's own temperature
- **Laptops**: Dell (speed steps: off, low, high), ASUS, Framework and others that expose fan control;
  ThinkPads after `options thinkpad_acpi fan_control=1` in `/etc/modprobe.d/thinkpad_acpi.conf`
- **Fan hubs** and other fans with a speed but no automatic mode: never below 30 %, and given
  their old speed back at the end

Fans Linux can only read (many laptops, NVIDIA cards on the official driver), and fans that
refuse to be driven, are left alone and still shown in Tempo's menu. If nothing on a computer
can be controlled, the installer says so and installs nothing.

The processor's temperature comes from its own sensor (`k10temp`, `coretemp` and so on). The
`acpitz` sensor that many desktop boards have, often stuck at a fixed low value, is only used
when there is nothing better.

## Install and remove

The easy way: open Tempo's **Settings**, scroll to **Fan control** and press **Install**. GNOME
asks for your password once, because fans can only be driven with administrator rights. The
same button removes it again. (A copy of Tempo installed through extensions.gnome.org has no
such button, because that website does not let an extension run an installer: use the commands
below.)

From the source code:

```sh
sudo bash fan/install.sh          # lists the fans it will control, then starts in Cool mode
sudo bash fan/install.sh remove   # every fan goes back to its own automatic control
```

Change the mode from Tempo's menu, or with `echo max > /var/lib/tempo-fan/mode`
(`cool`, `max` or `auto`). The log shows what it does: `journalctl -u tempo-fan`.

## Safe by design

- When the service stops for any reason, every fan goes back to its own automatic control.
  After a crash, fans that have no automatic mode to return to are set to full speed, never off.
- A Dell laptop's fan is handed back to the laptop without being switched off while the
  machine is hot; fans that nothing else looks after are never stopped at all.
- An unreadable or nonsensical temperature counts as hot.
- If a fan can no longer be set, or a temperature stays unreadable (a driver was reloaded),
  the service ends with an error. systemd then hands the fans back and starts it afresh, and
  it looks the hardware up again.
- At boot it waits for fan drivers that load late instead of giving up.
- The mode file belongs to you, so that Tempo can change the mode without a password. The
  service trusts nothing about it: it reads only a regular file, only its first few characters,
  and treats anything but the three modes as Cool.
- A fan only slows down once its temperature has dropped 4 °C (12 °C for fans with speed steps),
  so it doesn't hunt up and down.

## Cost

A small bash loop: every 5 seconds it reads one temperature file per sensor and writes a fan
setting only when the speed should change. It starts no programs while running (only bash
built-ins, even for the wait), holds no network access, and is capped at 16 MB of memory.
`tests/fan/run.sh` checks all of this against fake fan hardware.
