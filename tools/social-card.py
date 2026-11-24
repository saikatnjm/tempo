#!/usr/bin/env python3
"""Draw the picture that shows when a link to Tempo is shared (docs/assets/social-card.png).

    python3 tools/social-card.py

1200 x 630, the size link previews expect. It uses the real screenshots in docs/assets/, so
run tools/screenshots.sh first if those should be fresh. Needs pycairo and PyGObject (both come
with GNOME) and reads best with the Inter font installed.
"""
import math
from pathlib import Path

import cairo
import gi

gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import Pango, PangoCairo  # noqa: E402

ASSETS = Path(__file__).resolve().parent.parent / 'docs' / 'assets'
W, H = 1200, 630
TEXT = (0.949, 0.949, 0.969)
MUTED = (0.647, 0.647, 0.69)
EMBER = [(1.0, 0.82, 0.4), (1.0, 0.624, 0.263), (1.0, 0.369, 0.494)]


def text(cr, words, x, y, size, weight=Pango.Weight.NORMAL, colour=TEXT, width=None):
    layout = PangoCairo.create_layout(cr)
    font = Pango.FontDescription('Inter, Ubuntu, Cantarell, sans-serif')
    font.set_absolute_size(size * Pango.SCALE)
    font.set_weight(weight)
    layout.set_font_description(font)
    layout.set_text(words, -1)
    if width:
        layout.set_width(int(width * Pango.SCALE))
    cr.move_to(x, y)
    cr.set_source_rgb(*colour)
    PangoCairo.show_layout(cr, layout)
    return layout.get_pixel_size()


def rounded(cr, x, y, w, h, r):
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


def picture(cr, name, x, y, width, radius=14):
    image = cairo.ImageSurface.create_from_png(str(ASSETS / name))
    scale = width / image.get_width()
    height = image.get_height() * scale
    cr.save()
    rounded(cr, x, y, width, height, radius)
    cr.clip()
    cr.translate(x, y)
    cr.scale(scale, scale)
    cr.set_source_surface(image, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_BEST)
    cr.paint()
    cr.restore()
    cr.set_line_width(1)
    cr.set_source_rgba(1, 1, 1, 0.12)
    rounded(cr, x + 0.5, y + 0.5, width - 1, height - 1, radius)
    cr.stroke()
    return height


surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
cr = cairo.Context(surface)

# The site's dark background, with a soft glow in the palette's colours.
cr.set_source_rgb(0.071, 0.071, 0.078)
cr.paint()
for (cx, cy, radius, colour, alpha) in [(1050, 40, 520, EMBER[2], 0.20), (120, 640, 480, EMBER[1], 0.13)]:
    glow = cairo.RadialGradient(cx, cy, 0, cx, cy, radius)
    glow.add_color_stop_rgba(0, *colour, alpha)
    glow.add_color_stop_rgba(1, *colour, 0)
    cr.set_source(glow)
    cr.paint()

# Logo and name.
logo = cairo.ImageSurface.create_from_png(str(ASSETS / 'logo-512.png'))
cr.save()
cr.translate(64, 40)
cr.scale(92 / logo.get_width(), 92 / logo.get_height())
cr.set_source_surface(logo, 0, 0)
cr.get_source().set_filter(cairo.FILTER_BEST)
cr.paint()
cr.restore()
text(cr, 'Tempo', 176, 38, 78, Pango.Weight.BOLD)

# The tag line, and what it covers.
text(cr, 'A super light system monitor', 64, 148, 52, Pango.Weight.BOLD)
line = cairo.LinearGradient(64, 0, 760, 0)
for i, colour in enumerate(EMBER):
    line.add_color_stop_rgb(i / 2, *colour)
layout = PangoCairo.create_layout(cr)
font = Pango.FontDescription('Inter, Ubuntu, Cantarell, sans-serif')
font.set_absolute_size(52 * Pango.SCALE)
font.set_weight(Pango.Weight.BOLD)
layout.set_font_description(font)
layout.set_text('for the GNOME top bar', -1)
cr.move_to(64, 210)
cr.set_source(line)
PangoCairo.show_layout(cr, layout)
text(cr, 'CPU · memory · temperature · internet speed · fans · music visualizer · desktop widgets',
     66, 288, 23, Pango.Weight.MEDIUM, MUTED)

# Real screenshots: the top bar, and the two floating panels.
picture(cr, 'bar-ember.png', 760, 54, 376, 12)
picture(cr, 'float-both.png', 64, 334, 1072, 16)

text(cr, 'saikatnjm.github.io/tempo', 64, 588, 22, Pango.Weight.SEMIBOLD, TEXT)
text(cr, 'Free and open source  ·  Linux, GNOME 42 to 51', 400, 589, 21, Pango.Weight.NORMAL, MUTED)

surface.write_to_png(str(ASSETS / 'social-card.png'))
print(f'docs/assets/social-card.png: {W} x {H}')
