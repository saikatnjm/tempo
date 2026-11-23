// ---- preferences window ----------------------------------------------------------------------
//
// Plain libadwaita 1.1 widgets only, so the same code runs from GNOME 42 to today.
// The header supplies Adw, Gio, GLib, Gtk and _ (gettext); see tools/build.sh.

function tempoSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    return row;
}

function tempoNumberRow(settings, key, title, subtitle, min, max) {
    const row = new Adw.ActionRow({title, subtitle});
    const spin = Gtk.SpinButton.new_with_range(min, max, 1);
    spin.valign = Gtk.Align.CENTER;
    settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(spin);
    row.activatable_widget = spin;
    return row;
}

// `choices` is a list of [stored value, label shown].
function tempoChoiceRow(window, settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(choice => choice[1])),
    });
    const show = () => {
        const index = choices.findIndex(choice => choice[0] === settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    show();
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice !== undefined && settings.get_string(key) !== choice[0])
            settings.set_string(key, choice[0]);
    });
    let changedId = settings.connect(`changed::${key}`, show);
    window.connect('close-request', () => {
        if (changedId)
            settings.disconnect(changedId);
        changedId = 0;
        return false;
    });
    return row;
}

function tempoLinkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.LinkButton({label: _('Open'), uri, valign: Gtk.Align.CENTER});
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

// ---- optional fan control ----
//
// The fan service needs administrator rights, which Tempo doesn't have. These rows install or
// remove it with the installer that ships inside the extension (fan/install.sh), run through
// pkexec, so GNOME asks for the password with its usual dialog.

const TEMPO_FAN_UNIT = '/etc/systemd/system/tempo-fan.service';
const TEMPO_FAN_PROGRAM = '/usr/local/bin/tempo-fan';
const TEMPO_FAN_MODE_FILE = '/var/lib/tempo-fan/mode';

function tempoFanInstalled() {
    return GLib.file_test(TEMPO_FAN_UNIT, GLib.FileTest.EXISTS) &&
        GLib.file_test(TEMPO_FAN_MODE_FILE, GLib.FileTest.EXISTS);
}

/** Whether two small files have the same contents (false if either cannot be read). */
function tempoSameFile(a, b) {
    try {
        const [, x] = GLib.file_get_contents(a);
        const [, y] = GLib.file_get_contents(b);
        return x.length === y.length && x.every((byte, i) => byte === y[i]);
    } catch (e) {
        return false;
    }
}

function tempoFanGroup(window, extensionPath) {
    const shipped = name => GLib.build_filenamev([extensionPath, 'fan', name]);
    const installer = shipped('install.sh');
    const pkexec = GLib.find_program_in_path('pkexec');
    const group = new Adw.PreferencesGroup({
        title: _('Fan control'),
        description: _('Optional, for computers that start their fans late: runs every fan Linux can control from its temperature, and adds a Fan mode switch to the menu. Needs your password once.'),
    });
    const row = new Adw.ActionRow({title: _('Fan control service')});
    // "Update" shows only when the installed service is older than the one that came with
    // this version of Tempo.
    const update = new Gtk.Button({label: _('Update'), valign: Gtk.Align.CENTER, visible: false});
    update.add_css_class('suggested-action');
    const button = new Gtk.Button({valign: Gtk.Align.CENTER});
    row.add_suffix(update);
    row.add_suffix(button);
    group.add(row);

    const show = () => {
        const installed = tempoFanInstalled();
        const possible = pkexec !== null && GLib.file_test(installer, GLib.FileTest.EXISTS);
        const outdated = installed && possible && !(tempoSameFile(TEMPO_FAN_PROGRAM, shipped('tempo-fan')) &&
            tempoSameFile(TEMPO_FAN_UNIT, shipped('tempo-fan.service')));
        if (!possible)
            row.subtitle = _('Needs pkexec (polkit) and the fan files that come with Tempo');
        else if (outdated)
            row.subtitle = _('Installed. A newer one came with this version of Tempo');
        else if (installed)
            row.subtitle = _('Installed. Choose the mode from the menu: Fan mode');
        else
            row.subtitle = _('Not installed');
        button.label = installed ? _('Remove') : _('Install');
        button.sensitive = possible;
        update.sensitive = possible;
        update.visible = outdated;
    };
    show();

    // action: "install", "update" (the installer again, which keeps the chosen mode) or "remove"
    const run = action => {
        const argv = [pkexec, '/bin/bash', installer];
        if (action === 'remove')
            argv.push('remove');
        button.sensitive = false;
        update.sensitive = false;
        row.subtitle = {install: _('Installing…'), update: _('Updating…'), remove: _('Removing…')}[action];
        let process;
        try {
            process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            show();
            return;
        }
        process.communicate_utf8_async(null, null, (p, result) => {
            let output = '';
            try {
                [, output] = p.communicate_utf8_finish(result);
            } catch (e) {
                // treated like any other failure below
            }
            const status = p.get_if_exited() ? p.get_exit_status() : -1;
            let message;
            if (status === 126 || status === 127)
                message = _('Cancelled');
            else if (status !== 0)
                message = _("That didn't work. Run fan/install.sh in a terminal to see why.");
            else if ((output ?? '').includes('Nothing to control here'))
                message = _('This computer has no fans Linux can control, so nothing was installed.');
            else
                message = {install: _('Fan control installed'), update: _('Fan control updated'), remove: _('Fan control removed')}[action];
            if (window.add_toast)
                window.add_toast(new Adw.Toast({title: message}));
            show();
        });
    };
    button.connect('clicked', () => run(tempoFanInstalled() ? 'remove' : 'install'));
    update.connect('clicked', () => run('update'));
    return group;
}

function fillTempoPreferences(window, settings, metadata, extensionPath) {
    const page = new Adw.PreferencesPage();

    const bar = new Adw.PreferencesGroup({
        title: _('Top bar'),
        description: _('Choose what is always visible. Everything stays one click away in the menu.'),
    });
    bar.add(tempoSwitchRow(settings, 'show-cpu',
        _('Processor ring'), _('Fills up as the processor gets busier')));
    bar.add(tempoSwitchRow(settings, 'show-memory',
        _('Memory ring'), _('Fills up as memory is used')));
    bar.add(tempoSwitchRow(settings, 'show-temperature',
        _('Temperature'), _('Amber above 75 °C, red above 85 °C')));
    bar.add(tempoSwitchRow(settings, 'show-network',
        _('Network speed'), _('Download and upload')));
    page.add(bar);

    const music = new Adw.PreferencesGroup({
        title: _('Music'),
        description: _('Moves with the sound while a media player is playing. Nothing runs while nothing plays.'),
    });
    music.add(tempoSwitchRow(settings, 'music-visuals',
        _('React to music'), _('Reads the speaker output only, never the microphone')));
    music.add(tempoChoiceRow(window, settings, 'music-style',
        _('Show it as'), _('The level line runs along the whole top bar'), [
            ['bars', _('Small bars')],
            ['strip', _('Level line')],
        ]));
    music.add(tempoNumberRow(settings, 'music-fps',
        _('Smoothness'), _('Updates per second. Higher is smoother and uses more processor time'), 5, 30));
    page.add(music);

    const look = new Adw.PreferencesGroup({title: _('Appearance')});
    look.add(tempoChoiceRow(window, settings, 'palette',
        _('Colours'), _('For the rings and the music bars'), [
            ['ember', _('Ember: amber to coral')],
            ['aurora', _('Aurora: blue to violet')],
            ['orchid', _('Orchid: pink to violet')],
            ['mono', _('Mono: same as the top bar text')],
        ]));
    look.add(tempoChoiceRow(window, settings, 'temperature-unit',
        _('Temperature unit'), '', [
            ['celsius', _('Celsius (°C)')],
            ['fahrenheit', _('Fahrenheit (°F)')],
        ]));
    look.add(tempoNumberRow(settings, 'refresh-interval',
        _('Refresh every'), _('Seconds between system readings'), 1, 10));
    page.add(look);

    const floating = new Adw.PreferencesGroup({
        title: _('Floating panels'),
        description: _('Place them anywhere on any screen: drag to move, drag the corner to zoom, drag the right or bottom edge to reshape. A floating panel replaces its part of the top bar while it is on.'),
    });
    floating.add(tempoSwitchRow(settings, 'float-stats',
        _('System panel'), _('Processor, memory, temperature, network and the fan')));
    floating.add(tempoChoiceRow(window, settings, 'float-stats-design',
        _('System panel design'), '', [
            ['rings', _('Rings')],
            ['bars', _('Bars')],
        ]));
    floating.add(tempoSwitchRow(settings, 'float-viz',
        _('Visualizer panel'), _('The music visuals, bigger: more bars the wider you make it')));
    floating.add(tempoChoiceRow(window, settings, 'float-viz-design',
        _('Visualizer design'), '', [
            ['bars', _('Bars')],
            ['mirror', _('Mirror')],
            ['wave', _('Wave')],
        ]));
    floating.add(tempoChoiceRow(window, settings, 'float-background',
        _('Background'), '', [
            ['glass', _('Glass')],
            ['solid', _('Solid')],
            ['clear', _('Clear')],
        ]));
    floating.add(tempoChoiceRow(window, settings, 'float-layer',
        _('Place them'), _('If a panel on the desktop cannot be dragged (desktop icons or X11 take the click), move it while it is on top'), [
            ['desktop', _('On the desktop, behind windows')],
            ['top', _('On top of windows')],
        ]));
    page.add(floating);

    page.add(tempoFanGroup(window, extensionPath));

    const about = new Adw.PreferencesGroup({title: _('About')});
    const version = metadata['version-name'] ?? String(metadata.version ?? '');
    about.add(new Adw.ActionRow({title: 'Tempo', subtitle: _('Version %s').replace('%s', version)}));
    if (metadata.url) {
        about.add(tempoLinkRow(_('Website and source code'), metadata.url, metadata.url));
        about.add(tempoLinkRow(_('Report a problem'), _('Opens the issue tracker'), `${metadata.url}/issues`));
    }
    page.add(about);

    window.add(page);
}
