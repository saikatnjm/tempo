// ---- widgets: the ring gauge, the music bars and the level line ------------------------------
//
// All are tiny actors sized by the stylesheet (so HiDPI scaling just works). A ring is redrawn
// only when the value it shows changes; the bars and the line are drawn once and then only
// stretched by the graphics card.

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

/** Whether two colours ([r, g, b], null or undefined) are the same. */
function sameColor(a, b) {
    if (a === b)
        return true;
    return Boolean(a && b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

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
    /** @param {object} [options] - {styleClass, expand}: the floating panel uses bigger rings */
    constructor({styleClass = 'tempo-ring', expand = false} = {}) {
        this._value = 0;
        this._percent = -1;
        this._color = undefined;
        this.actor = new St.DrawingArea({
            style_class: styleClass,
            y_align: expand ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
            x_expand: expand,
            y_expand: expand,
        });
        this.actor.connect('repaint', area => this._draw(area));
    }

    /** @param {number[]|null} rgb - [r, g, b] 0..255, or null to use the text colour */
    setColor(rgb) {
        if (sameColor(rgb, this._color))
            return;
        this._color = rgb;
        this.actor.queue_repaint();
    }

    /** Thinner stroke, for big rings. */
    setThin(thin) {
        this._thin = thin;
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
        const line = Math.max(2, size * (this._thin ? 0.09 : 0.15));
        const radius = size / 2 - line / 2 - 0.5;
        const cx = width / 2, cy = height / 2;
        const fg = themeForeground(area);

        cr.setLineWidth(line);
        cr.setSourceRGBA(fg[0], fg[1], fg[2], fg[3] * 0.2);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._value > 0.005) {
            const color = this._color ? this._color.map(c => c / 255) : fg;
            cr.setLineCap(1);                    // round ends
            cr.setSourceRGBA(color[0], color[1], color[2], 1);
            cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + this._value * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }
}

// A bar at rest is a dot: as tall as it is wide (3px of 16px in the stylesheet).
const BARS_RESTING = 3 / 16;

/**
 * A row of rounded bars, vertically centred, one per frequency band.
 *
 * Built like the level line, to cost next to nothing: each bar is a small picture of a pill that
 * is drawn once, and after that only its height scale changes, which the graphics card does.
 * Nothing is drawn or uploaded per frame, and a bar whose level did not change is not touched.
 */
class BarsWidget {
    constructor(count) {
        this._count = count;
        this._levels = new Uint8Array(count);
        this._shown = new Uint8Array(count).fill(255);   // the level each bar shows; 255: none yet
        this._stops = undefined;
        // Reactive only so that hovering can be noticed; clicks still fall through to the button.
        // The stylesheet lays the bars out (their width, the gaps, the height), so HiDPI scaling
        // just works and nothing here ever has to be positioned by hand.
        this.actor = new St.BoxLayout({
            style_class: 'tempo-bars',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            reactive: true,
            track_hover: true,
        });
        this._barActors = [];
        for (let i = 0; i < count; i++) {
            const bar = new St.DrawingArea({style_class: 'tempo-bar', y_expand: true});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = BARS_RESTING;
            bar.connect('repaint', area => this._draw(area, i));
            this.actor.add_child(bar);
            this._barActors.push(bar);
        }
        this.actor._delegate = this;
    }

    /** @param {number[][]|null} stops - gradient stops, or null to use the text colour */
    setPalette(stops) {
        if (stops === this._stops)
            return;
        this._stops = stops;
        for (const bar of this._barActors)
            bar.queue_repaint();
    }

    /** @param {Uint8Array} levels - one value per bar, 0..SPECTRUM_LEVELS */
    setLevels(levels) {
        this._levels.set(levels);
        this._apply();
    }

    clear() {
        this._levels.fill(0);
        this._apply();
    }

    _apply() {
        for (let i = 0; i < this._count; i++) {
            const level = this._levels[i];
            if (level === this._shown[i])
                continue;                        // unchanged: not even a transform update
            this._shown[i] = level;
            this._barActors[i].scale_y = Math.max(BARS_RESTING, level / SPECTRUM_LEVELS);
        }
    }

    // One bar at full height, as a pill in its colour. Runs when the bar is created or resized,
    // or the palette or theme changes; never per frame.
    _draw(area, i) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const n = this._count;
        const c = this._stops ? gradientColor(this._stops, n > 1 ? i / (n - 1) : 0) : themeForeground(area);
        const r = Math.min(width, height) / 2;
        cr.setSourceRGBA(c[0], c[1], c[2], 0.95);
        cr.newSubPath();
        cr.arc(width / 2, r, r, Math.PI, 0);
        cr.arc(width / 2, height - r, r, 0, Math.PI);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
}

// The level line along the bottom edge of the top bar. Sizes in logical pixels.
const STRIP_HEIGHT = 2;
const LINE_STEPS = 48;               // length steps; smaller changes are not worth a repaint
const LINE_RESTING = 0.04;           // length while the music is very quiet
const LINE_GRADIENT_STEP = 2;        // width of each colour band when the line is drawn

/**
 * The level line: one thin line along the whole top bar that grows out from the middle as the
 * music gets louder and shrinks back as it quietens, in the palette's colours (bass colour in
 * the middle, treble colour at the ends).
 *
 * Built to cost next to nothing: the line is drawn once, and after that only its horizontal
 * scale changes, which the graphics card does. Nothing is drawn or uploaded per frame.
 */
class StripWidget {
    constructor(bands) {
        this._bands = bands;
        this._stops = undefined;
        this._step = -1;
        this.actor = new St.DrawingArea({style_class: 'tempo-strip', reactive: false, opacity: 0});
        this.actor.set_pivot_point(0.5, 0.5);
        this.actor.scale_x = LINE_RESTING;
        this.actor.connect('repaint', area => this._draw(area));
    }

    /** @param {number[][]|null} stops - three gradient stops (0..255), or null for the text colour */
    setPalette(stops) {
        if (stops === this._stops)
            return;
        this._stops = stops;
        this.actor.queue_repaint();
    }

    /** @param {Uint8Array} levels - one value per band, 0..SPECTRUM_LEVELS */
    setLevels(levels) {
        // Overall loudness, with the bass (the beat) counting a little more than the treble.
        const n = levels.length;
        let sum = 0, weight = 0;
        for (let i = 0; i < n; i++) {
            const w = 2 - i / n;
            sum += levels[i] * w;
            weight += w;
        }
        const loudness = Math.min(1, 1.5 * sum / weight / SPECTRUM_LEVELS);
        const step = Math.round(loudness * LINE_STEPS);
        if (step === this._step)
            return;
        this._step = step;
        this.actor.scale_x = LINE_RESTING + (1 - LINE_RESTING) * step / LINE_STEPS;
    }

    clear() {
        this._step = -1;
        this.actor.scale_x = LINE_RESTING;
    }

    // Runs when the line is created or resized, or the palette or theme changes; never per frame.
    _draw(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const fg = this._stops ? null : themeForeground(area);
        const middle = width / 2;
        for (let x = 0; x < width; x += LINE_GRADIENT_STEP) {
            const fromMiddle = middle > 0 ? Math.min(1, Math.abs(x + LINE_GRADIENT_STEP / 2 - middle) / middle) : 0;
            const c = fg ?? gradientColor(this._stops, fromMiddle);
            // Soften the two ends a little, so a long line doesn't stop abruptly.
            const alpha = fromMiddle > 0.9 ? 1 - (fromMiddle - 0.9) * 6 : 1;
            cr.setSourceRGBA(c[0], c[1], c[2], alpha * (fg ? fg[3] : 1));
            cr.rectangle(x, 0, Math.min(LINE_GRADIENT_STEP, width - x), height);
            cr.fill();
        }
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
