
// ---- optional fan control: the Install button (builds released on GitHub) ---------------------
//
// The fan service needs administrator rights, which Tempo doesn't have. These rows install or
// remove it with the installer that ships inside the extension (fan/install.sh), run through
// pkexec, so GNOME asks for the password with its usual dialog.
//
// Joined after prefs-core.js, which supplies TEMPO_FAN_UNIT and tempoFanInstalled().

const TEMPO_FAN_PROGRAM = '/usr/local/bin/tempo-fan';

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
