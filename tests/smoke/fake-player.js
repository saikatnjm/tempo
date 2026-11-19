// A stand-in media player for the smoke test: it sits on the session bus, says "Playing", names
// a song, and leaves a marker file when it is asked to come to the front.
const {Gio, GLib} = imports.gi;

const ROOT = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
  </interface>
</node>`;
const PLAYER = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
  </interface>
</node>`;

const out = GLib.getenv('TEMPO_PROBE_OUT') || GLib.get_tmp_dir();
const root = Gio.DBusExportedObject.wrapJSObject(ROOT, {
    Identity: 'Tempo Test Player',
    DesktopEntry: 'tempo-test-player',
    CanRaise: true,
    Raise() {
        GLib.file_set_contents(`${out}/raised`, 'yes\n');
    },
});
const player = Gio.DBusExportedObject.wrapJSObject(PLAYER, {
    PlaybackStatus: 'Playing',
    Metadata: {
        'xesam:title': new GLib.Variant('s', 'Test Song'),
        'xesam:artist': new GLib.Variant('as', ['Test Artist']),
    },
});
Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.tempotest',
    Gio.BusNameOwnerFlags.NONE,
    connection => {
        root.export(connection, '/org/mpris/MediaPlayer2');
        player.export(connection, '/org/mpris/MediaPlayer2');
    }, null, null);
new GLib.MainLoop(null, false).run();
