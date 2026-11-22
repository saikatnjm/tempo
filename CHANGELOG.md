# Changelog

All notable changes to Tempo are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow
[Semantic Versioning](https://semver.org/).

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

[1.1.0]: https://github.com/saikatnjm/tempo/releases/tag/v1.1.0
[1.0.0]: https://github.com/saikatnjm/tempo/releases/tag/v1.0.0
