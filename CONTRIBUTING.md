# Contributing to Tempo

Thank you for wanting to help. Bug reports, ideas, translations and code are all welcome.

## Reporting a bug

Open an issue and include:

- your distribution and GNOME Shell version (`gnome-shell --version`),
- what you did, what you expected, and what happened,
- any lines mentioning Tempo from `journalctl -b /usr/bin/gnome-shell | grep -i tempo`.

## How the code is organised

```
src/core/     all the real code, in files that are joined in name order
src/shell/    a few lines of imports and the entry point, once for GNOME 42-44 ("legacy")
              and once for GNOME 45+ ("esm")
src/prefs/    the settings window, built the same way
fan/          the optional fan service: one bash script, its systemd unit and its installer
tests/unit/   tests for parsing, formatting and the audio maths (plain gjs)
tests/fan/    runs the fan service against fake fan hardware (no root, nothing real is touched)
tests/smoke/  loads the built extension in a throwaway headless GNOME Shell
docs/         the website
```

GNOME Shell 45 changed extensions from scripts to ES modules, and one file cannot be both.
So `tools/build.sh` joins a small header, the shared core and a small footer into
`extension.js` for each of the two. Nothing in `src/core/` may use `import` or `export`.

## Building and testing

```sh
make build     # both variants into build/
make test      # unit tests and the fan service's tests, no desktop needed
make smoke     # full run in a hidden, throwaway GNOME Shell; nothing on your desktop is touched
make bench     # the processor cost of each part, measured in that hidden shell
make install   # install for your user; log out and back in to load it
```

`make smoke` needs `gnome-shell`, `gjs` and `dbus-run-session`. If `pulseaudio` and `parec`
are installed it also tests the music bars with real captured sound, using a private sound
server that makes no noise.

To check another GNOME version, build one of the container images and run the same test in it:

```sh
docker build -t tempo-test:gnome48 -f tests/smoke/Dockerfile.apt --build-arg BASE=debian:13 tests/smoke
tests/smoke/in-container.sh tempo-test:gnome48
```

Two more tools:

- `tools/measure.sh` measures what Tempo costs on your own desktop, and `make bench` in a clean
  room. The numbers in the README come from these two. Please run `make bench` before and after
  any change that draws or runs on a timer, and say in the pull request what it showed.
- `tools/screenshots.sh` remakes the pictures in `docs/assets/` from the current build.
- `tools/site.py` remakes the website's feature pages (`docs/system-monitor.html` and its
  siblings), `docs/sitemap.xml` and the search-engine data in `docs/index.html`. The texts of
  those pages live in that script; `docs/index.html` and `docs/install.html` are written by hand.
  `tools/social-card.py` redraws the picture shown when a link to the site is shared.

## Ground rules for changes

1. **Stay light.** Nothing may run at all for a part that is switched off, or for something
   nobody can see (screens off, a fullscreen window in front). Readings follow the user's
   refresh interval. Animation runs only where the user switched it on, at the lowest rate that
   still reads as motion: every step is a repaint of the screen. Read hardware sensors with
   `readTextAsync`, never synchronously.
2. **Every feature gets a switch**, and new features start switched off.
3. **Redraw only on change.** Compare before you repaint or set a label. For anything that
   moves, draw it once and let the graphics card stretch, uncover or turn it afterwards.
4. **Clean up in `destroy()`.** Every timer, signal, process and D-Bus subscription that is
   created must be removed there. The smoke test disables and enables the extension twice.
5. **Both variants must work.** Use only APIs that exist from GNOME 42 on, and run the smoke
   test on at least one version from each side of 45 if you touch anything in the Shell UI.
   The smoke test also fails on the warnings GNOME Shell logs for careless widget handling
   (placing widgets by hand in the middle of a layout pass, or asking an off-screen widget for
   its size), so read its last lines.
6. Keep comments about *why*, in plain words.

Run `make test` and `make smoke` before opening a pull request, and describe what you tested.

## Translations

User-visible text goes through `_()`. `make pot` writes `po/tempo.pot`; translations are
welcome as `po/<language>.po` in a pull request.

## Releasing (maintainers)

1. Update `VERSION`, the `"version"` number in `src/metadata.json.in`, and `CHANGELOG.md`.
2. `make test && make smoke`.
3. Commit, then tag `vX.Y.Z` and push the tag. The release workflow builds both zips and
   publishes them.

## Licence

By contributing you agree that your work is released under the GPL-3.0-or-later licence.
