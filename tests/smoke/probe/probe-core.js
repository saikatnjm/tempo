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

    // Wait for GNOME Shell's start-up to be over, then close the overview if it is showing.
    async _leaveOverview() {
        const layout = Main.layoutManager;
        let waited = 0;
        while (layout._startingUp && waited < 40) {
            await probeSleep(500);
            waited++;
        }
        await probeSleep(500);
        const notes = {startingUpFor: waited / 2, startedInOverview: Main.overview.visible};
        for (let tries = 0; tries < 5 && (Main.overview.visible || Main.overview.animationInProgress); tries++) {
            Main.overview.hide();
            await probeSleep(1500);
        }
        notes.overviewAfter = Main.overview.visible;
        notes.windowGroupVisible = global.window_group.visible;
        this._report.notes.overview = notes;
        this._check('the desktop is showing, not the overview', !Main.overview.visible && global.window_group.visible,
            JSON.stringify(notes));
    }

    // Take a picture, and note where the floating panels are in it (the documentation pictures
    // are cut out of these).
    async _floatShot(name) {
        const rect = title => {
            const found = this._float(title);
            return found ? [found.actor.x, found.actor.y, found.actor.width, found.actor.height] : null;
        };
        this._report.notes.geometry.shots ??= {};
        this._report.notes.geometry.shots[name] = {stats: rect('Tempo system panel'), viz: rect('Tempo visualizer')};
        await probeScreenshot(`${this._out}/${name}.png`);
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

    // A floating panel by its accessible name, on the desktop layer or on top.
    _float(name) {
        const groups = [Main.layoutManager._backgroundGroup, Main.uiGroup];
        for (const group of groups) {
            const found = group.get_children().find(a => a.accessible_name === name);
            if (found)
                return {actor: found, onDesktop: group === Main.layoutManager._backgroundGroup};
        }
        return null;
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
        states.push(['rings, temperature, network in the floating system panel', true, false, 'bars', 12, false, true]);
        // The fan in the system panel, held still and held turning (the real fan may be either).
        const holdFan = rpm => () => {
            let fan = null;
            const walk = actor => {
                for (const child of actor.get_children()) {
                    if (child._delegate?.setRpm)
                        fan = child._delegate;
                    walk(child);
                }
            };
            walk(this._float('Tempo system panel').actor);
            if (!fan)
                return;
            const real = fan.setRpm;
            real.call(fan, rpm);
            fan.setRpm = () => {};
            restore.push(() => {
                fan.setRpm = real;
                real.call(fan, 0);
            });
        };
        states.push(['  system panel, fan held still', true, false, 'bars', 12, false, true, false, holdFan(0)]);
        states.push(['  system panel, fan held turning', true, false, 'bars', 12, false, true, false, holdFan(2500)]);
        states.push(['floating visualizer panel at 8 fps', true, true, 'bars', 8, false, false, true]);
        // Where does the visualizer's cost go? Parts of it hidden, one by one.
        const vizParts = () => {
            const parts = {caps: [], bars: []};
            const walk = actor => {
                for (const child of actor.get_children()) {
                    if (child instanceof St.DrawingArea && child.has_clip)
                        parts.bars.push(child);
                    else if (child.get_n_children() === 0 && !(child instanceof St.DrawingArea) && child.get_parent().get_n_children() > 2)
                        parts.caps.push(child);
                    walk(child);
                }
            };
            walk(this._float('Tempo visualizer').actor);
            return parts;
        };
        let hidden = [];
        let restore = [];
        const hide = (...kinds) => () => {
            const parts = vizParts();
            for (const kind of kinds) {
                for (const a of parts[kind].filter(x => x.visible)) {
                    a.visible = false;
                    hidden.push(a);
                }
            }
        };
        states.push(['  visualizer without its peak caps', true, true, 'bars', 8, false, false, true, hide('caps')]);
        states.push(['  visualizer with nothing shown (listening only)', true, true, 'bars', 8, false, false, true, hide('caps', 'bars')]);
        states.push(['  visualizer not updated at all (sound only)', true, true, 'bars', 8, false, false, true, () => {
            const widget = this._float('Tempo visualizer').actor.get_first_child()._delegate;
            const real = widget.setLevels;
            widget.setLevels = () => {};
            restore.push(() => (widget.setLevels = real));
        }]);
        const only = GLib.getenv('TEMPO_BENCH_ONLY');
        if (only)
            states.splice(0, states.length, ...states.filter(st => new RegExp(only).test(st[0])));
        // TEMPO_BENCH_ROUNDS=n: go through the states n times, interleaved, and average (steadier
        // numbers on a busy machine).
        const rounds = Math.max(1, Number(GLib.getenv('TEMPO_BENCH_ROUNDS') || 1));
        const one = states.slice();
        for (let r = 1; r < rounds; r++)
            states.push(...one);
        const totals = new Map();
        this._report.bench = [];
        const barsActor = this._button().get_first_child().get_children().find(c => c.has_style_class_name('tempo-bars'));
        for (const [name, showReadings, music, style, fps, notDrawn, floatStats, floatViz, tweak] of states) {
            settings.set_value('float-stats-rect', new GLib.Variant('ai', [100, 120, 330, 150]));
            settings.set_value('float-viz-rect', new GLib.Variant('ai', [480, 120, 380, 150]));
            settings.set_boolean('float-stats', Boolean(floatStats));
            settings.set_boolean('float-viz', Boolean(floatViz));
            if (notDrawn)
                barsActor._delegate.setLevels = () => {};
            for (const key of readings)
                settings.set_boolean(key, showReadings);
            settings.set_int('music-fps', fps);
            settings.set_string('music-style', style);
            settings.set_boolean('music-visuals', music);
            await probeSleep(5000);
            tweak?.();
            await probeSleep(500);
            const before = ticks();
            await probeSleep(seconds * 1000);
            hidden.forEach(x => (x.visible = true));
            hidden = [];
            restore.forEach(f => f());
            restore = [];
            const t = totals.get(name) ?? {sum: 0, n: 0};
            t.sum += (ticks() - before) / seconds;
            t.n++;
            totals.set(name, t);
            if (notDrawn)
                delete barsActor._delegate.setLevels;
        }
        for (const [name, t] of totals)
            this._report.bench.push({name, percent: t.sum / t.n});
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
        // Stock GNOME starts a session in the overview, where the desktop (and with it Tempo's
        // desktop panels) is hidden. The tests are about the desktop: wait until GNOME Shell has
        // finished starting (on a slow machine that takes a while), then go there.
        await this._leaveOverview();

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

        {
            // Screens off: nobody is looking, so Tempo must stop reading, listening and animating,
            // and pick everything up again when the screens come back.
            const tempo = this._button()._tempoIndicator;
            this._check('the indicator can be inspected', Boolean(tempo));
            // What Mutter announces when GNOME blanks the screens after a while without input, and
            // when they come back. (Really blanking them is not possible here: a display server
            // without a real screen has nothing to switch off.) The announcement comes from this
            // very program's connection to the session bus, as Mutter's own does.
            const announce = mode => {
                Gio.DBus.session.emit_signal(null, '/org/gnome/Mutter/DisplayConfig',
                    'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                    new GLib.Variant('(sa{sv}as)', ['org.gnome.Mutter.DisplayConfig',
                        {PowerSaveMode: new GLib.Variant('i', mode)}, []]));
            };
            const paused = how => {
                this._check(`screens off (${how}): no more readings`, tempo._refreshId === 0);
                this._check(`screens off (${how}): the recorder is stopped`, tempo._capture === null);
            };
            const resumed = how => {
                this._check(`screens back on (${how}): readings resume`, tempo._refreshId !== 0 && !tempo._screenOff);
                if (this._audio)
                    this._check(`screens back on (${how}): the recorder runs again`, tempo._capture !== null);
            };
            this._check('screens: on at the start', tempo._screenOff === false && tempo._screen.off === false);
            announce(3);
            await probeSleep(1000);
            this._check('screens off (announced): Tempo noticed', tempo._screenOff === true);
            paused('announced');
            announce(0);
            await probeSleep(1000);
            resumed('announced');
            announce(-1);                                 // "these screens cannot be switched off"
            await probeSleep(500);
            this._check('screens: "cannot be switched off" counts as on', tempo._screenOff === false);
            // And the same by hand.
            tempo._onScreenPower(true);
            paused('direct');
            tempo._onScreenPower(false);
            resumed('direct');
            await probeSleep(2500);
            this._check('after the screens come back the music bars are back too',
                !this._audio || this._parts().bars?.visible === true);
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
        this._check('menu: website link at the bottom', rows[rows.length - 1]?.[0] === 'saikatnjm.github.io/tempo',
            JSON.stringify(rows[rows.length - 1]));
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

        // ---- floating panels ----
        {
            const panelBox = Main.layoutManager.panelBox;
            settings.set_value('float-stats-rect', new GLib.Variant('ai', [100, 120, 330, 150]));
            settings.set_boolean('float-stats', true);
            await probeSleep(4000);                       // one refresh: values arrive
            const stats = this._float('Tempo system panel');
            this._check('system panel: appears when switched on', stats !== null && stats.actor.visible);
            this._check('system panel: is really on screen', stats?.actor.mapped === true,
                `overview ${Main.overview.visible}, starting up ${Main.layoutManager._startingUp}, ` +
                `window group visible ${global.window_group.visible} mapped ${global.window_group.mapped}, ` +
                `background group visible ${Main.layoutManager._backgroundGroup.visible} mapped ${Main.layoutManager._backgroundGroup.mapped}`);
            this._check('system panel: sits on the desktop by default', stats?.onDesktop === true);
            this._check('system panel: placed where it was saved', stats?.actor.x === 100 && stats?.actor.y === 120 &&
                stats?.actor.width === 330 && stats?.actor.height === 150,
                `${stats?.actor.x},${stats?.actor.y} ${stats?.actor.width}x${stats?.actor.height}`);
            const texts = stats ? this._labelTexts(stats.actor) : [];
            this._check('system panel: shows processor and memory percentages', texts.filter(t => /^\d+%$/.test(t)).length >= 2, JSON.stringify(texts));
            this._check('system panel: shows the network speed', texts.some(t => t.startsWith('↓ ')), JSON.stringify(texts));
            const hasFan = GLib.file_test('/sys/class/hwmon', GLib.FileTest.EXISTS) &&
                this._labelTexts(this._button().menu.box).some(t => t.endsWith(' RPM') || t === 'Stopped');
            this._check('system panel: shows the fan speed when the computer has one',
                texts.some(t => t.endsWith(' RPM') || t === 'Fan stopped') || !hasFan, JSON.stringify(texts));
            const p = this._parts();
            this._check('one view at a time: top-bar rings hidden', p.cpu?.visible === false && p.memory?.visible === false);
            this._check('one view at a time: top-bar network hidden', p.network?.visible === false);
            this._check('only floating panels: the Tempo icon keeps the menu reachable', p.icon?.visible === true || p.bars?.visible === true);
            await this._floatShot('float-rings');
            {
                // Real pointer input: move the panel by dragging its body, resize it by its corner.
                const seat = Clutter.get_default_backend().get_default_seat();
                const mouse = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
                const now = () => GLib.get_monotonic_time();
                const move = async (x, y) => { mouse.notify_absolute_motion(now(), x, y); await probeSleep(60); };
                const press = async on => { mouse.notify_button(now(), 1, on ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED); await probeSleep(120); };
                const drag = async (x0, y0, x1, y1) => {
                    await move(x0, y0);
                    await probeSleep(300);              // let hover show the grip
                    await press(true);
                    for (let k = 1; k <= 6; k++)
                        await move(x0 + (x1 - x0) * k / 6, y0 + (y1 - y0) * k / 6);
                    await press(false);
                    await probeSleep(300);
                };
                // A pointer that has just appeared may have woken the overview (it starts in the
                // top-left corner): park it somewhere harmless and make sure the desktop shows.
                await move(700, 500);
                if (Main.overview.visible) {
                    Main.overview.hide();
                    await probeSleep(1500);
                }
                let a = this._float('Tempo system panel').actor;
                this._check('mouse: the desktop panel is on screen for the pointer', a.mapped && !Main.overview.visible,
                    `mapped ${a.mapped}, overview ${Main.overview.visible}`);
                const [x, y, w, h] = [a.x, a.y, a.width, a.height];
                await drag(x + w / 2, y + 20, x + w / 2 + 50, y + 20 + 30);
                a = this._float('Tempo system panel').actor;
                this._check('mouse: dragging the panel moves it', a.x === x + 50 && a.y === y + 30, `${a.x},${a.y} from ${x},${y}`);
                const [x2, y2, w2, h2] = [a.x, a.y, a.width, a.height];
                const firstLabel = actor => {
                    if (actor instanceof St.Label)
                        return actor;
                    for (const child of actor.get_children()) {
                        const found = firstLabel(child);
                        if (found)
                            return found;
                    }
                    return null;
                };
                const textSize = () => firstLabel(this._float('Tempo system panel').actor).get_theme_node().get_font().get_size();
                const size0 = textSize();
                await drag(x2 + w2 - 4, y2 + h2 - 4, x2 + w2 - 4 + 60, y2 + h2 - 4 + 40);
                a = this._float('Tempo system panel').actor;
                this._check('mouse: dragging the corner makes it bigger, same shape',
                    a.width > w2 + 30 && Math.abs(a.width / a.height - w2 / h2) < 0.02 && a.x === x2 && a.y === y2,
                    `${a.width}x${a.height} from ${w2}x${h2}, at ${a.x},${a.y}`);
                this._check('mouse: the text grows with the panel', textSize() > size0, `${size0} -> ${textSize()}`);
                await this._floatShot('float-zoomed');
                const [w3, h3] = [a.width, a.height];
                await drag(a.x + w3 - 5, a.y + h3 / 2, a.x + w3 - 5 + 40, a.y + h3 / 2 + 25);
                a = this._float('Tempo system panel').actor;
                this._check('mouse: dragging the right edge makes it only wider', a.width === w3 + 40 && a.height === h3,
                    `${a.width}x${a.height} from ${w3}x${h3}`);
                const saved = settings.get_value('float-stats-rect').deep_unpack();
                this._check('mouse: the new place and size are saved', saved[0] === a.x && saved[2] === a.width, JSON.stringify(saved));
                await move(5, 400);
                this._check('mouse: nothing is held or listened to once the drag is over',
                    a._delegate._grab === null && a._delegate._dragIds.length === 0 && a._delegate._drag === null);
                // A panel may poke out of the top-left corner: that is a place like any other,
                // not "never placed" (which would send it to the bottom-right corner).
                settings.set_value('float-stats-rect', new GLib.Variant('ai', [-30, -10, 330, 150]));
                await probeSleep(400);
                a = this._float('Tempo system panel').actor;
                this._check('a panel tucked into the top-left corner stays there', a.x === -30 && a.y === -10, `${a.x},${a.y}`);
                settings.set_value('float-stats-rect', new GLib.Variant('ai', [100, 120, 330, 150]));
                await probeSleep(400);
                a = this._float('Tempo system panel').actor;
                this._check('a saved place that changes moves the panel', a.x === 100 && a.y === 120 && a.width === 330, `${a.x},${a.y} ${a.width}`);
            }
            {
                // The little fan turns only while the real one does, and never while the screens are off.
                let fan = null;
                const walk = actor => {
                    for (const child of actor.get_children()) {
                        if (child._delegate?.setRpm)
                            fan = child._delegate;
                        walk(child);
                    }
                };
                walk(this._float('Tempo system panel').actor);
                if (fan) {
                    const tempo = this._button()._tempoIndicator;
                    // The speed is staged, and the computer's real fan is kept from overruling it
                    // until these checks are through.
                    const setRpm = Object.getPrototypeOf(fan).setRpm;
                    fan.setRpm = () => {};
                    setRpm.call(fan, 2500);
                    this._check('system panel: the fan turns while the real one does', fan._timer !== 0);
                    tempo._onScreenPower(true);
                    this._check('screens off: the fan stands still', fan._timer === 0);
                    tempo._onScreenPower(false);
                    this._check('screens back on: the fan turns again', fan._timer !== 0);
                    // In the overview the desktop is hidden, and nothing on it may keep animating.
                    Main.overview.show();
                    await probeSleep(1500);
                    this._check('overview: the desktop panel is hidden and its fan stands still',
                        !this._float('Tempo system panel').actor.mapped && fan._timer === 0);
                    Main.overview.hide();
                    await probeSleep(1500);
                    this._check('back on the desktop: the panel is shown and its fan turns again',
                        this._float('Tempo system panel').actor.mapped && fan._timer !== 0);
                    setRpm.call(fan, 0);
                    this._check('system panel: the fan stands still when the real one stops', fan._timer === 0);
                    delete fan.setRpm;
                } else {
                    this._report.notes.fan = 'this computer reports no fan, so the panel shows none';
                }
            }
            this._report.notes.geometry.statsPanel = [stats.actor.x, stats.actor.y, stats.actor.width, stats.actor.height];

            settings.set_string('float-stats-design', 'bars');
            await probeSleep(3500);
            const meters = [];
            const walk = a => { if (a.has_style_class_name?.('tempo-meter')) meters.push(a); a.get_children().forEach(walk); };
            walk(this._float('Tempo system panel').actor);
            this._check('system panel: bars design has three meters', meters.length === 3, meters.length);
            await this._floatShot('float-bars');

            settings.set_string('float-layer', 'top');
            await probeSleep(600);
            this._check('system panel: moves on top of windows when asked', this._float('Tempo system panel')?.onDesktop === false);
            settings.set_string('float-layer', 'desktop');
            for (const look of ['solid', 'clear', 'glass']) {
                settings.set_string('float-background', look);
                await probeSleep(200);
            }
            this._check('system panel: background choice applied', this._float('Tempo system panel')?.actor.has_style_class_name('tempo-float-glass'));

            if (this._audio) {
                settings.set_value('float-viz-rect', new GLib.Variant('ai', [480, 120, 380, 150]));
                settings.set_boolean('float-viz', true);
                await probeSleep(3000);
                const viz = this._float('Tempo visualizer');
                this._check('visualizer panel: appears when switched on', viz !== null && viz.actor.visible);
                this._check('one view at a time: top-bar music hidden', this._parts().bars?.visible === false &&
                    this._chrome('tempo-strip') === null);
                for (const design of ['mirror', 'wave', 'bars']) {
                    settings.set_string('float-viz-design', design);
                    await probeSleep(900);
                    await this._floatShot(`float-viz-${design}`);
                }
                // Bars are segmented (lit by clipping), and a wider panel shows more of them.
                const litBars = () => {
                    let n = 0;
                    const walk = actor => {
                        for (const child of actor.get_children()) {
                            if (child instanceof St.DrawingArea && child.visible && child.has_clip)
                                n++;
                            walk(child);
                        }
                    };
                    walk(this._float('Tempo visualizer').actor);
                    return n;
                };
                const narrow = litBars();
                this._check('visualizer panel: bars are segmented and lit', narrow >= 8, `${narrow} bars`);
                {
                    // Peak caps must come down after the sound stops, not hang in the air. The
                    // real sound is kept away from the widget for a moment, and frames are fed
                    // by hand: loud, then silence, then "nothing changed" until all has settled.
                    const widget = this._float('Tempo visualizer').actor.get_first_child()._delegate;
                    const proto = Object.getPrototypeOf(widget);
                    widget.setLevels = () => {};
                    widget.settle = () => {};
                    const loud = new Uint8Array(64).fill(28), silence = new Uint8Array(64);
                    for (let k = 0; k < 4; k++)
                        proto.setLevels.call(widget, loud);
                    const shown = widget._caps.filter(c => c.opacity > 0).length;
                    proto.setLevels.call(widget, silence);
                    let frames = 0;
                    while (widget.settling && frames < 200) {
                        proto.settle.call(widget);
                        frames++;
                    }
                    const left = widget._caps.filter(c => c.opacity > 0).length;
                    this._check('visualizer panel: peak caps show above loud bars', shown >= 8, `${shown} caps`);
                    this._check('visualizer panel: the caps fall over several frames once the sound stops', frames > 6 && frames < 200, `${frames} frames`);
                    this._check('visualizer panel: no cap is left hanging', left === 0 && !widget.settling, `${left} left`);
                    delete widget.setLevels;
                    delete widget.settle;
                }
                settings.set_value('float-viz-rect', new GLib.Variant('ai', [300, 120, 760, 220]));
                await probeSleep(900);
                const wide = litBars();
                this._check('visualizer panel: a wider panel shows more bars', wide > narrow + 10, `${narrow} -> ${wide}`);
                await this._floatShot('float-viz-wide');
                this._report.notes.geometry.vizWide = [viz.actor.x, viz.actor.y, viz.actor.width, viz.actor.height];
                settings.set_value('float-viz-rect', new GLib.Variant('ai', [480, 120, 380, 150]));
                await probeSleep(500);
                this._report.notes.geometry.vizPanel = [viz.actor.x, viz.actor.y, viz.actor.width, viz.actor.height];
                settings.set_string('float-stats-design', 'rings');
                await probeSleep(3500);
                await this._floatShot('float-both');
                settings.set_boolean('float-viz', false);
                await probeSleep(2500);
                this._check('visualizer panel: gone when switched off', this._float('Tempo visualizer') === null);
                this._check('top-bar music back once the panel is off', this._parts().bars?.visible === true);
            }
            settings.set_boolean('float-stats', false);
            await probeSleep(3500);
            this._check('system panel: gone when switched off', this._float('Tempo system panel') === null);
            this._check('top-bar rings back once the panel is off', this._parts().cpu?.visible === true);
            for (const key of ['float-stats-rect', 'float-viz-rect', 'float-stats-design', 'float-viz-design', 'float-layer', 'float-background'])
                settings.reset(key);
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
        settings.set_boolean('float-stats', true);
        await probeSleep(800);

        // Disable and enable twice: nothing may be left behind, nothing may break.
        for (let round = 1; round <= 2; round++) {
            Main.extensionManager.disableExtension(TEMPO_UUID);
            await probeSleep(800);
            this._check(`round ${round}: button is gone after disabling`, this._button() === null);
            this._check(`round ${round}: level line and tip are gone after disabling`,
                this._chrome('tempo-strip') === null && this._chrome('tempo-tip') === null);
            this._check(`round ${round}: floating panels are gone after disabling`,
                this._float('Tempo system panel') === null && this._float('Tempo visualizer') === null);
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
        settings.set_boolean('float-stats', false);

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
