// ---- Tempo smoke-test probe ------------------------------------------------------------------
//
// A second, test-only extension. It waits for Tempo to load inside a throwaway GNOME Shell,
// pokes every feature (settings, menu, palettes, music bars, disable/enable, preferences),
// saves screenshots and a JSON report into $TEMPO_PROBE_OUT, then quits the shell.
// tests/smoke/run.sh starts the shell and reads the report. It is never installed for users.
//
// The header supplies: Gio, GLib, Shell, St, Main, Config.

const TEMPO_UUID = 'tempo@saikatnjm.github.io';
const TEMPO_SCHEMA = 'org.gnome.shell.extensions.tempo';
const STATE_ACTIVE = 1;          // ExtensionState.ENABLED (called ACTIVE since GNOME 46)

function probeSleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function probeScreenshot(path) {
    return new Promise(resolve => {
        try {
            const stream = Gio.File.new_for_path(path).replace(null, false,
                Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot(false, stream, (shot, result) => {
                let ok = false;
                try {
                    shot.screenshot_finish(result);
                    stream.close(null);
                    ok = true;
                } catch (e) {
                    log(`tempo-probe: screenshot failed: ${e}`);
                }
                resolve(ok);
            });
        } catch (e) {
            log(`tempo-probe: screenshot failed: ${e}`);
            resolve(false);
        }
    });
}

class TempoProbe {
    constructor() {
        this._out = GLib.getenv('TEMPO_PROBE_OUT') || GLib.get_tmp_dir();
        this._audio = GLib.getenv('TEMPO_PROBE_AUDIO') === '1';
        this._report = {shell: Config.PACKAGE_VERSION, audio: this._audio, checks: [], notes: {}};
    }

    start() {
        this._run().catch(e => {
            this._check('probe ran to the end', false, `${e}\n${e.stack ?? ''}`);
        }).then(() => this._finish());
    }

    _check(name, ok, detail) {
        this._report.checks.push({name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail)});
    }

    _tempo() {
        return Main.extensionManager.lookup(TEMPO_UUID);
    }

    _button() {
        return Main.panel.statusArea[TEMPO_UUID] ?? null;
    }

    // The visible parts of the top-bar button, found by style class.
    _parts() {
        const button = this._button();
        const parts = {};
        if (button === null)
            return parts;
        const box = button.get_first_child();
        for (const child of box.get_children()) {
            let key = null;
            if (child.has_style_class_name('tempo-bars'))
                key = 'bars';
            else if (child.has_style_class_name('tempo-ring'))
                key = parts.cpu === undefined ? 'cpu' : 'memory';
            else if (child.has_style_class_name('tempo-temp'))
                key = 'temperature';
            else if (child.has_style_class_name('tempo-net'))
                key = 'network';
            else if (child instanceof St.Icon)
                key = 'icon';
            if (key !== null) {
                parts[key] = {
                    visible: child.visible,
                    text: key === 'network' ? this._labelTexts(child).join('') : child.text ?? null,
                    width: child.width,
                    height: child.height,
                };
            }
        }
        return parts;
    }

    // Actors Tempo adds outside its button (the level line, the hover tip), by style class.
    _chrome(styleClass) {
        return Main.uiGroup.get_children().find(a => a.has_style_class_name?.(styleClass)) ?? null;
    }

    _labelTexts(actor) {
        const texts = [];
        const collect = a => {
            if (a instanceof St.Label && a.text && a.visible)
                texts.push(a.text);
            for (const child of a.get_children())
                collect(child);
        };
        collect(actor);
        return texts;
    }

    _menuRows() {
        const rows = [];
        for (const item of this._button().menu._getMenuItems()) {
            const texts = [];
            const collect = actor => {
                if (actor instanceof St.Label && actor.text)
                    texts.push(actor.text);
                for (const child of actor.get_children())
                    collect(child);
            };
            collect(item);
            if (item.visible && texts.length > 0)
                rows.push(texts);
        }
        return rows;
    }

    // Benchmark mode (tools/bench.sh): instead of checking features, measure how much processor
    // time this GNOME Shell uses in each state. Nothing else runs in the test session, so the
    // differences between the states are Tempo's own cost.
    async _bench(settings) {
        const ticks = () => {
            const [, bytes] = GLib.file_get_contents('/proc/self/stat');
            const text = new TextDecoder().decode(bytes);
            const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
            return Number(f[11]) + Number(f[12]);
        };
        const seconds = Number(GLib.getenv('TEMPO_BENCH_SECONDS') || 20);
        const readings = ['show-cpu', 'show-memory', 'show-temperature', 'show-network'];
        const states = [
            ['everything off', false, false, 'bars', 12],
            ['rings, temperature, network', true, false, 'bars', 12],
            ['readings + small bars at 8 fps', true, true, 'bars', 8],
            ['readings + small bars at 12 fps', true, true, 'bars', 12],
            ['readings + small bars at 20 fps', true, true, 'bars', 20],
            ['readings + level line at 8 fps', true, true, 'strip', 8],
            ['readings + level line at 12 fps', true, true, 'strip', 12],
            // Where does the bars' cost go? The same again with the drawing switched off, which
            // leaves only the listening and the maths.
            ['readings + small bars at 12 fps, not drawn', true, true, 'bars', 12, true],
        ];
        this._report.bench = [];
        const barsActor = this._button().get_first_child().get_children().find(c => c.has_style_class_name('tempo-bars'));
        for (const [name, showReadings, music, style, fps, notDrawn] of states) {
            if (notDrawn)
                barsActor.queue_repaint = () => {};
            for (const key of readings)
                settings.set_boolean(key, showReadings);
            settings.set_int('music-fps', fps);
            settings.set_string('music-style', style);
            settings.set_boolean('music-visuals', music);
            await probeSleep(5000);
            const before = ticks();
            await probeSleep(seconds * 1000);
            this._report.bench.push({name, percent: (ticks() - before) / seconds});
            if (notDrawn)
                delete barsActor.queue_repaint;
        }
        this._check('benchmark finished', true);
    }

    async _run() {
        await probeSleep(3500);
        const ext = this._tempo();
        this._check('Tempo was found by the shell', ext !== undefined && ext !== null);
        if (!ext)
            return;
        this._check('Tempo is active', ext.state === STATE_ACTIVE, `state ${ext.state}, error: ${ext.error ?? ''}`);
        this._check('Tempo reported no error', !ext.error, ext.error ?? '');
        this._check('the top-bar button exists', this._button() !== null);
        if (this._button() === null)
            return;

        const source = Gio.SettingsSchemaSource.new_from_directory(
            ext.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const settings = new Gio.Settings({settings_schema: source.lookup(TEMPO_SCHEMA, false)});
        if (GLib.getenv('TEMPO_PROBE_MODE') === 'bench') {
            await this._bench(settings);
            return;
        }

        // Defaults: rings and temperature on, network and music off.
        let parts = this._parts();
        this._report.notes.defaults = parts;
        this._check('default: processor ring shown', parts.cpu?.visible === true);
        this._check('default: memory ring shown', parts.memory?.visible === true);
        this._check('default: network speed hidden', parts.network?.visible === false);
        this._check('default: music bars hidden', parts.bars?.visible === false);
        this._check('default: fallback icon hidden', parts.icon?.visible === false);
        this._check('rings have a size', parts.cpu?.width > 0 && parts.cpu?.height > 0, `${parts.cpu?.width}x${parts.cpu?.height}`);

        // Switch everything on.
        settings.set_boolean('show-network', true);
        settings.set_boolean('music-visuals', true);
        await probeSleep(5000);
        parts = this._parts();
        this._report.notes.everythingOn = parts;
        this._check('network speed appears when switched on', parts.network?.visible === true);
        this._check('network speed reads like "↓0K↑0K"', /^↓[\d.]+[KMG]↑[\d.]+[KMG]$/.test(parts.network?.text ?? ''), parts.network?.text);
        await probeScreenshot(`${this._out}/bar.png`);
        this._report.notes.geometry = {
            button: [...this._button().get_transformed_position(), ...this._button().get_transformed_size()],
            panelHeight: Main.panel.height,
        };
        {
            // The network part must keep its width whatever the numbers are.
            const net = this._button().get_first_child().get_children().find(c => c.has_style_class_name('tempo-net'));
            const values = [];
            const collect = a => {
                if (a instanceof St.Label && a.has_style_class_name('tempo-net-value'))
                    values.push(a);
                for (const child of a.get_children())
                    collect(child);
            };
            collect(net);
            const widths = [];
            for (const texts of [['0K', '0K'], ['999K', '9.9M'], ['888M', '1.5G'], ['7K', '88K'], ['444K', '000G']]) {
                values[0].text = texts[0];
                values[1].text = texts[1];
                await probeSleep(150);
                widths.push(net.width);
            }
            this._check('network speed keeps the same width for any value', values.length === 2 && widths.every(w => w === widths[0] && w > 0), JSON.stringify(widths));
        }
        if (parts.temperature?.visible)
            this._check('temperature reads like "52°"', /^-?\d+°$/.test(parts.temperature.text ?? ''), parts.temperature.text);
        else
            this._report.notes.temperature = 'no readable sensor here';
        if (this._audio) {
            this._check('music bars appear while a player is playing', parts.bars?.visible === true);
            this._check('music bars have a size', parts.bars?.width > 0, parts.bars?.width);
        } else {
            this._check('music bars stay hidden without sound', parts.bars?.visible === false);
        }

        // The menu.
        this._button().menu.open();
        await probeSleep(4500);
        const rows = this._menuRows();
        this._report.notes.menu = rows;
        const value = title => (rows.find(r => r[0] === title) ?? [])[1] ?? '';
        this._check('menu: processor usage', /^\d+%( {2}· {2}[\d.]+ GHz)?$/.test(value('Usage')), value('Usage'));
        this._check('menu: load average', /^[\d.]+ {2}[\d.]+ {2}[\d.]+$/.test(value('Load average')), value('Load average'));
        this._check('menu: memory in use', /^[\d.]+ GiB \/ [\d.]+ GiB$/.test(value('In use')), value('In use'));
        this._check('menu: network speed', /^↓ [\d.]+ [KMG]iB\/s {3}↑ [\d.]+ [KMG]iB\/s$/.test(value('Speed')), value('Speed'));
        {
            // The whole menu must fit on a small laptop screen; the test screen is 1366 x 768.
            const menu = this._button().menu.actor;
            const bottom = menu.get_transformed_position()[1] + menu.get_transformed_size()[1];
            const screen = Main.layoutManager.primaryMonitor.height;
            this._report.notes.menuBottom = `${Math.round(bottom)} of ${screen}`;
            this._check('menu: fits on a small laptop screen', bottom <= screen, `bottom edge at ${Math.round(bottom)} on a ${screen}-pixel-high screen`);
        }
        const heading = rows.findIndex(r => r[0] === 'Busiest apps');
        const firstApp = heading >= 0 ? rows[heading + 1] : undefined;
        this._check('menu: busiest apps are listed', firstApp !== undefined && firstApp.length === 2 && /^[\d.]+%$/.test(firstApp[1]),
            JSON.stringify(firstApp));
        const song = rows.find(r => r[0] === 'Test Song');
        this._check('menu: now playing shows the song', song !== undefined, JSON.stringify(rows.slice(0, 3)));
        this._check('menu: now playing names the app and the artist', song?.[1] === 'Tempo Test Player · Test Artist', song?.[1]);
        this._check('menu: music switch present', rows.some(r => r[0] === 'Music visuals'));
        {
            // Fan mode: shown because the stand-in mode file exists; choosing writes it.
            const items = this._button().menu._getMenuItems();
            const fanMode = items.find(i => i.label?.text?.startsWith('Fan mode'));
            this._check('fan mode: shown when the fan service is installed', fanMode?.visible === true, fanMode?.label?.text);
            this._check('fan mode: shows the current mode', fanMode?.label?.text === 'Fan mode: Cool', fanMode?.label?.text);
            const full = fanMode?.menu._getMenuItems().find(i => i.label?.text === 'Full speed');
            full?.activate(null);
            await probeSleep(600);
            const path = GLib.getenv('TEMPO_FAN_MODE');
            const [, bytes] = GLib.file_get_contents(path);
            this._check('fan mode: choosing Full speed writes it', new TextDecoder().decode(bytes).trim() === 'max');
            this._check('fan mode: the label follows', fanMode?.label?.text === 'Fan mode: Full speed', fanMode?.label?.text);
            fanMode?.menu._getMenuItems().find(i => i.label?.text?.startsWith('Cool'))?.activate(null);
            await probeSleep(400);
            // Choosing an item closes the menu, as in any GNOME menu: open it again.
            this._button().menu.open();
            await probeSleep(2500);
        }
        this._check('menu: settings entry present', rows.some(r => r[0] === 'Settings'));
        const pinned = [];
        if (GLib.getenv('TEMPO_SMOKE_STYLE') === 'docs') {
            // For the documentation pictures only: the busiest-apps list would otherwise show
            // whatever happens to be running on the machine that takes the pictures. The names
            // are held in place until the picture is taken; the percentages stay real.
            const items = this._button().menu._getMenuItems();
            const first = items.findIndex(i => this._labelTexts(i)[0] === 'Busiest apps') + 1;
            ['firefox', 'gnome-shell', 'nautilus', 'pulseaudio'].forEach((name, i) => {
                const label = items[first + i]?.get_children().find(c => c.has_style_class_name?.('tempo-key'));
                if (!label)
                    return;
                label.text = name;
                pinned.push([label, label.connect('notify::text', () => {
                    if (label.text !== name)
                        label.text = name;
                })]);
            });
        }
        await probeScreenshot(`${this._out}/menu.png`);
        for (const [label, id] of pinned)
            label.disconnect(id);
        {
            // The menu's own switch must change the setting, and follow it.
            const item = this._button().menu._getMenuItems().find(i => i.label?.text === 'Music visuals' && typeof i.toggle === 'function');
            this._check('menu: music switch is on while music bars are on', item?.state === true);
            item?.toggle();
            await probeSleep(400);
            this._check('menu: music switch turns the setting off', settings.get_boolean('music-visuals') === false);
            this._check('menu: music bars hide at once', this._parts().bars?.visible === false);
            settings.set_boolean('music-visuals', true);
            await probeSleep(400);
            this._check('menu: music switch follows the setting', item?.state === true);
        }
        {
            // Where things are on screen, for tools/screenshots.sh to crop the pictures.
            const menu = this._button().menu.actor;
            this._report.notes.geometry.menu = [...menu.get_transformed_position(), ...menu.get_transformed_size()];
        }
        {
            // Clicking the song goes to the player (here: asks our stand-in player to come forward).
            const item = this._button().menu._getMenuItems().find(i => i.visible && i.has_style_class_name('tempo-playing'));
            item?.activate(null);
            await probeSleep(900);
            this._check('menu: clicking the song asks the player to come forward',
                GLib.file_test(`${this._out}/raised`, GLib.FileTest.EXISTS));
        }
        this._button().menu.close();
        await probeSleep(600);

        if (this._audio) {
            // Resting the pointer on the bars shows what is playing; moving away hides it.
            const bars = this._button().get_first_child().get_children().find(c => c.has_style_class_name('tempo-bars'));
            this._check('hover: no tip before hovering', this._chrome('tempo-tip') === null || !this._chrome('tempo-tip').visible);
            bars.set_hover(true);
            await probeSleep(1200);
            const tip = this._chrome('tempo-tip');
            this._check('hover: the tip appears', tip !== null && tip.visible && tip.opacity === 255);
            const texts = tip ? this._labelTexts(tip) : [];
            this._check('hover: the tip names the song and the app', texts[0] === 'Test Song' && texts[1] === 'Tempo Test Player · Test Artist', JSON.stringify(texts));
            if (tip) {
                this._report.notes.geometry.tip = [...tip.get_transformed_position(), ...tip.get_transformed_size()];
                const [, tipY] = tip.get_transformed_position();
                this._check('hover: the tip sits below the top bar', tipY >= Main.layoutManager.panelBox.height);
            }
            await probeScreenshot(`${this._out}/tip.png`);
            bars.set_hover(false);
            await probeSleep(600);
            this._check('hover: the tip goes away', this._chrome('tempo-tip') === null || !this._chrome('tempo-tip').visible);

            // The level line: absent with "bars"; with "strip" it spans the top bar and the small
            // bars step aside.
            this._check('level line: absent by default', this._chrome('tempo-strip') === null);
            settings.set_string('music-style', 'strip');
            await probeSleep(1500);
            const strip = this._chrome('tempo-strip');
            const panelBox = Main.layoutManager.panelBox;
            this._check('level line: appears when chosen', strip !== null && strip.visible && strip.opacity === 255);
            this._check('level line: the small bars are hidden', this._parts().bars?.visible === false);
            if (strip) {
                this._check('level line: as wide as the top bar', strip.width === panelBox.width, `${strip.width} vs ${panelBox.width}`);
                this._check('level line: sits on the bottom edge of the top bar', strip.height > 0 && strip.y + strip.height === panelBox.y + panelBox.height,
                    `y ${strip.y}, height ${strip.height}, panel ${panelBox.height}`);
                this._check('level line: does not take clicks', strip.reactive === false);
                this._check('level line: grows from the middle', strip.pivot_point.x === 0.5);
                const lengths = new Set();
                for (let i = 0; i < 12; i++) {
                    lengths.add(Math.round(strip.scale_x * 1000));
                    await probeSleep(150);
                }
                const longest = Math.max(...lengths) / 1000;
                this._check('level line: stretches out with the sound', longest > 0.1, `longest ${longest}`);
                // A steady test tone keeps one length; real music must make it move.
                if (GLib.getenv('TEMPO_SMOKE_SOUND'))
                    this._check('level line: grows and shrinks with the music', lengths.size >= 3, `${lengths.size} different lengths`);
            }
            await probeScreenshot(`${this._out}/strip.png`);
            settings.set_string('music-style', 'bars');
            await probeSleep(700);
            this._check('small bars: the level line is gone', this._chrome('tempo-strip') === null);
            this._check('small bars: the bars are back', this._parts().bars?.visible === true);
        }

        // Every palette, and the other temperature unit.
        for (const palette of ['aurora', 'orchid', 'mono', 'ember']) {
            settings.set_string('palette', palette);
            await probeSleep(500);
            if (palette !== 'ember')
                await probeScreenshot(`${this._out}/palette-${palette}.png`);
        }
        settings.set_string('temperature-unit', 'fahrenheit');
        settings.set_int('refresh-interval', 1);
        settings.set_int('music-fps', 24);
        await probeSleep(2500);
        parts = this._parts();
        if (parts.temperature?.visible)
            this._check('temperature still reads like "125°" in Fahrenheit', /^-?\d+°$/.test(parts.temperature.text ?? ''), parts.temperature.text);
        if (this._audio)
            this._check('music bars survive a frame-rate change', this._parts().bars?.visible === true);
        settings.reset('temperature-unit');
        settings.reset('refresh-interval');
        settings.reset('music-fps');

        // Everything off: only the fallback icon remains, so the menu stays reachable.
        for (const key of ['show-cpu', 'show-memory', 'show-temperature', 'show-network', 'music-visuals'])
            settings.set_boolean(key, false);
        await probeSleep(1200);
        parts = this._parts();
        this._report.notes.everythingOff = parts;
        this._check('everything off: fallback icon shown', parts.icon?.visible === true);
        this._check('everything off: rings hidden', parts.cpu?.visible === false && parts.memory?.visible === false);
        this._check('everything off: music bars hidden', parts.bars?.visible === false);
        for (const key of ['show-cpu', 'show-memory', 'show-temperature', 'show-network', 'music-visuals'])
            settings.reset(key);
        settings.set_boolean('show-network', true);
        settings.set_boolean('music-visuals', true);
        settings.set_string('music-style', 'strip');
        await probeSleep(800);

        // Disable and enable twice: nothing may be left behind, nothing may break.
        for (let round = 1; round <= 2; round++) {
            Main.extensionManager.disableExtension(TEMPO_UUID);
            await probeSleep(800);
            this._check(`round ${round}: button is gone after disabling`, this._button() === null);
            this._check(`round ${round}: level line and tip are gone after disabling`,
                this._chrome('tempo-strip') === null && this._chrome('tempo-tip') === null);
            Main.extensionManager.enableExtension(TEMPO_UUID);
            await probeSleep(1500);
            const again = this._tempo();
            this._check(`round ${round}: active again after enabling`, again?.state === STATE_ACTIVE && !again?.error,
                `state ${again?.state}, error: ${again?.error ?? ''}`);
            this._check(`round ${round}: button is back`, this._button() !== null);
        }
        if (this._audio) {
            await probeSleep(3500);
            this._check('level line comes back after re-enabling', this._chrome('tempo-strip')?.opacity === 255);
            settings.set_string('music-style', 'bars');
            await probeSleep(1500);
            this._check('music bars come back after switching to them', this._parts().bars?.visible === true);
        }
        settings.set_string('music-style', 'bars');

        // Disabling while the menu is open (a screen lock can do this) must leave nothing behind.
        this._button().menu.open();
        await probeSleep(1500);
        Main.extensionManager.disableExtension(TEMPO_UUID);
        await probeSleep(4500);         // longer than one refresh interval
        this._check('disabled with the menu open: button is gone', this._button() === null);
        Main.extensionManager.enableExtension(TEMPO_UUID);
        await probeSleep(1500);
        this._check('enabled again after that', this._tempo()?.state === STATE_ACTIVE && this._button() !== null);

        // The preferences window, opened the way a user does it: from Tempo's own menu.
        try {
            const item = this._button().menu._getMenuItems().find(i => i.label?.text === 'Settings');
            this._check('menu: settings entry found', item !== undefined);
            item.activate(null);
        } catch (e) {
            this._check('preferences could be opened', false, e);
        }
        let title = null;
        for (let i = 0; i < 16 && title === null; i++) {
            await probeSleep(500);
            for (const actor of global.get_window_actors()) {
                const t = actor.meta_window.get_title();
                if (t && /tempo/i.test(t))
                    title = t;
            }
        }
        this._check('preferences window opened', title !== null, title ?? 'no window titled Tempo appeared');
        await probeSleep(1500);
        for (const actor of global.get_window_actors()) {
            if (actor.meta_window.get_title() === title) {
                const frame = actor.meta_window.get_frame_rect();
                this._report.notes.geometry.prefs = [frame.x, frame.y, frame.width, frame.height];
            }
        }
        await probeScreenshot(`${this._out}/prefs.png`);
    }

    _finish() {
        try {
            GLib.file_set_contents(`${this._out}/report.json`, JSON.stringify(this._report, null, 2));
        } catch (e) {
            log(`tempo-probe: could not write the report: ${e}`);
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            global.context.terminate();
            return GLib.SOURCE_REMOVE;
        });
    }
}
