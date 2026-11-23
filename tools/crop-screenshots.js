// Cuts the documentation pictures out of the full-screen shots taken by the smoke test.
//   gjs tools/crop-screenshots.js <smoke output dir> <destination dir>
imports.gi.versions.GdkPixbuf = '2.0';
const {GdkPixbuf, GLib} = imports.gi;

const [source, destination] = ARGV;
const [, raw] = GLib.file_get_contents(`${source}/report.json`);
const geometry = JSON.parse(new TextDecoder().decode(raw)).notes.geometry;
const [bx, , bw] = geometry.button.map(Math.round);
const [mx, my, mw, mh] = geometry.menu.map(Math.round);
const panel = Math.round(geometry.panelHeight);

function crop(file, x, y, width, height, scale, name) {
    const shot = GdkPixbuf.Pixbuf.new_from_file(`${source}/${file}`);
    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.min(width, shot.get_width() - x);
    height = Math.min(height, shot.get_height() - y);
    let piece = shot.new_subpixbuf(x, y, width, height);
    if (scale !== 1)
        piece = piece.scale_simple(width * scale, height * scale, GdkPixbuf.InterpType.HYPER);
    piece.savev(`${destination}/${name}`, 'png', [], []);
    print(`${name}: ${width * scale} x ${height * scale}`);
}

// The indicator alone, three times life size, in each palette.
const pad = 10;
crop('bar.png', bx - pad, 0, bw + 2 * pad, panel, 3, 'bar-ember.png');
for (const palette of ['aurora', 'orchid', 'mono'])
    crop(`palette-${palette}.png`, bx - pad, 0, bw + 2 * pad, panel, 3, `bar-${palette}.png`);
// The light strip along the whole top bar, twice life size, and the hover tip under the bars.
{
    const shot = GdkPixbuf.Pixbuf.new_from_file(`${source}/strip.png`);
    crop('strip.png', 0, 0, shot.get_width(), panel + 2, 1, 'strip.png');
    crop('strip.png', bx - 330, 0, 330 + bw + 2 * pad, panel + 2, 3, 'strip-detail.png');
}
if (geometry.tip) {
    const [tx, ty, tw, th] = geometry.tip.map(Math.round);
    const left = Math.min(tx, bx) - 14, right = Math.max(tx + tw, bx + bw) + 14;
    crop('tip.png', left, 0, right - left, ty + th + 14, 2, 'tip.png');
}
// The floating panels on the desktop, twice life size. Each picture was noted together with
// where the panels were in it.
const shots = geometry.shots ?? {};
function cropPanels(shot, name, which) {
    const rects = which.map(key => shots[shot]?.[key]).filter(Boolean);
    if (rects.length === 0)
        return;
    const margin = 14;
    const left = Math.min(...rects.map(r => r[0])) - margin, top = Math.min(...rects.map(r => r[1])) - margin;
    const right = Math.max(...rects.map(r => r[0] + r[2])) + margin, bottom = Math.max(...rects.map(r => r[1] + r[3])) + margin;
    crop(`${shot}.png`, Math.round(left), Math.round(top), Math.round(right - left), Math.round(bottom - top), 2, name);
}
cropPanels('float-rings', 'float-system-rings.png', ['stats']);
cropPanels('float-bars', 'float-system-bars.png', ['stats']);
cropPanels('float-viz-bars', 'float-viz-bars.png', ['viz']);
cropPanels('float-viz-mirror', 'float-viz-mirror.png', ['viz']);
cropPanels('float-viz-wave', 'float-viz-wave.png', ['viz']);
cropPanels('float-both', 'float-both.png', ['stats', 'viz']);

// The open menu with the bar above it, and the settings window.
crop('menu.png', mx - 16, 0, mw + 32, my + mh + 16, 1, 'menu.png');
if (geometry.prefs) {
    const [px, py, pw, ph] = geometry.prefs.map(Math.round);
    crop('prefs.png', px - 20, py - 20, pw + 40, ph + 40, 1, 'settings.png');
}
