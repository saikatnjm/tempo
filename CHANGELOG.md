# Changelog

All notable changes to Tempo are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-23

### Added

- **Floating panels** (off by default): two panels you can place anywhere on any screen, on the
  desktop behind your windows or on top of them, with a glass, solid or clear background.
  - The **system panel** shows processor, memory, temperature and network speed, as rings or as
    bars, and a little fan that turns while the computer's real fan does (with its speed, and the
    fan mode if fan control is installed).
  - The **visualizer panel** shows the music as bars of lit segments in the palette's colours,
    with falling peak caps and a reflection; as the same bars mirrored; or as a wave. A wider
    panel shows more bars, a taller one more segments.
  - Drag a panel to move it. Drag its corner to zoom it: it keeps its shape, and everything in
    it grows with it. Drag its right or bottom edge to reshape it.
  - A floating panel replaces its part of the top bar while it is on.
- **Fan control** (optional): the new `tempo-fan` service runs every fan Linux can control from
  its temperature, for computers that start their fans late. Install or remove it from Tempo's
  settings (your password is asked once); the menu then has a Fan mode switch: Cool, Full speed
  or Automatic. Without the service, Tempo is unchanged. See `fan/README.md`.
- A link to the website at the bottom of the menu.

### Changed

- **Listening to music costs about a tenth of what it did.** Sound servers hand sound over in
  100 to 200 small pieces a second while a browser plays, and Tempo used to wake the desktop
  shell for each one. It now reads once per frame. Measured with `make bench` at the default 8
  updates a second: listening went from about 9 % of one processor core to about 1 %, the small
  bars from 10.7 % to 2.1 %, the level line from 10.2 % to 1.4 %.
- **Nothing runs while the screens are off.** When GNOME blanks the screens, Tempo stops
  reading, listening and animating, and picks up again when they come back.
- The small bars are drawn once and afterwards only stretched by the graphics card, like the
  level line.
- The music visuals pause when a fullscreen window covers the place they are drawn: the main
  screen for the top bar, the visualizer panel's own screen for the panel.
- The menu is more compact, so it fits small laptop screens with room to spare.
- `make bench` now plays its music the way a browser does (short latency), so its figures
  include the cost that real desktops have. Figures from earlier versions were too low.

### Fixed

- A floating panel kept following the pointer if the mouse button was released over a window.
  Dragging now holds the pointer until the button is released.
- The visualizer's peak caps could stay lit after the music stopped.
- Switching the system panel's design showed dashes until the next reading.
- With the menu open and the system panel shown, every fan was read twice per reading; the fan
  mode file was looked at on every reading.
- "Now playing" could miss an update when a player changed state while it was being asked.
- `tempo-fan`: a mode written without a final newline was ignored; the mode file is now only
  read if it is a regular file.

## [1.1.0] - 2026-11-22

### Changed

- The full-width music effect is now the **level line**: one thin line along the bottom of the
  top bar that grows out from the middle with the loudness. It replaces the pixel strip, and
  costs less because it is drawn once and only stretched afterwards.
- Music is shown as either the small bars or the level line; the "both" option is gone.
- Download links on the website and in the README always fetch the newest release, and the new
  install guide covers every major GNOME distribution.

- The menu lists every fan the computer reports (processor, case, graphics card, laptop), each
  by name, up to four. Empty connectors and impossible readings are left out.

### Fixed

- Desktop PCs: the fan was often missing, because only the first fan input of each sensor chip
  was read, while the processor fan is often the second or third.
- GNOME 50: Tempo failed to switch on, because GNOME 50 no longer accepts an option Tempo used
  for its hover card and the full-width effect.

## [1.0.0] - 2026-11-19

First release.

### Added

- Processor and memory rings in the top bar.
- Processor temperature, turning amber above 75 °C and red above 85 °C.
- Network speed as two small stacked lines of fixed width, so the top bar never shuffles
  (off by default).
- Music visuals that follow the sound while a media player is playing (off by default), shown
  as ten small bars next to the rings, as a light strip of pixels along the whole top bar, or
  as both.
- "Now playing": rest the pointer on the bars to see what is playing and in which app; the
  menu shows it too, and a click takes you to that app.
- One menu with processor, memory, temperature, fan, network and the four busiest apps.
- Four colour palettes: Ember, Aurora, Orchid and Mono.
- A settings window; every part of Tempo has its own switch.
- Builds for GNOME Shell 42 to 44 and for GNOME Shell 45 and later, from one code base.

[1.2.0]: https://github.com/saikatnjm/tempo/releases/tag/v1.2.0
[1.1.0]: https://github.com/saikatnjm/tempo/releases/tag/v1.1.0
[1.0.0]: https://github.com/saikatnjm/tempo/releases/tag/v1.0.0
