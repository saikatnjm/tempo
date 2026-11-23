// ---- floating panels: a system panel and a visualizer panel, anywhere on any display ----------
//
// Each panel is one actor drawn by GNOME Shell (not a separate program). It sits either on the
// desktop, behind windows like a widget, or on top of everything. Drag it to move it. Drag the
// bottom-right corner to zoom it: it keeps its shape and everything in it grows or shrinks
// together (a grip shows the corner on hover). Drag the right or bottom edge to reshape it.
// Its place and size are saved when you let go.
//
// Cost: the panels reuse the readings and sound frames the indicator already has. Nothing is
// polled for them. A ring, meter or label is repainted only when its value changes, and the
// visualizer only while music plays. During a drag, the pointer is held only until release.

const FLOAT_MIN_W = 160;
const FLOAT_MIN_H = 72;
const FLOAT_MARGIN = 24;            // from the screen edge for a panel's first placement
const FLOAT_KEEP_VISIBLE = 48;      // at least this much of a panel stays on some screen
const VIZ_BANDS = 64;               // frequency bands recorded for the visualizer panel (most bars)
const VIZ_BAR_PITCH = 13;           // px per bar plus its gap: a wider panel shows more bars
const VIZ_BAR_GAP = 3;              // px between bars
const VIZ_MIN_BARS = 8;
const VIZ_PEAK_HOLD = 4;            // frames a peak cap waits before it falls
const VIZ_REFLECTION = 0.16;        // share of the "bars" panel's height given to the reflection
const VIZ_REFLECTION_GAP = 2;       // px between the bars and their reflection
const VIZ_REFLECTION_ALPHA = 0.28;  // the reflection's strength just below the bars
const TEMP_RING_MAX_C = 100;        // the temperature ring is full at this many degrees
const FLOAT_EDGE = 16;              // a press this close to the right or bottom edge resizes
const FLOAT_ZOOM_MIN = 0.6;         // text and spacing scale with the panel, within these
const FLOAT_ZOOM_MAX = 4;

/** Reduce `bands` levels to `count` (loudest of each group), for the small bars and the line. */
function reduceLevels(levels, out) {
    const n = levels.length, m = out.length;
    for (let i = 0; i < m; i++) {
        const a = Math.floor(i * n / m), b = Math.max(a + 1, Math.floor((i + 1) * n / m));
        let v = 0;
        for (let k = a; k < b; k++) {
            if (levels[k] > v)
                v = levels[k];
        }
        out[i] = v;
    }
    return out;
}

/** A rounded meter: track plus fill, for the system panel's "bars" design. */
class MeterWidget {
    constructor() {
        this._value = 0;
        this._percent = -1;
        this._color = undefined;
        this.actor = new St.DrawingArea({
            style_class: 'tempo-meter',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
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

    set(value) {
        const v = clamp(value, 0, 1);
        const percent = Math.round(v * 100);
        if (percent === this._percent)
            return;
        this._percent = percent;
        this._value = v;
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = h / 2;
        const fg = themeForeground(area);
        const pill = (width) => {
            cr.newSubPath();
            cr.arc(r, r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(Math.max(r, width - r), r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
        };
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.14);
        pill(w);
        cr.fill();
        if (this._value > 0.005) {
            const c = this._color ? this._color.map(v => v / 255) : fg;
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            pill(Math.max(h, w * this._value));
            cr.fill();
        }
        cr.$dispose();
    }
}

/**
 * The visualizer panel. "bars" and "mirror" are columns of lit segments, like a hardware level
 * meter, coloured from the palette's first colour at the base to its last at the tip, with a cap
 * that marks each bar's recent peak and then falls back. A wider panel gets more bars, a taller
 * one more segments; "bars" also shows a faint reflection underneath.
 *
 * Each bar, with its reflection, is drawn once (when the panel is resized or recoloured). Per
 * frame the graphics card only shows more or less of it and moves the caps, so nothing is redrawn
 * while music plays. "wave" is a smooth curve drawn with cairo, which has to be redrawn each frame
 * and so costs more.
 */
class VizWidget {
    constructor() {
        this._style = null;
        this._stops = null;
        this._count = 0;                         // bars shown, from the panel's width
        this._levels = new Uint8Array(0);
        this._shown = new Int16Array(0);         // segments lit per bar, as last shown
        this._peak = new Int16Array(0);          // each bar's recent peak, in segments
        this._hold = new Uint8Array(0);          // frames the peak stays before it falls
        this._capAt = new Int16Array(0);         // segment each cap is shown at, -1 when hidden
        this._geom = null;
        /** True while a peak cap is still on its way down: settle() once per frame until false. */
        this.settling = false;
        this._mapped = false;                    // on screen right now (not in the overview)
        this._stale = false;                     // levels arrived while it was not
        this.actor = new St.Widget({
            style_class: 'tempo-viz',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        // Bars: positioned by hand, laid out again only when the size changes.
        this._barBox = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true});
        this._bars = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        // The caps live in a layer of their own, above the bars: plain rectangles of one colour
        // drawn one after another are a single batch for the graphics card.
        this._capLayer = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this._barBox.add_child(this._bars);
        this._barBox.add_child(this._capLayer);
        this._barActors = [];
        this._barWidths = [];                    // each bar's width, so no frame has to ask for it
        this._caps = [];                         // per bar: the cap above it
        this._capsBelow = [];                    // per bar: the cap below it ("mirror" only)
        this._coloured = false;
        // Wave: drawn with cairo.
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', area => this._draw(area));
        this.actor.add_child(this._barBox);
        this.actor.add_child(this._area);
        this._layoutId = 0;
        this.actor.connect('notify::allocation', () => this._queueLayout());
        // Off screen (the overview hides the desktop) nothing is updated; catch up on return.
        this.actor.connect('notify::mapped', () => {
            this._mapped = this.actor.mapped;
            if (this._mapped && this._stale)
                this._apply();
        });
        this.actor.connect('destroy', () => {
            if (this._layoutId)
                GLib.source_remove(this._layoutId);
            this._layoutId = 0;
        });
        this.actor._delegate = this;
        this.setStyle('bars');
    }

    // The bars are placed by hand, which must not happen while GNOME Shell is in the middle of
    // laying the screen out (that is when the new size is announced): do it right after.
    _queueLayout() {
        if (this._layoutId)
            return;
        this._layoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._layoutId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    setStyle(style) {
        if (style === this._style)
            return;
        this._style = style;
        const wave = style === 'wave';
        this._barBox.visible = !wave;
        this._area.visible = wave;
        this._geom = null;
        this._layout();
    }

    setPalette(stops) {
        if (stops === this._stops && this._coloured)
            return;                              // the same palette again: nothing to redraw
        this._stops = stops;
        this._coloured = true;
        this._recolor();
        this._area.queue_repaint();
    }

    /** @param {Uint8Array} levels - VIZ_BANDS levels, folded here to the bars shown */
    setLevels(levels) {
        if (this._count === 0)
            return;
        reduceLevels(levels, this._levels);
        this._apply();
    }

    /** One more frame with the same levels: lets the peak caps finish falling. */
    settle() {
        this._apply();
    }

    clear() {
        this._levels.fill(0);
        this._peak.fill(0);
        this._hold.fill(0);
        this._tick = false;                      // so this pass moves the caps too (it hides them)
        this._apply();
    }

    // Colour of segment k of `segments`, base to tip.
    _segmentColor(k, segments) {
        const t = segments > 1 ? k / (segments - 1) : 1;
        return this._stops ? [...gradientColor(this._stops, t), 1] : [0.95, 0.95, 0.97, 0.55 + 0.45 * t];
    }

    _recolor() {
        const n = Math.min(this._count, this._barActors.length);
        for (let i = 0; i < n; i++)
            this._barActors[i].queue_repaint();
        const tip = this._stops ? gradientColor(this._stops, 1) : [1, 1, 1];
        const style = `background-color: rgb(${tip.map(v => Math.round(v * 255)).join(', ')});`;
        for (const cap of [...this._caps, ...this._capsBelow])
            cap.set_style(style);
    }

    _newCap() {
        const cap = new St.Widget({opacity: 0});
        this._capLayer.add_child(cap);
        return cap;
    }

    // How many bars and segments fit, and where they go. Runs only when the size changes.
    _layout() {
        // The size the panel gave this widget (nothing yet before it is on screen).
        const box = this.actor.allocation;
        const w = Math.floor(box.x2 - box.x1), h = Math.floor(box.y2 - box.y1);
        if (!(w > 0 && h > 0))
            return;
        const g = this._geom;
        const count = clamp(Math.floor((w + VIZ_BAR_GAP) / VIZ_BAR_PITCH), VIZ_MIN_BARS, VIZ_BANDS);
        if (count !== this._count) {
            this._count = count;
            this._levels = new Uint8Array(count);
            this._shown = new Int16Array(count);
            this._peak = new Int16Array(count);
            this._hold = new Uint8Array(count);
            this._capAt = new Int16Array(count);
        }
        if (this._style === 'wave') {
            this._area.queue_repaint();
            return;
        }
        if (g && g.w === w && g.h === h && g.count === count && g.style === this._style)
            return;
        const mirror = this._style === 'mirror';
        // "bars": the lower part of the panel holds the reflection.
        const bh = mirror ? h : Math.round(h * (1 - VIZ_REFLECTION));
        // Segment size grows a little with the height, so tall panels keep a fine grid.
        const pitch = clamp(Math.round(bh / 18), 5, 10);
        const gap = pitch >= 8 ? 3 : 2;
        const mid = Math.round(bh / 2);
        const half = Math.floor(gap / 2);
        const segments = mirror ? Math.max(1, Math.floor((mid - half + gap) / pitch)) : Math.max(1, Math.floor((bh + gap) / pitch));
        const unit = (w + VIZ_BAR_GAP) / count;
        this._geom = {w, h, bh, count, style: this._style, pitch, gap, seg: pitch - gap, mirror, mid, half, segments};

        while (this._barActors.length < count) {
            const bar = new St.DrawingArea();
            bar.connect('repaint', area => this._drawBar(area));
            this._bars.add_child(bar);
            this._barActors.push(bar);
            this._caps.push(this._newCap());
            this._capsBelow.push(this._newCap());
        }
        for (const layer of [this._bars, this._capLayer]) {
            layer.set_position(0, 0);
            layer.set_size(w, h);
        }
        this._geom.rh = mirror ? 0 : Math.max(0, h - bh - VIZ_REFLECTION_GAP);
        this._barActors.forEach((bar, i) => {
            const on = i < count;
            bar.visible = on;
            this._caps[i].visible = on;
            this._capsBelow[i].visible = on && mirror;
            if (!on)
                return;
            const x0 = Math.round(i * unit), x1 = Math.round(i * unit + unit - VIZ_BAR_GAP);
            const width = Math.max(1, x1 - x0);
            this._barWidths[i] = width;
            bar.set_position(x0, 0);
            bar.set_size(width, h);
            for (const cap of [this._caps[i], this._capsBelow[i]]) {
                cap.set_position(x0, 0);
                cap.set_size(width, pitch - gap);
                cap.opacity = 0;
            }
        });
        this._recolor();
        this._shown.fill(-1);
        this._capAt.fill(-1);
        this._peak.fill(0);                      // the old peaks were counted in other segments
        this._hold.fill(0);
        this._apply();
    }

    // Per frame: light as many segments as the level asks for (by clipping the drawn bar), and
    // move the caps. Only what changed is touched.
    _apply() {
        if (!this._mapped) {
            this._stale = true;
            return;
        }
        this._stale = false;
        if (this._style === 'wave') {
            this.settling = false;
            this._area.queue_repaint();
            return;
        }
        const g = this._geom;
        if (!g)
            return;
        this._tick = !this._tick;
        let settling = false;
        for (let i = 0; i < g.count; i++) {
            const lit = Math.max(1, Math.round(this._levels[i] / SPECTRUM_LEVELS * g.segments));
            const bar = this._barActors[i];
            if (lit !== this._shown[i]) {
                this._shown[i] = lit;
                if (g.mirror) {
                    const top = g.mid - g.half - (lit - 1) * g.pitch - g.seg;
                    const bottom = g.mid + (g.gap - g.half) + (lit - 1) * g.pitch + g.seg;
                    bar.set_clip(0, top, this._barWidths[i], bottom - top);
                } else {
                    // The lit segments and, right below, their reflection: one rectangle.
                    const up = lit * g.pitch;
                    const down = g.rh > 0 ? VIZ_REFLECTION_GAP + Math.min(up, g.rh) : 0;
                    bar.set_clip(0, g.bh - up, this._barWidths[i], up + down);
                }
            }

            // The peak jumps up with the bar, waits a moment, then falls a segment at a time, on
            // every other frame only: half as many changes to show as the bars.
            if (lit >= this._peak[i]) {
                this._peak[i] = lit;
                this._hold[i] = VIZ_PEAK_HOLD;
            } else if (this._hold[i] > 0) {
                this._hold[i]--;
            } else if (this._tick) {
                this._peak[i] = Math.max(lit, this._peak[i] - 1);
            }
            // The cap sits on the segment just above the peak; none while the bar rests.
            const at = this._peak[i] > 1 ? Math.min(this._peak[i], g.segments - 1) : -1;
            if (this._peak[i] > lit || at !== this._capAt[i])
                settling = true;                 // this cap has further to go
            // Up with its bar at once (or the bar would swallow it); down on the slower beat.
            if (at === this._capAt[i] || (at < this._capAt[i] && !this._tick))
                continue;
            this._capAt[i] = at;
            const cap = this._caps[i], below = this._capsBelow[i];
            cap.opacity = at < 0 ? 0 : 255;
            if (g.mirror) {
                below.opacity = cap.opacity;
                if (at >= 0) {
                    cap.translation_y = g.mid - g.half - at * g.pitch - g.seg;
                    below.translation_y = g.mid + (g.gap - g.half) + at * g.pitch;
                }
            } else if (at >= 0) {
                cap.translation_y = g.bh - at * g.pitch - g.seg;
            }
        }
        this.settling = settling;
    }

    // Every segment of one bar, coloured base to tip, and its reflection fading out below.
    _drawBar(area) {
        const cr = area.get_context();
        const g = this._geom;
        if (g) {
            const [width] = area.get_surface_size();
            for (let k = 0; k < g.segments; k++) {
                const c = this._segmentColor(k, g.segments);
                cr.setSourceRGBA(c[0], c[1], c[2], c[3]);
                if (g.mirror) {
                    cr.rectangle(0, g.mid - g.half - k * g.pitch - g.seg, width, g.seg);
                    cr.rectangle(0, g.mid + (g.gap - g.half) + k * g.pitch, width, g.seg);
                } else {
                    cr.rectangle(0, g.bh - k * g.pitch - g.seg, width, g.seg);
                }
                cr.fill();
                const y = g.bh + VIZ_REFLECTION_GAP + k * g.pitch;
                if (g.rh > 0 && y < g.bh + VIZ_REFLECTION_GAP + g.rh) {
                    const fade = 1 - (y - g.bh) / (g.rh + VIZ_REFLECTION_GAP);
                    cr.setSourceRGBA(c[0], c[1], c[2], c[3] * VIZ_REFLECTION_ALPHA * fade);
                    cr.rectangle(0, y, width, Math.min(g.seg, g.bh + VIZ_REFLECTION_GAP + g.rh - y));
                    cr.fill();
                }
            }
        }
        cr.$dispose();
    }

    _color(t, fg) {
        return this._stops ? gradientColor(this._stops, t) : fg;
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const n = this._count;
        if (n < 2) {
            cr.$dispose();
            return;
        }
        const fg = this._stops ? null : themeForeground(area);
        const level = i => this._levels[i] / SPECTRUM_LEVELS;

        // A smooth curve through the band heights, filled softly, with a crisp edge. The curve
        // is built once per frame and reused for every colour slice.
        const xs = this._waveX ??= new Float64Array(VIZ_BANDS), ys = this._waveY ??= new Float64Array(VIZ_BANDS);
        for (let i = 0; i < n; i++) {
            xs[i] = i * w / (n - 1);
            ys[i] = h - Math.max(2, level(i) * h * 0.92);
        }
        cr.moveTo(xs[0], ys[0]);
        for (let i = 0; i < n - 1; i++) {
            const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 2);
            cr.curveTo(xs[i] + (xs[i + 1] - xs[a]) / 6, ys[i] + (ys[i + 1] - ys[a]) / 6,
                xs[i + 1] - (xs[b] - xs[i]) / 6, ys[i + 1] - (ys[b] - ys[i]) / 6, xs[i + 1], ys[i + 1]);
        }
        const edge = cr.copyPath();
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();
        const body = cr.copyPath();
        cr.newPath();
        // fill in vertical slices of the gradient, so no cairo gradient import is needed
        const slices = 12;
        cr.setLineWidth(Math.max(2, h * 0.02));
        for (let s = 0; s < slices; s++) {
            const c = this._color(s / (slices - 1), fg);
            // whole-pixel slice edges: no overlap, so no visible seams
            const x0 = Math.floor(s * w / slices), x1 = s === slices - 1 ? w : Math.floor((s + 1) * w / slices);
            cr.save();
            cr.rectangle(x0, 0, x1 - x0, h);
            cr.clip();
            cr.appendPath(body);
            cr.setSourceRGBA(c[0], c[1], c[2], 0.28);
            cr.fill();
            cr.appendPath(edge);
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            cr.stroke();
            cr.restore();
        }
        cr.$dispose();
    }
}

/**
 * A small fan that turns while the real fan does, faster as it speeds up. The blades are drawn
 * once; after that the graphics card only rotates them, a few steps a second, and only while the
 * fan is turning.
 */
const FAN_STEP_MS = 200;            // 5 steps a second: each step is a repaint of the screen
const FAN_BLADES = 5;

class FanWidget {
    constructor(styleClass) {
        this._rpm = 0;
        this._timer = 0;
        this._paused = false;
        this._angle = 0;
        this._color = undefined;
        this.actor = new St.DrawingArea({style_class: styleClass, x_expand: true, y_expand: true});
        this.actor.set_pivot_point(0.5, 0.5);
        this.actor.connect('repaint', area => this._draw(area));
        this.actor._delegate = this;
        this.actor.connect('destroy', () => this._stop());
        // No turning where nobody sees it (the overview hides the desktop; a fullscreen window
        // hides a panel that sits on top).
        this.actor.connect('notify::mapped', () => this._sync());
    }

    /** @param {number[]|null} rgb - [r, g, b] 0..255, or null to use the text colour */
    setColor(rgb) {
        if (sameColor(rgb, this._color))
            return;
        this._color = rgb;
        this.actor.queue_repaint();
    }

    setRpm(rpm) {
        this._rpm = rpm;
        this._sync();
    }

    /** Stand still whatever the real fan does (while the screens are off). */
    setPaused(paused) {
        this._paused = paused;
        this._sync();
    }

    _sync() {
        const turning = this._rpm > 0 && !this._paused && this.actor.mapped;
        if (turning && !this._timer) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, FAN_STEP_MS, () => {
                // At most 40 % of the gap between blades, so the eye never sees it turning backwards.
                const step = 360 / FAN_BLADES * 0.4 * clamp(this._rpm / 6000, 0.15, 1);
                this._angle = (this._angle + step) % 360;
                this.actor.rotation_angle_z = this._angle;
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!turning) {
            this._stop();
        }
    }

    _stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const size = Math.min(w, h);
        const cx = w / 2, cy = h / 2, r = size / 2 - 1;
        const fg = themeForeground(area);
        const c = this._color ? this._color.map(v => v / 255) : fg;
        // housing ring
        cr.setLineWidth(Math.max(1.5, size * 0.05));
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.2);
        cr.arc(cx, cy, r - size * 0.03, 0, 2 * Math.PI);
        cr.stroke();
        // curved blades
        cr.setSourceRGBA(c[0], c[1], c[2], 1);
        for (let b = 0; b < FAN_BLADES; b++) {
            const a = b * 2 * Math.PI / FAN_BLADES;
            const rot = (x, y) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)];
            // a swept blade: leading edge curves out, trailing edge comes back in
            const R = r * 0.84, hub = r * 0.24;
            const p0 = rot(hub, -hub * 0.25);
            const c1 = rot(R * 0.45, -R * 0.42), c2 = rot(R * 0.92, -R * 0.28), tip = rot(R, R * 0.02);
            const c3 = rot(R * 0.82, R * 0.16), c4 = rot(R * 0.42, R * 0.1), p1 = rot(hub, hub * 0.3);
            cr.moveTo(...p0);
            cr.curveTo(...c1, ...c2, ...tip);
            cr.curveTo(...c3, ...c4, ...p1);
            cr.closePath();
            cr.fill();
        }
        // hub
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.92);
        cr.arc(cx, cy, r * 0.2, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(c[0], c[1], c[2], 1);
        cr.arc(cx, cy, r * 0.08, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
}

/**
 * A movable, resizable panel. `content` is any actor; `settings` + `rectKey` store x, y, w, h.
 */
class FloatPanel {
    constructor({name, content, settings, rectKey, defaultSize}) {
        this._settings = settings;
        this._rectKey = rectKey;
        this._defaultSize = defaultSize;
        this._layer = null;
        this._drag = null;
        this._grab = null;
        this._look = null;
        this._zoom = 1;

        this.actor = new St.Widget({
            style_class: 'tempo-float',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            accessible_name: name,
        });
        this.actor._delegate = this;
        content.x_expand = true;
        content.y_expand = true;
        this.actor.add_child(content);
        // Only a hint: resizing is decided by where the press lands (see _onPress).
        this._grip = new St.Widget({
            style_class: 'tempo-float-grip',
            reactive: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        this.actor.add_child(this._grip);
        this.actor.connect('notify::hover', () => {
            this._grip.remove_all_transitions();
            this._grip.ease({opacity: this.actor.hover || this._drag ? 255 : 0, duration: 150});
        });
        this.actor.connect('button-press-event', (_a, event) => this._onPress(event));
        this._dragIds = [];
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        // The saved place can also be changed from outside (a reset in dconf, for a lost panel).
        this._rectId = settings.connect(`changed::${rectKey}`, () => {
            if (this._drag === null && this._layer !== null)
                this._place();
        });
    }

    destroy() {
        this._endDrag(false);
        this._settings.disconnect(this._rectId);
        Main.layoutManager.disconnect(this._monitorsId);
        this._detach();
        this.actor.destroy();
    }

    setLook(background) {
        if (background === this._look)
            return;                              // the same look again: nothing to restyle
        if (this._look)
            this.actor.remove_style_class_name(`tempo-float-${this._look}`);
        this._look = background;
        this.actor.add_style_class_name(`tempo-float-${background}`);
    }

    /** "desktop": behind windows, like a widget. "top": above everything. */
    setLayer(layer) {
        if (layer === this._layer)
            return;
        this._detach();
        this._layer = layer;
        if (layer === 'top') {
            Main.layoutManager.addChrome(this.actor, {trackFullscreen: true});
        } else {
            // The wallpaper's own group: always below every window. GNOME keeps the wallpaper
            // itself at the bottom of it, so new wallpapers never cover the panel.
            Main.layoutManager._backgroundGroup.add_child(this.actor);
        }
        this._place();
    }

    _detach() {
        const parent = this.actor.get_parent();
        if (parent === null)
            return;
        if (this._layer === 'top')
            Main.layoutManager.removeChrome(this.actor);
        else
            parent.remove_child(this.actor);
    }

    // Put the panel where it was saved, kept within the screens.
    _place() {
        const [x, y, w, h] = this._settings.get_value(this._rectKey).deep_unpack();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        // Never placed yet is told by the size (the default is [-1, -1, 0, 0]), not by the
        // position: a panel tucked into a top-left corner has a negative position of its own.
        const placed = w > 0 && h > 0;
        const width = Math.max(FLOAT_MIN_W, placed ? w : this._defaultSize[0]);
        const height = Math.max(FLOAT_MIN_H, placed ? h : this._defaultSize[1]);
        let px = x, py = y;
        if (!placed) {
            const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            px = area.x + area.width - width - FLOAT_MARGIN;
            py = area.y + area.height - height - FLOAT_MARGIN - (this._rectKey === 'float-viz-rect' ? height + 16 : 0);
        }
        [px, py] = this._keepVisible(px, py, width, height);
        this.actor.set_position(px, py);
        this._setSize(width, height);
    }

    // Size the panel, and scale its text and spacing (all in em) to the size, so a bigger panel
    // shows bigger rings and bigger text rather than more empty space.
    _setSize(width, height) {
        this.actor.set_size(Math.round(width), Math.round(height));
        const [dw, dh] = this._defaultSize;
        const zoom = Math.round(clamp(Math.min(width / dw, height / dh), FLOAT_ZOOM_MIN, FLOAT_ZOOM_MAX) * 50) / 50;
        if (zoom === this._zoom)
            return;
        this._zoom = zoom;
        this.actor.style = zoom === 1 ? null : `font-size: ${zoom}em;`;
    }

    _keepVisible(x, y, w, h) {
        const monitors = Main.layoutManager.monitors;
        const visible = monitors.some(m =>
            x + w - FLOAT_KEEP_VISIBLE >= m.x && x + FLOAT_KEEP_VISIBLE <= m.x + m.width &&
            y + FLOAT_KEEP_VISIBLE / 2 >= m.y && y + FLOAT_KEEP_VISIBLE <= m.y + m.height);
        if (visible || monitors.length === 0)
            return [Math.round(x), Math.round(y)];
        const m = Main.layoutManager.primaryMonitor;
        return [Math.round(clamp(x, m.x, m.x + m.width - w)), Math.round(clamp(y, m.y, m.y + m.height - h))];
    }

    _onPress(event) {
        if (event.get_button() !== 1 || this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        // Near the right edge: wider; near the bottom edge: taller; in the corner: both, keeping
        // the panel's shape.
        const [, lx, ly] = this.actor.transform_stage_point(px, py);
        const right = lx >= this.actor.width - FLOAT_EDGE;
        const bottom = ly >= this.actor.height - FLOAT_EDGE;
        this._drag = {
            resize: right || bottom,
            corner: right && bottom,
            right,
            bottom,
            px, py,
            x: this.actor.x, y: this.actor.y,
            w: this.actor.width, h: this.actor.height,
        };
        this.actor.add_style_pseudo_class('active');
        // Hold the pointer for as long as the button is down: every move and the release then
        // come here, also when the pointer passes over a window on the way. The two handlers
        // exist only during a drag, so pointer moves over a resting panel cost nothing.
        this._grab = global.stage.grab(this.actor);
        this._dragIds = [
            this.actor.connect('motion-event', (_a, e) => this._onMotion(e)),
            this.actor.connect('button-release-event', (_a, e) => this._onRelease(e)),
        ];
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        // If the release went missing (another part of the desktop took the pointer for a while),
        // a move without the button held ends the drag, rather than the panel following on.
        if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
            this._endDrag(true);
            return Clutter.EVENT_PROPAGATE;
        }
        const [px, py] = event.get_coords();
        if (d.corner) {
            // The pointer's move along the panel's diagonal sets one scale for both sides.
            let s = ((d.w + px - d.px) * d.w + (d.h + py - d.py) * d.h) / (d.w * d.w + d.h * d.h);
            s = Math.max(s, FLOAT_MIN_W / d.w, FLOAT_MIN_H / d.h);
            this._setSize(d.w * s, d.h * s);
        } else if (d.resize) {
            this._setSize(
                d.right ? Math.max(FLOAT_MIN_W, d.w + px - d.px) : d.w,
                d.bottom ? Math.max(FLOAT_MIN_H, d.h + py - d.py) : d.h);
        } else {
            this.actor.set_position(Math.round(d.x + px - d.px), Math.round(d.y + py - d.py));
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._drag || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag(true);
        return Clutter.EVENT_STOP;
    }

    _endDrag(save) {
        for (const id of this._dragIds)
            this.actor.disconnect(id);
        this._dragIds = [];
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
        if (!this._drag)
            return;
        this._drag = null;
        this.actor.remove_style_pseudo_class('active');
        if (!save)
            return;
        const [x, y] = this._keepVisible(this.actor.x, this.actor.y, this.actor.width, this.actor.height);
        this.actor.set_position(x, y);
        this._settings.set_value(this._rectKey, new GLib.Variant('ai',
            [x, y, Math.round(this.actor.width), Math.round(this.actor.height)]));
    }
}

/** System panel: processor, memory, temperature and network, as rings or as meters. */
class StatsPanel {
    constructor(settings) {
        this._withFan = false;
        this._design = null;
        this._paused = false;
        this.content = new St.BoxLayout({style_class: 'tempo-float-content'});
        this.content.layout_manager.orientation = Clutter.Orientation.VERTICAL;
        this.panel = new FloatPanel({
            name: 'Tempo system panel',
            content: this.content,
            settings,
            rectKey: 'float-stats-rect',
            defaultSize: [400, 150],
        });
    }

    destroy() {
        this.panel.destroy();
    }

    /**
     * Build the chosen design.
     * @param {string} design - "rings" or "bars"
     * @param {object|null} palette
     * @param {boolean} withFan - show the fan (only when the computer reports one)
     * @returns {boolean} true when everything was built anew and has no values yet
     */
    setDesign(design, palette, withFan) {
        if (design === this._design && withFan === this._withFan) {
            this._applyPalette(palette);
            return false;
        }
        this._design = design;
        this._withFan = withFan;
        this.content.destroy_all_children();
        this._items = {};
        const keys = [['cpu', _('Processor')], ['memory', _('Memory')], ['temperature', _('Temperature')]];
        if (design === 'rings') {
            const row = new St.BoxLayout({style_class: 'tempo-float-rings', x_expand: true, y_expand: true});
            row.layout_manager.homogeneous = true;         // equal columns, so equal rings
            for (const [key, title] of keys) {
                const cell = new St.BoxLayout({x_expand: true, y_expand: true, style_class: 'tempo-float-cell'});
                cell.layout_manager.orientation = Clutter.Orientation.VERTICAL;
                const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
                const ring = new RingWidget({styleClass: 'tempo-float-ring', expand: true});
                ring.setThin(true);
                const value = new St.Label({
                    text: '–',
                    style_class: 'tempo-float-value',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                stack.add_child(ring.actor);
                stack.add_child(value);
                cell.add_child(stack);
                cell.add_child(new St.Label({text: title, style_class: 'tempo-float-caption', x_align: Clutter.ActorAlign.CENTER}));
                row.add_child(cell);
                this._items[key] = {gauge: ring, value};
            }
            if (withFan) {
                const cell = new St.BoxLayout({x_expand: true, y_expand: true, style_class: 'tempo-float-cell'});
                cell.layout_manager.orientation = Clutter.Orientation.VERTICAL;
                const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
                this._fan = new FanWidget('tempo-float-ring');
                stack.add_child(this._fan.actor);
                cell.add_child(stack);
                this._fanValue = new St.Label({text: '–', style_class: 'tempo-float-caption', x_align: Clutter.ActorAlign.CENTER});
                cell.add_child(this._fanValue);
                row.add_child(cell);
            }
            this.content.add_child(row);
        } else {
            for (const [key, title] of keys) {
                const line = new St.BoxLayout({style_class: 'tempo-float-line', x_expand: true, y_expand: true});
                line.add_child(new St.Label({text: title, style_class: 'tempo-float-caption tempo-float-name', y_align: Clutter.ActorAlign.CENTER}));
                const meter = new MeterWidget();
                line.add_child(meter.actor);
                const value = new St.Label({text: '–', style_class: 'tempo-float-value tempo-float-number', y_align: Clutter.ActorAlign.CENTER});
                line.add_child(value);
                this.content.add_child(line);
                this._items[key] = {gauge: meter, value};
            }
            if (withFan) {
                const line = new St.BoxLayout({style_class: 'tempo-float-line', x_expand: true, y_expand: true});
                line.add_child(new St.Label({text: _('Fan'), style_class: 'tempo-float-caption tempo-float-name', y_align: Clutter.ActorAlign.CENTER}));
                const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'tempo-float-fan-small', y_align: Clutter.ActorAlign.CENTER});
                this._fan = new FanWidget('tempo-float-fan-small');
                holder.add_child(this._fan.actor);
                line.add_child(holder);
                line.add_child(new St.Widget({x_expand: true}));
                this._fanValue = new St.Label({text: '–', style_class: 'tempo-float-value tempo-float-number', y_align: Clutter.ActorAlign.CENTER});
                line.add_child(this._fanValue);
                this.content.add_child(line);
            }
        }
        // The fan mode, when the fan service is installed: shown, not changed, here.
        this._fanMode = new St.Label({
            style_class: 'tempo-float-mode',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._net = new St.Label({text: '', style_class: 'tempo-float-net', x_align: Clutter.ActorAlign.CENTER});
        const footer = new St.BoxLayout({style_class: 'tempo-float-footer', x_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._net);
        footer.add_child(this._fanMode);
        this.content.add_child(footer);
        if (!withFan)
            this._fan = this._fanValue = null;
        this._fan?.setPaused(this._paused);
        this._applyPalette(palette);
        return true;
    }

    /** No animation while paused (the screens are off). */
    setPaused(paused) {
        this._paused = paused;
        this._fan?.setPaused(paused);
    }

    _applyPalette(palette) {
        this._palette = palette;
        if (!this._items)
            return;
        this._items.cpu.gauge.setColor(palette ? palette.cpu : null);
        this._items.memory.gauge.setColor(palette ? palette.memory : null);
        this._fan?.setColor(palette ? palette.bars[1] : null);
        this._tempColor();
    }

    /** @param {number|null} rpm - null when no reading */
    setFan(rpm) {
        if (!this._fan)
            return;
        this._fan.setRpm(rpm ?? 0);
        if (this._design === 'rings')
            setLabel(this._fanValue, rpm === null ? _('Fan') : rpm === 0 ? _('Fan stopped') : `${rpm} RPM`);
        else
            setLabel(this._fanValue, rpm === null ? '–' : rpm === 0 ? _('Stopped') : `${rpm}`);
    }

    /** @param {string|null} name - shown mode, or null when the fan service isn't installed */
    setFanMode(name) {
        this._fanMode.visible = name !== null;
        if (name !== null)
            setLabel(this._fanMode, `${_('Fan')}: ${name}`);
    }

    _tempColor() {
        const c = this._celsius;
        const rgb = c >= TEMP_HOT_C ? [255, 69, 58] : c >= TEMP_WARM_C ? [255, 214, 10]
            : this._palette ? this._palette.bars[0] : null;
        this._items.temperature.gauge.setColor(rgb);
    }

    setCpu(share) {
        this._items.cpu.gauge.set(share);
        setLabel(this._items.cpu.value, `${Math.round(share * 100)}%`);
    }

    setMemory(share) {
        this._items.memory.gauge.set(share);
        setLabel(this._items.memory.value, `${Math.round(share * 100)}%`);
    }

    setTemperature(celsius, fahrenheit) {
        this._celsius = celsius;
        this._items.temperature.gauge.set(celsius / TEMP_RING_MAX_C);
        setLabel(this._items.temperature.value, formatTemperature(celsius, fahrenheit, false));
        this._tempColor();
    }

    setNetwork(down, up) {
        setLabel(this._net, `↓ ${formatRateLong(down)}    ↑ ${formatRateLong(up)}`);
    }
}
