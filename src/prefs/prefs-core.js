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
// The fan service (fan/ in the source) is a system service that is installed apart from Tempo.
// How this window offers it depends on the build: tempoFanGroup() comes from fan-installer.js in
// the builds released on GitHub, and from fan-guide.js in the build for extensions.gnome.org,
// which may not run an installer (see tools/build.sh).

const TEMPO_FAN_UNIT = '/etc/systemd/system/tempo-fan.service';
const TEMPO_FAN_MODE_FILE = '/var/lib/tempo-fan/mode';

function tempoFanInstalled() {
    return GLib.file_test(TEMPO_FAN_UNIT, GLib.FileTest.EXISTS) &&
        GLib.file_test(TEMPO_FAN_MODE_FILE, GLib.FileTest.EXISTS);
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
        description: _('Place them anywhere on any screen: drag to move, drag the corner to zoom, drag the right or bottom edge ' +
            'to reshape. A floating panel replaces its part of the top bar while it is on.'),
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
