# Tempo on extensions.gnome.org

What goes on the listing at [extensions.gnome.org](https://extensions.gnome.org/), and how to
put it there. The account, the upload and any answers to the reviewer are the maintainer's.

## The files

`make ego` writes two zips into `dist/ego/`. Upload both at
<https://extensions.gnome.org/upload/>, the older range first:

| File | For |
|---|---|
| `tempo-<version>-ego-gnome42-44.shell-extension.zip` | GNOME 42, 43 and 44 |
| `tempo-<version>-ego-gnome45-plus.shell-extension.zip` | GNOME 45 to 51 |

The website gives each upload its own number and serves every visitor the newest one that
matches their GNOME version. `tools/build.sh` says how these zips differ from the ones released
on GitHub (in short: no fan installer).

Before uploading:

1. `TEMPO_SMOKE_EGO=1 make smoke` installs the zip for this computer's GNOME version the way
   GNOME does and runs every test on it. `tests/smoke/in-container.sh` does the same for another
   GNOME version.
2. The website runs its own checker, Shexli, on every upload and shows the result to the
   reviewer. Run it on both zips first: `shexli dist/ego/<file>.zip`. It must report nothing,
   as it did when this was written. Install it from the website's own source, which is what the
   website runs:
   `pip install "git+https://gitlab.gnome.org/Infrastructure/extensions-web.git#subdirectory=shexli"`.
   (The copy that `pip install shexli` fetches was older in November 2026: it did not know
   GNOME 51 yet and called it an "implausible future release".)

## Description

The website shows the `description` of the uploaded `metadata.json`, and reads it again at every
upload. So the text is not pasted by hand: `make ego` takes it from between the two marker lines
below and writes it into both zips. Its first line is what search results show. Edit it here.

<!-- description:start -->
```
A super light system monitor for the GNOME top bar: CPU and memory as two small rings, with load, memory and swap, temperatures, fan speeds, network speed and the busiest apps one click away.

It also shows the CPU temperature (amber above 75 °C, red above 85 °C) and your internet speed, download and upload, in a width that never changes. A music visualizer moves with whatever is playing, as small bars or as a thin level line along the top bar. Desktop widgets put a system panel and a bigger visualizer anywhere on your desktop.

Every part has its own switch, and a part that is off does not run. The rings, temperature and network speed add no measurable processor load, and nothing runs while the screens are off.

The music visualizer needs the parec program (package pulseaudio-utils, or libpulse on Arch; it works with PipeWire too). It reads what your speakers play, only while a media player is playing. It never opens the microphone, and nothing is stored or sent anywhere. Its stream carries the id of a volume meter (pavucontrol), so that GNOME does not show its microphone icon for it.

Fan speeds are shown for up to four fans. Changing how the fans run needs a separate system service, which this extension does not install; the website shows how.

Install guide, questions and source code: https://saikatnjm.github.io/tempo/
```
<!-- description:end -->

## Screenshot and icon

Both are uploaded on the extension's own page, after the first zip is in.

- **Screenshot:** `docs/assets/social-card.png` (1200 × 630). It is the one picture that shows
  the top bar, the system panel and the visualizer together, under the same first line as the
  description. The website takes PNG, JPEG, GIF or WebP up to 2 MB.
- **Icon:** `docs/assets/logo-512.png` (512 × 512, the largest the website accepts).
