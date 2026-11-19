// ---- widgets: the ring gauge and the music bars ----------------------------------------------
//
// Both are tiny St.DrawingArea actors sized by the stylesheet (so HiDPI scaling just works) and
// redrawn only when the value they show actually changes.

/**
 * Colour palettes. `bars` is a gradient across the music bars; `cpu` and `memory` colour the
 * rings. "mono" (null) follows the top bar's own text colour, like stock indicators do.
 */
const PALETTES = new Map([
    ['ember', {bars: [[255, 209, 102], [255, 159, 67], [255, 94, 126]], cpu: [255, 159, 67], memory: [255, 94, 126]}],
    ['aurora', {bars: [[100, 210, 255], [10, 132, 255], [191, 90, 242]], cpu: [10, 132, 255], memory: [191, 90, 242]}],
    ['orchid', {bars: [[255, 163, 209], [255, 111, 181], [199, 125, 255]], cpu: [255, 111, 181], memory: [199, 125, 255]}],
    ['mono', null],
]);
const DEFAULT_PALETTE = 'ember';

/** Set a label's text only if it changed, so nothing is laid out or painted for no reason. */
function setLabel(label, text) {
    if (label.text !== text)
        label.text = text;
}

/** The top bar's text colour as [r, g, b, a] floats; works on light and dark themes alike. */
function themeForeground(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    return [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255];
}

/** A small circular gauge that fills clockwise from the top. */
class RingWidget {
    constructor() {
        this._value = 0;
        this._percent = -1;
        this._color = null;
        this.actor = new St.DrawingArea({
            style_class: 'tempo-ring',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.connect('repaint', area => this._draw(area));
    }

    /** @param {number[]|null} rgb - [r, g, b] 0..255, or null to use the text colour */
    setColor(rgb) {
        this._color = rgb ? rgb.map(c => c / 255) : null;
        this.actor.queue_repaint();
    }

    /** @param {number} value - 0..1 */
    set(value) {
        const v = clamp(value, 0, 1);
        const percent = Math.round(v * 100);
        if (percent === this._percent)
            return;                              // nothing visible changed: no redraw
        this._percent = percent;
        this._value = v;
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const size = Math.min(width, height);
        const line = Math.max(2, size * 0.15);
        const radius = size / 2 - line / 2 - 0.5;
        const cx = width / 2, cy = height / 2;
        const fg = themeForeground(area);

        cr.setLineWidth(line);
        cr.setSourceRGBA(fg[0], fg[1], fg[2], fg[3] * 0.2);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._value > 0.005) {
            const color = this._color ?? fg;
            cr.setLineCap(1);                    // round ends
            cr.setSourceRGBA(color[0], color[1], color[2], 1);
            cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + this._value * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }
}

/** A row of rounded bars, vertically centred, one per frequency band. */
class BarsWidget {
    constructor(count) {
        this._count = count;
        this._levels = new Uint8Array(count);
        this._colors = null;
        // Reactive only so that hovering can be noticed; clicks still fall through to the button.
        this.actor = new St.DrawingArea({
            style_class: 'tempo-bars',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            reactive: true,
            track_hover: true,
        });
        this.actor.connect('repaint', area => this._draw(area));
    }

    /** @param {number[][]|null} stops - gradient stops, or null to use the text colour */
    setPalette(stops) {
        const n = this._count;
        this._colors = stops
            ? Array.from({length: n}, (_unused, i) => gradientColor(stops, n > 1 ? i / (n - 1) : 0))
            : null;
        this.actor.queue_repaint();
    }

    /** @param {Uint8Array} levels - one value per bar, 0..SPECTRUM_LEVELS */
    setLevels(levels) {
        this._levels.set(levels);
        this.actor.queue_repaint();
    }

    clear() {
        this._levels.fill(0);
    }

    _draw(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const n = this._count;
        const barWidth = Math.max(2, Math.floor(width / (n * 1.6)));
        const gap = n > 1 ? (width - n * barWidth) / (n - 1) : 0;
        const r = barWidth / 2;
        const fg = this._colors === null ? themeForeground(area) : null;

        for (let i = 0; i < n; i++) {
            const barHeight = Math.max(barWidth, this._levels[i] / SPECTRUM_LEVELS * height);
            const x = i * (barWidth + gap);
            const y = (height - barHeight) / 2;
            const c = fg ?? this._colors[i];
            cr.setSourceRGBA(c[0], c[1], c[2], 0.95);
            cr.newSubPath();
            cr.arc(x + r, y + r, r, Math.PI, 0);
            cr.arc(x + r, y + barHeight - r, r, 0, Math.PI);
            cr.closePath();
            cr.fill();
        }
        cr.$dispose();
    }
}

// The light strip: small "pixels" along the whole top bar. Sizes in logical pixels.
const STRIP_PIXEL_WIDTH = 4;
const STRIP_PIXEL_HEIGHT = 2;
const STRIP_PITCH = 6;               // one pixel plus the gap to the next
const STRIP_ROW_GAP = 1;
const STRIP_HEIGHT = 2 * STRIP_PIXEL_HEIGHT + STRIP_ROW_GAP;     // two rows of pixels
const STRIP_OPACITY_STEP = 32;       // smaller brightness changes are not worth a redraw
const STRIP_RESTING_GLOW = 0.18;     // how bright the lower row is when its band is silent

/**
 * The music spread along the whole top bar: each bar lights its own stretch of pixels, bass in
 * the middle and treble at both ends. The lower row glows with the sound; the upper row lights
 * up only for the louder half.
 *
 * Built to cost as little as a full-width effect can: the pixels are drawn once, one segment
 * per bar and side, and after that only the segments' opacity changes. Nothing is drawn and no
 * texture is uploaded per frame. It is still the most expensive thing Tempo can show, because
 * every change makes GNOME Shell repaint a strip as wide as the screen.
 */
class StripWidget {
    constructor(bands) {
        this._bands = bands;
        this._stops = undefined;
        this._segments = [];
        this.actor = new St.Widget({
            style_class: 'tempo-strip',
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            opacity: 0,
        });
        this.actor.connect('notify::width', () => this._rebuild());
    }

    /** @param {number[][]|null} stops - three gradient stops (0..255), or null for the text colour */
    setPalette(stops) {
        if (stops === this._stops)
            return;
        this._stops = stops;
        this._rebuild();
    }

    /** @param {Uint8Array} levels - one value per band, 0..SPECTRUM_LEVELS */
    setLevels(levels) {
        for (const segment of this._segments) {
            const value = levels[segment.band] / SPECTRUM_LEVELS;
            const low = this._step(STRIP_RESTING_GLOW + (1 - STRIP_RESTING_GLOW) * value);
            const high = value > 0.5 ? this._step((value - 0.5) * 2) : 0;
            if (segment.low.opacity !== low)
                segment.low.opacity = low;
            if (segment.high.opacity !== high)
                segment.high.opacity = high;
        }
    }

    clear() {
        for (const segment of this._segments) {
            segment.low.opacity = this._step(STRIP_RESTING_GLOW);
            segment.high.opacity = 0;
        }
    }

    _step(fraction) {
        return Math.min(255, Math.round(fraction * 255 / STRIP_OPACITY_STEP) * STRIP_OPACITY_STEP);
    }

    // Lay the segments out again: only when the top bar's width or the palette changes.
    _rebuild() {
        this.actor.destroy_all_children();
        this._segments = [];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this.actor.width / scale;
        const pixels = Math.floor((width + STRIP_PITCH - STRIP_PIXEL_WIDTH) / STRIP_PITCH);
        if (pixels < 1)
            return;
        const offset = (width - (pixels * STRIP_PITCH - (STRIP_PITCH - STRIP_PIXEL_WIDTH))) / 2;
        const middle = (pixels - 1) / 2;
        const fromMiddle = pixel => (middle > 0 ? Math.abs(pixel - middle) / middle : 0);
        // One segment per band on each side of the middle.
        const perSegment = Math.max(1, Math.ceil(pixels / (2 * this._bands)));

        for (let start = 0; start < pixels; start += perSegment) {
            const count = Math.min(perSegment, pixels - start);
            const band = Math.min(this._bands - 1,
                Math.floor(fromMiddle(start + (count - 1) / 2) * this._bands));
            const colors = [];
            for (let i = 0; i < count; i++)
                colors.push(this._stops ? gradientColor(this._stops, fromMiddle(start + i)) : null);

            const row = top => {
                const area = new St.DrawingArea({reactive: false, opacity: 0});
                // A see-through actor is normally painted into a buffer of its own first, in
                // case its parts overlap. These pixels don't, so skip that.
                area.set_offscreen_redirect(0);
                area.set_position(Math.round((offset + start * STRIP_PITCH) * scale),
                    top ? 0 : (STRIP_PIXEL_HEIGHT + STRIP_ROW_GAP) * scale);
                area.set_size(Math.ceil(count * STRIP_PITCH * scale), STRIP_PIXEL_HEIGHT * scale);
                area.connect('repaint', a => this._drawSegment(a, colors));
                this.actor.add_child(area);
                return area;
            };
            this._segments.push({band, low: row(false), high: row(true)});
        }
        this.clear();
    }

    // Runs once per segment (and again only if the theme or scale changes), never per frame.
    _drawSegment(area, colors) {
        const cr = area.get_context();
        const fg = themeForeground(area);
        colors.forEach((color, i) => {
            const c = color ?? fg;
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            cr.rectangle(i * STRIP_PITCH, 0, STRIP_PIXEL_WIDTH, STRIP_PIXEL_HEIGHT);
            cr.fill();
        });
        cr.$dispose();
    }
}

/**
 * One "now playing" line: the app's icon, the title, and the app's name (with the artist)
 * underneath. Used in the hover tip over the music bars and at the top of the menu.
 */
class PlayingRow {
    constructor() {
        this.icon = new St.Icon({
            style_class: 'tempo-playing-icon',
            icon_name: 'audio-x-generic-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.title = new St.Label({style_class: 'tempo-playing-title'});
        this.subtitle = new St.Label({style_class: 'tempo-playing-app', opacity: 185});
        // (St.BoxLayout's own "vertical" property is on its way out in newer GNOME versions.)
        this.text = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this.text.layout_manager.orientation = Clutter.Orientation.VERTICAL;
        this.text.add_child(this.title);
        this.text.add_child(this.subtitle);
    }

    /**
     * @param {object} entry - from PlayerWatch.describe()
     * @param {Shell.App|null} app - the matching installed app, if one was found
     */
    fill(entry, app) {
        const name = (app ? app.get_name() : '') || entry.app || _('A media player');
        if (app) {
            this.icon.gicon = app.get_icon();
        } else {
            this.icon.gicon = null;
            this.icon.icon_name = 'audio-x-generic-symbolic';
        }
        if (entry.title) {
            setLabel(this.title, entry.title);
            setLabel(this.subtitle, entry.artist ? `${name} · ${entry.artist}` : name);
        } else {
            setLabel(this.title, name);
            setLabel(this.subtitle, _('Playing'));
        }
    }
}
