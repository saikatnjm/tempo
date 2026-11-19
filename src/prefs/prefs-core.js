// ---- preferences window ----------------------------------------------------------------------
//
// Plain libadwaita 1.1 widgets only, so the same code runs from GNOME 42 to today.
// The header supplies Adw, Gio, Gtk and _ (gettext); see tools/build.sh.

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

function fillTempoPreferences(window, settings, metadata) {
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
        _('Show it as'), _('The light strip is a row of pixels along the whole top bar'), [
            ['bars', _('Small bars')],
            ['strip', _('Light strip')],
            ['both', _('Bars and light strip')],
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
