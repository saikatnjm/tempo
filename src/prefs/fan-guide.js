
// ---- optional fan control: a link to the guide (build for extensions.gnome.org) ---------------
//
// The fan service needs administrator rights. Extensions published on extensions.gnome.org may
// not run an installer with them, so this build carries no installer: it says whether the
// service is there, and links to the website, which shows how to install it by hand. Choosing
// the fan mode from the menu works the same in every build.
//
// Joined after prefs-core.js, which supplies tempoFanInstalled() and tempoLinkRow().

const TEMPO_FAN_GUIDE = 'https://saikatnjm.github.io/tempo/install.html#fan';

function tempoFanGroup() {
    const group = new Adw.PreferencesGroup({
        title: _('Fan control'),
        description: _('Optional, for computers that start their fans late: a small system service runs every fan Linux can ' +
            'control from its temperature, and adds a Fan mode switch to the menu. It is installed apart from Tempo.'),
    });
    group.add(new Adw.ActionRow({
        title: _('Fan control service'),
        subtitle: tempoFanInstalled()
            ? _('Installed. Choose the mode from the menu: Fan mode')
            : _('Not installed'),
    }));
    group.add(tempoLinkRow(_('How to install or remove it'),
        _('Two commands in a terminal, on the website'), TEMPO_FAN_GUIDE));
    return group;
}
