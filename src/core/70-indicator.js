// ---- indicator: the top-bar button, its menu, and the glue between all the parts -------------
//
// Cost model, in one place:
//  * System readings: one low-priority timer (every `refresh-interval` seconds, default 3) reads
//    three small /proc files and one sensor. If nothing is shown and the menu is closed, the
//    timer is removed altogether.
//  * Drawing: a ring or label is only repainted when the value it shows changes.
//  * Menu details (fan, disk temperature, busiest apps, what is playing) are read only while
//    the menu is open; the hover tip asks the players only when the pointer rests on the bars.
//  * Music visuals (the small bars or the level line along the top bar, or the visualizer
//    panel): nothing runs until a media player reports "Playing"; then one small recorder
//    process runs until shortly after it pauses, and not at all while a fullscreen window
//    covers the place where the visuals are drawn.
//  * Screens off (blanked after a while without input): nothing is read, listened to or
//    animated until they are back on.

const BAR_COUNT = 10;
const REFRESH_MIN_S = 1;
const REFRESH_MAX_S = 10;
const FPS_MIN = 5;
const FPS_MAX = 30;
const STOP_GRACE_MS = 4000;          // keep listening across track changes and buffering
const SILENCE_HIDE_MS = 2500;        // hide the bars after this much silence
const SINK_CHANGE_DELAY_MS = 600;    // let the sound server settle after an output switch
const CAPTURE_RETRY_MS = 4000;
const CAPTURE_MAX_FAILURES = 3;
const MENU_FOLLOWUP_MS = 1000;       // second reading shortly after the menu opens
const TIP_DELAY_MS = 300;            // how long the pointer must rest on the bars
const FADE_MS = 200;
const TEMP_WARM_C = 75;
const TEMP_HOT_C = 85;
const TEMP_MISSES_BEFORE_RESCAN = 3;
const FAN_MAX_RPM = 20000;           // anything above is a bogus reading
const FAN_ROWS = 4;                  // most fans listed in the menu
// For the system panel's fan, every second reading is enough: fans change speed slowly, and on
// some laptops (Dell) each question to the fan controller briefly holds up the whole machine.
const FAN_EVERY = 2;
const FAN_MODE_EVERY = 20;           // readings between looks at the fan service's mode
const SENSOR_SEARCH_FIRST = 20;      // readings before looking again for a missing sensor ...
const SENSOR_SEARCH_MAX = 1200;      // ... then four times as long each time, up to this many
// Written by the optional tempo-fan service (see fan/ in the source); the user owns it.
const FAN_MODE_FILE = GLib.getenv('TEMPO_FAN_MODE') || '/var/lib/tempo-fan/mode';
const FAN_MODES = ['cool', 'max', 'auto'];
const TEMPO_WEBSITE = 'https://saikatnjm.github.io/tempo/';
// Candidates for the widest network value: every digit three times, and each unit.
const NET_WIDEST_SAMPLES = ['000M', '111M', '222M', '333M', '444M', '555M', '666M', '777M', '888M',
    '999M', '888K', '888G'];
const SYSTEM_MONITOR_APPS = [
    'gnome-system-monitor.desktop',
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor_gnome-system-monitor.desktop',
    'net.nokyan.Resources.desktop',
    'io.missioncenter.MissionCenter.desktop',
];

class TempoIndicator {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {string} params.path - the extension's folder
     * @param {string} params.uuid
     * @param {function(): void} params.openPreferences
     */
    constructor({settings, path, uuid, openPreferences}) {
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._timers = new Map();
        this._refreshId = 0;
        this._refreshInterval = 0;
        this._samples = 0;               // readings taken so far
        this._screenOff = false;

        this._sampler = new Sampler();
        this._sensors = findSensors();
        this._sensorMisses = 0;
        this._sensorRescanAt = TEMP_MISSES_BEFORE_RESCAN;
        this._sensorSearchGap = SENSOR_SEARCH_FIRST;     // readings between looks for a missing sensor
        this._sensorSearchAt = SENSOR_SEARCH_FIRST;
        this._procs = new ProcScanner(this._sampler.cpuCount, list => this._showProcesses(list));

        this._cpu = null;
        this._memory = null;
        this._network = null;
        this._celsius = null;
        this._tempClass = '';
        this._ghz = '';
        this._netSlotWidth = 0;
        this._netFont = '';
        this._sizingNet = false;

        this._players = null;
        this._capture = null;
        this._playing = false;
        this._captureFailures = 0;
        this._soundVisible = false;      // there is sound to show right now
        this._barsShown = false;         // the small bars are on screen
        this._musicStyle = 'bars';       // 'bars' or 'strip' (the level line)
        this._fps = 0;
        this._palette = null;
        this._stats = null;              // floating system panel, when shown
        this._vizPanel = null;           // floating visualizer panel, when shown
        this._viz = null;
        this._floatStatsOn = false;
        this._vizOn = false;
        this._musicOn = false;
        this._bands = BAR_COUNT;         // bands the recorder is set up for
        this._strip = null;
        this._panelBoxId = 0;
        this._tip = null;
        this._tipRows = [];
        this._nowPlaying = [];

        this._buildButton(path);
        this._buildMenu();
        this._applySensors();
        Main.panel.addToStatusArea(uuid, this._button, 0, 'right');

        this._mixer = null;
        this._mixerId = 0;
        try {
            this._mixer = Volume.getMixerControl();
            this._mixerId = this._mixer.connect('default-sink-changed', () => this._onOutputChanged());
        } catch (e) {
            this._mixer = null;      // no mixer: the bars simply don't follow output switches
        }

        // While a fullscreen window covers the music visuals nobody can see them: don't listen.
        this._fullscreenId = global.display.connect('in-fullscreen-changed',
            () => this._onFullscreenChanged());
        // While the screens are off nobody can see anything: do nothing at all.
        this._screen = new ScreenWatch(off => this._onScreenPower(off));

        this._settingsId = this._settings.connect('changed', (_settings, key) => {
            // Where a panel was dropped is the panel's own business (see FloatPanel). All it can
            // change here is which screen the visuals are on, and so whether they are covered.
            if (key.endsWith('-rect'))
                this._onFullscreenChanged();
            else
                this._applySettings();
        });
        this._applySettings();
        // Rates need two readings; take the second one soon so the rings fill in right away.
        this._setTimer('warmup', MENU_FOLLOWUP_MS, () => this._refresh());
    }

    destroy() {
        // Set first: destroying the button closes an open menu, and nothing that reacts to that
        // may start a new timer or process.
        this._destroyed = true;
        this._settings.disconnect(this._settingsId);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        this._cancellable.cancel();
        this._procs.cancel();
        if (this._players !== null)
            this._players.destroy();
        this._players = null;
        if (this._capture !== null)
            this._capture.stop();
        this._capture = null;
        if (this._mixer !== null && this._mixerId)
            this._mixer.disconnect(this._mixerId);
        this._mixer = null;
        global.display.disconnect(this._fullscreenId);
        this._screen.destroy();
        this._removeStrip();
        this._removeTip();
        this._removeFloats();
        this._bars.actor.remove_all_transitions();
        this._button._tempoIndicator = null;
        this._button.destroy();
        this._button = null;
    }

    // ---- building ----------------------------------------------------------------------------

    _buildButton(path) {
        this._button = new PanelMenu.Button(0.5, 'Tempo', false);
        this._button.add_style_class_name('tempo-button');
        // For the test suite and for looking around in Looking Glass:
        // Main.panel.statusArea['tempo@saikatnjm.github.io']._tempoIndicator
        this._button._tempoIndicator = this;

        const box = new St.BoxLayout({style_class: 'tempo-box'});
        this._bars = new BarsWidget(BAR_COUNT);
        this._bars.actor.connect('notify::hover', () => this._onBarsHover());
        this._cpuRing = new RingWidget();
        this._memoryRing = new RingWidget();
        this._tempLabel = new St.Label({
            text: '',
            style_class: 'tempo-temp',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        // Network speed as two small lines, download over upload, with the numbers right-aligned
        // in a slot of fixed width: narrow, and nothing in the top bar shuffles sideways as
        // traffic comes and goes.
        this._netBox = new St.BoxLayout({style_class: 'tempo-net', y_align: Clutter.ActorAlign.CENTER});
        this._netBox.layout_manager.orientation = Clutter.Orientation.VERTICAL;
        this._netSlots = [];
        const line = arrow => {
            const value = new St.Label({
                text: '0K',
                style_class: 'tempo-net-value',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const bin = new St.Bin({style_class: 'tempo-net-slot', child: value});
            const row = new St.BoxLayout({style_class: 'tempo-net-line'});
            row.add_child(new St.Label({
                text: arrow,
                style_class: 'tempo-net-arrow',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(bin);
            this._netBox.add_child(row);
            this._netSlots.push({bin, value});
            return value;
        };
        this._netDown = line('↓');
        this._netUp = line('↑');
        // The font is only known once the theme has been applied, and can change with it.
        this._netDown.connect('style-changed', () => this._sizeNetSlots());
        // Shown only when everything else is switched off, so the menu stays reachable.
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/icons/tempo-symbolic.svg`),
            style_class: 'system-status-icon',
            visible: false,
        });
        box.add_child(this._bars.actor);
        box.add_child(this._cpuRing.actor);
        box.add_child(this._memoryRing.actor);
        box.add_child(this._tempLabel);
        box.add_child(this._netBox);
        box.add_child(this._icon);
        this._button.add_child(box);
    }

    // Make each network slot exactly as wide as the widest value it can ever show ("888M"),
    // in the font actually in use. The label measures itself: the sample texts are set and
    // taken away again within one call, so they are never painted. Until this has run, the
    // stylesheet's width applies.
    _sizeNetSlots() {
        if (this._sizingNet)
            return;
        this._sizingNet = true;
        try {
            const label = this._netDown;
            // "style-changed" also comes with every hover and press of the button; the widths
            // only depend on the font, so measure again only when that is another one.
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const font = `${label.get_theme_node().get_font().to_string()} x${scale}`;
            if (font === this._netFont) {
                this._sizingNet = false;
                return;
            }
            this._netFont = font;
            const shown = label.text;
            let widest = 0;
            for (const sample of NET_WIDEST_SAMPLES) {
                label.text = sample;
                widest = Math.max(widest, label.get_preferred_width(-1)[1]);
            }
            label.text = shown;
            widest = Math.ceil(widest);
            if (widest > 0 && widest !== this._netSlotWidth) {
                this._netSlotWidth = widest;
                for (const {bin} of this._netSlots)
                    bin.set_width(widest);
            }
        } catch (e) {
            // keep the stylesheet's width
        }
        this._sizingNet = false;
    }

    _addHeading(text) {
        const item = new PopupMenu.PopupSeparatorMenuItem(text);
        item.add_style_class_name('tempo-heading');
        this._button.menu.addMenuItem(item);
        return item;
    }

    _addRow(title) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'tempo-row',
        });
        const name = new St.Label({text: title, x_expand: true, style_class: 'tempo-key'});
        const value = new St.Label({text: '–', style_class: 'tempo-value'});
        item.add_child(name);
        item.add_child(value);
        this._button.menu.addMenuItem(item);
        return {item, name, value};
    }

    _buildMenu() {
        const menu = this._button.menu;
        menu.box.add_style_class_name('tempo-menu');
        const rows = this._rows = {};

        // What is playing, and where. Only there while something plays; a click goes to the app.
        this._playingItems = [];
        for (let i = 0; i < NOW_PLAYING_MAX; i++) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'tempo-playing'});
            const row = new PlayingRow();
            item.add_child(row.icon);
            item.add_child(row.text);
            item.connect('activate', () => this._goToPlayer(i));
            menu.addMenuItem(item);
            this._playingItems.push({item, row});
        }
        this._showNowPlaying([]);

        this._addHeading(_('Processor'));
        rows.cpu = this._addRow(_('Usage'));
        rows.load = this._addRow(_('Load average'));

        this._addHeading(_('Memory'));
        rows.memory = this._addRow(_('In use'));
        rows.swap = this._addRow(_('Swap'));

        this._tempHeading = this._addHeading(_('Temperature'));
        rows.temperature = this._addRow(_('Processor'));
        rows.gpu = this._addRow(_('Graphics'));
        rows.disk = this._addRow(_('Disk'));
        this._fanRows = [];
        for (let i = 0; i < FAN_ROWS; i++)
            this._fanRows.push(this._addRow(_('Fan')));
        this._buildFanMode();

        this._addHeading(_('Network'));
        rows.network = this._addRow(_('Speed'));

        this._addHeading(_('Busiest apps'));
        this._appRows = [];
        for (let i = 0; i < TOP_PROCESSES; i++)
            this._appRows.push(this._addRow(''));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._musicSwitch = new PopupMenu.PopupSwitchMenuItem(_('Music visuals'), false);
        // Newer GNOME versions also emit "toggled" when the switch is set from code.
        this._musicSwitch.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('music-visuals'))
                this._settings.set_boolean('music-visuals', state);
        });
        menu.addMenuItem(this._musicSwitch);
        this._musicHint = new PopupMenu.PopupMenuItem(_('Music visuals need pulseaudio-utils'),
            {reactive: false, can_focus: false});
        this._musicHint.label.add_style_class_name('tempo-hint');
        this._musicHint.visible = false;
        menu.addMenuItem(this._musicHint);

        // Floating panels: one line in the menu, two switches inside.
        this._floatMenu = new PopupMenu.PopupSubMenuMenuItem(_('Floating panels'));
        this._floatMenu.add_style_class_name('tempo-row');
        this._floatSwitches = {};
        for (const [key, title] of [['float-stats', _('System panel')], ['float-viz', _('Visualizer panel')]]) {
            const item = new PopupMenu.PopupSwitchMenuItem(title, false);
            item.connect('toggled', (_item, state) => {
                if (state !== this._settings.get_boolean(key))
                    this._settings.set_boolean(key, state);
            });
            this._floatMenu.menu.addMenuItem(item);
            this._floatSwitches[key] = item;
        }
        menu.addMenuItem(this._floatMenu);

        this._monitorItem = menu.addAction(_('Open System Monitor'), () => {
            const app = this._findSystemMonitor();
            if (app !== null)
                app.activate();
        });
        menu.addAction(_('Settings'), () => this._openPreferences());

        // A small link to the project's website, at the very bottom.
        const link = new PopupMenu.PopupMenuItem(_('saikatnjm.github.io/tempo'));
        link.add_style_class_name('tempo-link');
        link.label.opacity = 150;            // the menu's own text colour, faded: fine on any theme
        link.connect('activate', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(TEMPO_WEBSITE, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.error(`Tempo: could not open the website: ${e.message}`);
            }
        });
        menu.addMenuItem(link);

        menu.connect('open-state-changed', (_menu, open) => this._onMenuToggled(open));
    }

    // "Fan mode" with three choices, shown only when the tempo-fan service is installed.
    _buildFanMode() {
        const names = {
            cool: _('Cool'),
            max: _('Full speed'),
            auto: _('Automatic'),
        };
        const details = {
            cool: _('Cool: rises from 60 °C, full at 85 °C'),
            max: _('Full speed'),
            auto: _('Automatic: the computer decides'),
        };
        this._fanModeNames = names;
        this._fanMode = new PopupMenu.PopupSubMenuMenuItem(_('Fan mode'));
        this._fanMode.add_style_class_name('tempo-row');
        this._fanModeItems = new Map();
        for (const mode of FAN_MODES) {
            const item = new PopupMenu.PopupMenuItem(details[mode]);
            item.connect('activate', () => this._setFanMode(mode));
            this._fanMode.menu.addMenuItem(item);
            this._fanModeItems.set(mode, item);
        }
        this._fanMode.visible = false;
        this._button.menu.addMenuItem(this._fanMode);
    }

    // Is the fan service installed, and which mode is it in? Asked when the menu opens, when the
    // system panel appears, and once in a long while as long as that panel is shown.
    _syncFanMode() {
        const file = Gio.File.new_for_path(FAN_MODE_FILE);
        file.query_info_async('access::can-write', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW,
            this._cancellable, (f, result) => {
                let writable = false;
                try {
                    writable = f.query_info_finish(result).get_attribute_boolean('access::can-write');
                } catch (e) {
                    // not installed
                }
                if (this._destroyed)
                    return;
                this._fanMode.visible = writable;
                if (!writable) {
                    this._stats?.setFanMode(null);
                    return;
                }
                readTextAsync(FAN_MODE_FILE, this._cancellable, text => {
                    const mode = (text ?? '').trim();
                    this._showFanMode(FAN_MODES.includes(mode) ? mode : 'cool');
                });
            });
    }

    _showFanMode(mode) {
        setLabel(this._fanMode.label, `${_('Fan mode')}: ${this._fanModeNames[mode]}`);
        this._stats?.setFanMode(this._fanModeNames[mode]);
        const dot = PopupMenu.Ornament.DOT ?? PopupMenu.Ornament.CHECK;
        for (const [m, item] of this._fanModeItems)
            item.setOrnament(m === mode ? dot : PopupMenu.Ornament.NONE);
    }

    _setFanMode(mode) {
        const bytes = new GLib.Bytes(new TextEncoder().encode(`${mode}\n`));
        Gio.File.new_for_path(FAN_MODE_FILE).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.NONE, this._cancellable, (f, result) => {
                try {
                    f.replace_contents_finish(result);
                } catch (e) {
                    console.error(`Tempo: could not change the fan mode: ${e.message}`);
                    return;
                }
                if (!this._destroyed)
                    this._showFanMode(mode);
            });
    }

    _findSystemMonitor() {
        const apps = Shell.AppSystem.get_default();
        for (const id of SYSTEM_MONITOR_APPS) {
            const app = apps.lookup_app(id);
            if (app)
                return app;
        }
        return null;
    }

    // Show only the rows this machine actually has sensors for.
    _applySensors() {
        const s = this._sensors;
        const rows = this._rows;
        rows.temperature.item.visible = s.cpu !== null;
        rows.gpu.item.visible = s.gpu !== null;
        rows.disk.item.visible = s.disk !== null;
        this._fanRows.forEach((row, i) => (row.item.visible = i === 0 && s.fans.length > 0));
        this._tempHeading.visible = s.cpu !== null || s.gpu !== null || s.disk !== null ||
            s.fans.length > 0;
    }

    // ---- timers ------------------------------------------------------------------------------

    _setTimer(name, milliseconds, callback) {
        this._clearTimer(name);
        if (this._destroyed)
            return;
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            this._timers.delete(name);
            try {
                callback();
            } catch (e) {
                console.error(`Tempo: ${e}\n${e.stack ?? ''}`);
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    _clearTimer(name) {
        const id = this._timers.get(name);
        if (id !== undefined) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    // The refresh timer exists only while there is something to refresh.
    _syncRefreshTimer() {
        // The top bar's own readings count only while the top bar can be seen, and the system
        // panel's only while no fullscreen window covers its screen.
        const bar = !this._fullscreenOn(Main.layoutManager.primaryMonitor) && (this._showCpu ||
            this._showMemory || this._showNetwork || this._showTemperature);
        const panel = this._stats !== null && !this._fullscreenOn(this._monitorOf(this._stats.panel.actor));
        const needed = !this._destroyed && !this._screenOff && (bar || panel || this._button.menu.isOpen);
        if (needed && this._refreshId && this._refreshInterval === this._interval)
            return;
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        if (!needed)
            return;
        this._refreshInterval = this._interval;
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, this._interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- settings ----------------------------------------------------------------------------

    _applySettings() {
        if (this._destroyed)
            return;
        const s = this._settings;
        this._showCpu = s.get_boolean('show-cpu');
        this._showMemory = s.get_boolean('show-memory');
        this._showTemperature = s.get_boolean('show-temperature');
        this._showNetwork = s.get_boolean('show-network');
        this._fahrenheit = s.get_string('temperature-unit') === 'fahrenheit';
        this._interval = clamp(s.get_int('refresh-interval'), REFRESH_MIN_S, REFRESH_MAX_S);
        this._floatStatsOn = s.get_boolean('float-stats');
        this._vizOn = s.get_boolean('float-viz');

        const name = s.get_string('palette');
        this._palette = PALETTES.has(name) ? PALETTES.get(name) : PALETTES.get(DEFAULT_PALETTE);
        this._cpuRing.setColor(this._palette ? this._palette.cpu : null);
        this._memoryRing.setColor(this._palette ? this._palette.memory : null);
        this._bars.setPalette(this._palette ? this._palette.bars : null);

        // One view at a time: a floating panel replaces its part of the top bar while it is on.
        if (this._floatStatsOn)
            this._showCpu = this._showMemory = this._showTemperature = this._showNetwork = false;
        this._syncVisibility();
        this._syncFloats();
        this._syncMusic();
        this._syncStrip();
        this._syncMusicActors();
        this._syncRefreshTimer();
        if (this._celsius !== null)
            this._showTemperatureValue(this._celsius);
        this._refresh();
    }

    _syncVisibility() {
        // The temperature only appears once there is a reading to show.
        const temperature = this._showTemperature && this._sensors.cpu !== null &&
            this._celsius !== null;
        this._cpuRing.actor.visible = this._showCpu;
        this._memoryRing.actor.visible = this._showMemory;
        this._tempLabel.visible = temperature;
        this._netBox.visible = this._showNetwork;
        this._icon.visible = !(this._showCpu || this._showMemory || temperature ||
            this._showNetwork || this._barsShown);
    }

    // ---- system readings ---------------------------------------------------------------------

    _refresh() {
        if (this._destroyed)
            return;
        try {
            this._sample();
        } catch (e) {
            console.error(`Tempo: ${e}\n${e.stack ?? ''}`);
        }
    }

    _sample() {
        if (this._screenOff)
            return;
        const menuOpen = this._button.menu.isOpen;
        const maxAge = this._interval * 3 + 2;
        const count = this._samples++;

        const panel = this._stats;
        if (this._showCpu || menuOpen || panel) {
            const cpu = this._sampler.cpu(maxAge);
            if (cpu !== null) {
                this._cpu = cpu;
                this._cpuRing.set(cpu);
                panel?.setCpu(cpu);
            }
        }
        if (this._showMemory || menuOpen || panel) {
            const memory = this._sampler.memory();
            if (memory !== null) {
                this._memory = memory;
                const used = (memory.total - memory.available) / memory.total;
                this._memoryRing.set(used);
                panel?.setMemory(used);
            }
        }
        if (this._showNetwork || menuOpen || panel) {
            const network = this._sampler.network(maxAge);
            if (network !== null) {
                this._network = network;
                setLabel(this._netDown, formatRateCompact(network.down));
                setLabel(this._netUp, formatRateCompact(network.up));
                panel?.setNetwork(network.down, network.up);
            }
        }
        if (this._showTemperature || menuOpen || panel) {
            if (this._sensors.cpu !== null) {
                readTextAsync(this._sensors.cpu, this._cancellable,
                    text => this._onTemperature(text));
            } else if (count >= this._sensorSearchAt) {
                // No sensor (yet): its driver may load late, or come back after a reload. Look
                // again now and then, less and less often.
                this._sensorSearchGap = Math.min(SENSOR_SEARCH_MAX, this._sensorSearchGap * 4);
                this._sensorSearchAt = count + this._sensorSearchGap;
                this._rescanSensors();
            }
        }
        if (this._sensors.fans.length > 0) {
            // One reading serves the menu and the panel alike.
            if (menuOpen || (panel !== null && count % FAN_EVERY === 0))
                this._refreshFans();
            if (panel !== null && count % FAN_MODE_EVERY === 0)
                this._syncFanMode();
        }
        if (menuOpen)
            this._refreshMenu();
    }

    _onTemperature(text) {
        const milli = text === null ? NaN : parseInt(text, 10);
        if (!Number.isFinite(milli)) {
            this._sensorMisses++;
            if (this._sensorMisses === TEMP_MISSES_BEFORE_RESCAN && this._celsius !== null) {
                // The sensor stopped answering: better no number than a stale one.
                this._celsius = null;
                setLabel(this._rows.temperature.value, '–');
                this._syncVisibility();
            }
            // Sensor numbering can change when a driver reloads, so look again; less and less
            // often if that doesn't help.
            if (this._sensorMisses >= this._sensorRescanAt) {
                this._sensorRescanAt *= 4;
                this._rescanSensors();
            }
            return;
        }
        this._sensorMisses = 0;
        this._sensorRescanAt = TEMP_MISSES_BEFORE_RESCAN;
        const first = this._celsius === null;
        this._celsius = milli / 1000;
        this._showTemperatureValue(this._celsius);
        if (first)
            this._syncVisibility();
    }

    _rescanSensors() {
        this._sensors = findSensors();
        if (this._sensors.cpu !== null) {
            // Found: should it go missing again, start looking soon again.
            this._sensorSearchGap = SENSOR_SEARCH_FIRST;
            this._sensorSearchAt = this._samples + SENSOR_SEARCH_FIRST;
        }
        this._applySensors();
        this._syncVisibility();
        this._syncFloats();                  // the system panel shows a fan only if there is one
        this._syncRefreshTimer();
    }

    _showTemperatureValue(celsius) {
        setLabel(this._tempLabel, formatTemperature(celsius, this._fahrenheit, false));
        const cls = celsius >= TEMP_HOT_C ? 'tempo-hot' : celsius >= TEMP_WARM_C ? 'tempo-warm' : '';
        if (cls !== this._tempClass) {
            if (this._tempClass)
                this._tempLabel.remove_style_class_name(this._tempClass);
            if (cls)
                this._tempLabel.add_style_class_name(cls);
            this._tempClass = cls;
        }
        setLabel(this._rows.temperature.value, formatTemperature(celsius, this._fahrenheit, true));
        this._stats?.setTemperature(celsius, this._fahrenheit);
    }

    // ---- menu --------------------------------------------------------------------------------

    _onMenuToggled(open) {
        if (this._destroyed)
            return;
        if (!open) {
            this._clearTimer('followup');
            this._procs.cancel();
            this._syncRefreshTimer();
            return;
        }
        this._hideTip();
        // Readings that weren't being kept up to date are stale: show a placeholder instead.
        if (!this._showCpu)
            this._cpu = null;
        if (!this._showNetwork)
            this._network = null;
        this._procs.reset();
        this._showProcesses(null);
        this._syncFanMode();
        this._monitorItem.visible = this._findSystemMonitor() !== null;
        this._syncRefreshTimer();
        this._refresh();
        this._setTimer('followup', MENU_FOLLOWUP_MS, () => this._refresh());
    }

    _refreshMenu() {
        const rows = this._rows;

        // "26%  ·  1.73 GHz" where the kernel reports the clock speed, just "26%" elsewhere.
        const usage = this._cpu === null ? '…' : `${Math.round(this._cpu * 100)}%`;
        setLabel(rows.cpu.value, this._ghz ? `${usage}  ·  ${this._ghz}` : usage);
        readTextAsync('/proc/cpuinfo', this._cancellable, text => {
            const mhz = parseCpuMhz(text);
            this._ghz = mhz === null ? '' : `${(mhz / 1000).toFixed(2)} GHz`;
            setLabel(rows.cpu.value, this._ghz ? `${usage}  ·  ${this._ghz}` : usage);
        });
        const load = (readText('/proc/loadavg') ?? '').split(' ');
        setLabel(rows.load.value, load.length >= 3 ? load.slice(0, 3).join('  ') : '–');

        const memory = this._memory;
        if (memory !== null) {
            setLabel(rows.memory.value,
                `${formatGiB(memory.total - memory.available)} / ${formatGiB(memory.total)}`);
            setLabel(rows.swap.value, memory.swapTotal > 0
                ? `${formatGiB(memory.swapTotal - memory.swapFree)} / ${formatGiB(memory.swapTotal)}`
                : _('Off'));
        }

        const network = this._network;
        setLabel(rows.network.value, network === null ? '…'
            : `↓ ${formatRateLong(network.down)}   ↑ ${formatRateLong(network.up)}`);

        for (const key of ['gpu', 'disk']) {
            const path = this._sensors[key];
            if (path === null)
                continue;
            readTextAsync(path, this._cancellable, text => {
                const milli = text === null ? NaN : parseInt(text, 10);
                setLabel(rows[key].value, Number.isFinite(milli)
                    ? formatTemperature(milli / 1000, this._fahrenheit, true) : '–');
            });
        }
        this._procs.scan();
        this._updateNowPlaying();
    }

    // A readable name for a fan: its own label if the driver gives one ("CPU Fan"), otherwise
    // "Graphics" for a graphics-card fan, else "Fan 2" and so on.
    _fanName(fan) {
        if (fan.label)
            return fan.label;
        if (fan.graphics)
            return _('Graphics fan');
        return _('Fan %d').replace('%d', String(fan.number));
    }

    // Read every fan on a worker thread; `done(shown)` gets the ones that matter (fansToShow()).
    _readFanSpeeds(done) {
        const fans = this._sensors.fans;
        if (fans.length === 0)
            return;
        const readings = [];
        for (const fan of fans) {
            readTextAsync(fan.path, this._cancellable, text => {
                readings.push({
                    name: this._fanName(fan),
                    numbered: !fan.label && !fan.graphics,
                    rpm: text === null ? NaN : parseInt(text, 10),
                    priority: fan.priority,
                });
                if (readings.length < fans.length)
                    return;
                const shown = fansToShow(readings, FAN_MAX_RPM, FAN_ROWS);
                // A lone fan without a label of its own is just "Fan", not "Fan 1".
                if (shown.length === 1 && readings.find(r => r.name === shown[0].name)?.numbered)
                    shown[0].name = _('Fan');
                done(shown);
            });
        }
    }

    // The fans that matter, for the menu (while it is open) and the system panel.
    _refreshFans() {
        this._readFanSpeeds(shown => {
            this._stats?.setFan(shown.length > 0 ? shown[0].rpm : null);
            if (this._button.menu.isOpen)
                this._showFanRows(shown);
        });
    }

    _showFanRows(shown) {
        this._fanRows.forEach((row, i) => {
            const fan = shown[i];
            row.item.visible = fan !== undefined || (i === 0 && shown.length === 0);
            if (fan === undefined) {
                setLabel(row.name, _('Fan'));
                setLabel(row.value, '–');
                return;
            }
            setLabel(row.name, fan.name);
            setLabel(row.value, fan.rpm === 0 ? _('Stopped') : `${fan.rpm} RPM`);
        });
    }

    _showProcesses(list) {
        for (let i = 0; i < this._appRows.length; i++) {
            const row = this._appRows[i];
            const entry = list === null ? undefined : list[i];
            if (entry !== undefined) {
                setLabel(row.name, entry.name);
                setLabel(row.value, `${(entry.share * 100).toFixed(1)}%`);
            } else {
                setLabel(row.name, list === null && i === 0 ? _('Measuring…') : '');
                setLabel(row.value, '');
            }
        }
    }

    // ---- what is playing, and where ----------------------------------------------------------

    // The installed app behind a player, for its icon, its proper name, and to go to it.
    _findPlayerApp(entry) {
        const apps = Shell.AppSystem.get_default();
        if (entry.desktopEntry) {
            const app = apps.lookup_app(`${entry.desktopEntry}.desktop`);
            if (app)
                return app;
        }
        // "org.mpris.MediaPlayer2.brave.instance123" -> "brave"
        const token = entry.bus.slice(MPRIS_PREFIX.length).split('.')[0].toLowerCase();
        if (!token)
            return null;
        const exact = apps.lookup_app(`${token}.desktop`);
        if (exact)
            return exact;
        for (const app of apps.get_running()) {
            if (app.get_id().toLowerCase().includes(token))
                return app;
        }
        return null;
    }

    _updateNowPlaying() {
        if (this._players === null) {
            this._showNowPlaying([]);
            return;
        }
        this._players.describe(list => {
            if (!this._destroyed)
                this._showNowPlaying(list);
        });
    }

    _showNowPlaying(list) {
        this._nowPlaying = list.map(entry => ({entry, app: this._findPlayerApp(entry)}));
        this._playingItems.forEach(({item, row}, i) => {
            const playing = this._nowPlaying[i];
            item.visible = playing !== undefined;
            if (playing !== undefined)
                row.fill(playing.entry, playing.app);
        });
    }

    _goToPlayer(index) {
        const playing = this._nowPlaying[index];
        if (playing === undefined)
            return;
        if (playing.app)
            playing.app.activate();
        else if (this._players !== null)
            this._players.raise(playing.entry.bus);
    }

    // Resting the pointer on the music bars shows what is playing, and in which app.
    _onBarsHover() {
        if (this._destroyed)
            return;
        if (this._bars.actor.hover && this._barsShown && !this._button.menu.isOpen) {
            this._setTimer('tip', TIP_DELAY_MS, () => this._showTip());
        } else {
            this._clearTimer('tip');
            this._hideTip();
        }
    }

    _showTip() {
        if (this._players === null || !this._bars.actor.hover || this._button.menu.isOpen)
            return;
        this._players.describe(list => {
            if (this._destroyed || list.length === 0 || !this._bars.actor.hover ||
                this._button.menu.isOpen)
                return;
            if (this._tip === null) {
                this._tip = new St.BoxLayout({style_class: 'tempo-tip', reactive: false});
                this._tip.layout_manager.orientation = Clutter.Orientation.VERTICAL;
                for (let i = 0; i < NOW_PLAYING_MAX; i++) {
                    const row = new PlayingRow();
                    const line = new St.BoxLayout({style_class: 'tempo-playing'});
                    line.add_child(row.icon);
                    line.add_child(row.text);
                    this._tip.add_child(line);
                    this._tipRows.push({line, row});
                }
                Main.layoutManager.addChrome(this._tip, {...CHROME_PARAMS});
            }
            this._tipRows.forEach(({line, row}, i) => {
                line.visible = i < list.length;
                if (i < list.length)
                    row.fill(list[i], this._findPlayerApp(list[i]));
            });

            // Centred under the bars, kept on the screen.
            const tip = this._tip;
            const bars = this._bars.actor;
            const [x, y] = bars.get_transformed_position();
            const [barsWidth] = bars.get_transformed_size();
            const [, width] = tip.get_preferred_width(-1);
            const monitor = Main.layoutManager.findMonitorForActor(this._button) ??
                Main.layoutManager.primaryMonitor;
            const panelBox = Main.layoutManager.panelBox;
            const margin = 6;
            let left = Math.round(x + barsWidth / 2 - width / 2);
            if (monitor) {
                left = Math.max(monitor.x + margin,
                    Math.min(left, monitor.x + monitor.width - width - margin));
            }
            const top = Math.max(panelBox.y + panelBox.height, Math.round(y)) + margin;
            tip.set_position(left, top);
            Main.uiGroup.set_child_above_sibling(tip, null);
            tip.remove_all_transitions();
            tip.opacity = 0;
            tip.show();
            tip.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    _hideTip() {
        const tip = this._tip;
        if (tip === null || !tip.visible)
            return;
        tip.remove_all_transitions();
        tip.ease({
            opacity: 0,
            duration: FADE_MS / 2,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => tip.hide(),
        });
    }

    _removeTip() {
        if (this._tip === null)
            return;
        this._tip.remove_all_transitions();
        Main.layoutManager.removeChrome(this._tip);
        this._tip.destroy();
        this._tip = null;
        this._tipRows = [];
    }

    // ---- floating panels ---------------------------------------------------------------------

    _syncFloats() {
        if (this._destroyed)
            return;
        const s = this._settings;
        this._floatSwitches['float-stats'].setToggleState(this._floatStatsOn);
        this._floatSwitches['float-viz'].setToggleState(this._vizOn);
        const layer = s.get_string('float-layer');
        const look = s.get_string('float-background');

        if (this._floatStatsOn) {
            const fresh = this._stats === null;
            if (fresh)
                this._stats = new StatsPanel(s);
            // The fan appears by itself when the computer reports a fan speed.
            const rebuilt = this._stats.setDesign(s.get_string('float-stats-design'), this._palette,
                this._sensors.fans.length > 0);
            this._stats.panel.setLook(look);
            this._stats.panel.setLayer(layer);
            this._stats.setPaused(this._screenOff);
            if (fresh || rebuilt)
                this._fillStats();
        } else if (this._stats !== null) {
            this._stats.destroy();
            this._stats = null;
        }

        if (this._vizOn) {
            if (this._vizPanel === null) {
                this._viz = new VizWidget();
                this._vizPanel = new FloatPanel({
                    name: 'Tempo visualizer',
                    content: this._viz.actor,
                    settings: s,
                    rectKey: 'float-viz-rect',
                    defaultSize: [360, 120],
                });
            }
            this._viz.setStyle(s.get_string('float-viz-design'));
            this._viz.setPalette(this._palette ? this._palette.bars : null);
            this._vizPanel.setLook(look);
            this._vizPanel.setLayer(layer);
        } else if (this._vizPanel !== null) {
            this._vizPanel.destroy();
            this._vizPanel = null;
            this._viz = null;
        }
        this._syncRefreshTimer();
    }

    // Show the latest readings at once, so a new panel doesn't start empty.
    _fillStats() {
        if (this._cpu !== null)
            this._stats.setCpu(this._cpu);
        if (this._memory !== null)
            this._stats.setMemory((this._memory.total - this._memory.available) / this._memory.total);
        if (this._celsius !== null)
            this._stats.setTemperature(this._celsius, this._fahrenheit);
        if (this._network !== null)
            this._stats.setNetwork(this._network.down, this._network.up);
        if (this._sensors.fans.length > 0) {
            this._refreshFans();
            this._syncFanMode();
        }
    }

    _removeFloats() {
        this._stats?.destroy();
        this._stats = null;
        this._vizPanel?.destroy();
        this._vizPanel = null;
        this._viz = null;
    }

    // ---- music visuals -----------------------------------------------------------------------

    _syncMusic() {
        // The recorder serves the top-bar music visuals and the visualizer panel alike.
        // The top-bar music visuals give way to the visualizer panel while it is on.
        this._musicOn = this._settings.get_boolean('music-visuals') && !this._vizOn;
        const wanted = this._musicOn || this._vizOn;
        this._musicStyle = this._settings.get_string('music-style');
        const fps = clamp(this._settings.get_int('music-fps'), FPS_MIN, FPS_MAX);
        const available = AudioCapture.available();
        this._musicSwitch.setToggleState(this._settings.get_boolean('music-visuals'));
        this._musicHint.visible = wanted && !available;

        if (!wanted || !available) {
            if (this._players !== null)
                this._players.destroy();
            this._players = null;
            this._playing = false;
            this._clearTimer('grace');
            this._clearTimer('retry');
            this._stopCapture();
            this._showNowPlaying([]);
            return;
        }
        const bands = this._vizOn ? VIZ_BANDS : BAR_COUNT;
        if (fps !== this._fps || bands !== this._bands) {
            this._fps = fps;
            this._bands = bands;
            if (this._capture !== null) {
                this._stopCapture();
                this._startCapture();
            }
        }
        if (this._players === null) {
            this._captureFailures = 0;
            this._players = new PlayerWatch(playing => this._onPlaying(playing));
        }
        // The visualizer panel may just have appeared, gone, or moved to another screen.
        this._onFullscreenChanged();
    }

    _onPlaying(playing) {
        this._playing = playing;
        if (playing) {
            this._clearTimer('grace');
            this._captureFailures = 0;
            this._startCapture();
        } else {
            this._clearTimer('retry');
            if (this._capture !== null)
                this._setTimer('grace', STOP_GRACE_MS, () => this._stopCapture());
        }
        if (this._button.menu.isOpen)
            this._updateNowPlaying();
    }

    // The screen an actor is on, from the place it was given. (That is known at once, unlike its
    // position on the stage, which GNOME Shell only works out when it next lays the screen out.)
    _monitorOf(actor) {
        const x = actor.x + actor.width / 2, y = actor.y + actor.height / 2;
        const layout = Main.layoutManager;
        return layout.monitors.find(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ??
            layout.primaryMonitor;
    }

    _fullscreenOn(monitor) {
        return Boolean(monitor && monitor.inFullscreen);
    }

    // A fullscreen window covers the music visuals: the top bar's on the main screen, the
    // visualizer panel's on whichever screen it sits.
    _musicHidden() {
        return this._fullscreenOn(this._vizPanel !== null
            ? this._monitorOf(this._vizPanel.actor)
            : Main.layoutManager.primaryMonitor);
    }

    // A fullscreen window came or went, or a panel moved to another screen.
    _onFullscreenChanged() {
        if (this._destroyed)
            return;
        if (this._musicHidden()) {
            if (this._capture !== null)
                this._stopCapture();
        } else {
            this._startCapture();
        }
        const reading = this._refreshId !== 0;
        this._syncRefreshTimer();
        if (!reading && this._refreshId !== 0)
            this._catchUp();
    }

    // Screens off: nobody is looking, so nothing is read, listened to or animated until they
    // are back on.
    _onScreenPower(off) {
        if (this._destroyed)
            return;
        this._screenOff = off;
        this._stats?.setPaused(off);
        if (off) {
            if (this._capture !== null)
                this._stopCapture();
        } else {
            this._startCapture();
        }
        this._syncRefreshTimer();
        if (!off)
            this._catchUp();
    }

    // After a pause: fresh numbers at once, and again shortly after (rates need two readings).
    _catchUp() {
        this._refresh();
        this._setTimer('warmup', MENU_FOLLOWUP_MS, () => this._refresh());
    }

    _startCapture() {
        if (this._destroyed || this._capture !== null || this._players === null || !this._playing ||
            this._screenOff || this._musicHidden())
            return;
        const capture = new AudioCapture({
            bars: this._bands,
            fps: this._fps,
            onLevels: (levels, changed) => this._onLevels(levels, changed),
            onExit: quick => this._onCaptureExit(quick),
        });
        if (capture.start())
            this._capture = capture;
        else
            this._onCaptureExit(true);
    }

    _stopCapture() {
        this._clearTimer('silence');
        this._clearTimer('output');
        if (this._capture !== null)
            this._capture.stop();
        this._capture = null;
        this._clearLevels();
        this._setSoundVisible(false);
    }

    // The recorder ended by itself: the sound server restarted, or it could not start at all.
    _onCaptureExit(quick) {
        this._capture = null;
        this._clearTimer('silence');
        this._clearLevels();
        this._setSoundVisible(false);
        this._captureFailures = quick ? this._captureFailures + 1 : 0;
        if (this._playing && this._captureFailures < CAPTURE_MAX_FAILURES)
            this._setTimer('retry', CAPTURE_RETRY_MS, () => this._startCapture());
    }

    // A stream stays on the output it started on, so follow the user to new speakers/headphones.
    _onOutputChanged() {
        if (this._capture === null)
            return;
        this._setTimer('output', SINK_CHANGE_DELAY_MS, () => {
            if (this._capture === null)
                return;
            this._stopCapture();
            this._startCapture();
        });
    }

    _clearLevels() {
        this._bars.clear();
        if (this._strip !== null)
            this._strip.clear();
        this._viz?.clear();
    }

    _onLevels(levels, changed) {
        if (!changed) {
            // Nothing new to show. Only the visualizer's peak caps may still be falling.
            if (this._viz !== null && this._viz.settling)
                this._viz.settle();
            return;
        }
        // Exactly one of the three is on screen, and the recorder works in its number of bands.
        if (this._viz !== null) {
            if (levels.length === VIZ_BANDS)
                this._viz.setLevels(levels);
        } else if (this._musicOn && levels.length === BAR_COUNT) {
            if (this._strip !== null)
                this._strip.setLevels(levels);
            else
                this._bars.setLevels(levels);
        }
        let sound = false;
        for (let i = 0; i < levels.length; i++) {
            if (levels[i] > 0) {
                sound = true;
                break;
            }
        }
        if (sound) {
            this._clearTimer('silence');
            this._setSoundVisible(true);
        } else if (this._soundVisible && !this._timers.has('silence')) {
            this._setTimer('silence', SILENCE_HIDE_MS, () => this._setSoundVisible(false));
        }
    }

    _setSoundVisible(visible) {
        if (visible === this._soundVisible)
            return;
        this._soundVisible = visible;
        this._syncMusicActors();
    }

    // Fade the small bars and the level line in or out, to match the sound and the chosen style.
    _syncMusicActors() {
        const bars = this._soundVisible && this._musicOn && this._musicStyle !== 'strip';
        if (bars !== this._barsShown) {
            this._barsShown = bars;
            const actor = this._bars.actor;
            actor.remove_all_transitions();
            if (bars) {
                actor.opacity = 0;
                actor.show();
                actor.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                this._clearTimer('tip');
                this._hideTip();
                actor.ease({
                    opacity: 0,
                    duration: FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (!this._barsShown)
                            actor.hide();
                    },
                });
            }
        }
        this._fadeStrip();
        this._syncVisibility();
    }

    // ---- the level line along the top bar ----------------------------------------------------

    _syncStrip() {
        const wanted = this._musicOn && this._musicStyle !== 'bars';
        if (!wanted) {
            this._removeStrip();
            return;
        }
        if (this._strip === null) {
            this._strip = new StripWidget(BAR_COUNT);
            // Chrome that tracks fullscreen: it hides with the top bar under a fullscreen video.
            Main.layoutManager.addChrome(this._strip.actor, {...CHROME_PARAMS, trackFullscreen: true});
            const panelBox = Main.layoutManager.panelBox;
            Main.uiGroup.set_child_above_sibling(this._strip.actor, panelBox);
            this._panelBoxId = panelBox.connect('notify::allocation', () => this._placeStrip());
            this._strip.setPalette(this._palette ? this._palette.bars : null);
            this._placeStrip();
            this._fadeStrip();
        }
        this._strip.setPalette(this._palette ? this._palette.bars : null);
    }

    // Along the bottom edge of the top bar, wherever that is and however wide.
    _placeStrip() {
        if (this._strip === null)
            return;
        const panelBox = Main.layoutManager.panelBox;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = STRIP_HEIGHT * scale;
        const actor = this._strip.actor;
        actor.set_position(panelBox.x, panelBox.y + Math.max(0, panelBox.height - height));
        actor.set_size(panelBox.width, panelBox.height >= height ? height : 0);
    }

    // The strip is always "shown" (the layout manager owns that flag, for fullscreen windows);
    // it appears and disappears through its opacity, with the sound.
    _fadeStrip() {
        if (this._strip === null)
            return;
        const actor = this._strip.actor;
        actor.remove_all_transitions();
        actor.ease({
            opacity: this._soundVisible ? 255 : 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _removeStrip() {
        if (this._strip === null)
            return;
        if (this._panelBoxId)
            Main.layoutManager.panelBox.disconnect(this._panelBoxId);
        this._panelBoxId = 0;
        this._strip.actor.remove_all_transitions();
        Main.layoutManager.removeChrome(this._strip.actor);
        this._strip.actor.destroy();
        this._strip = null;
    }
}
