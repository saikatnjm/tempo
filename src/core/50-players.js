// ---- players: knows whether any media player is playing --------------------------------------
//
// Uses MPRIS, the standard D-Bus interface that browsers, VLC, Spotify, Rhythmbox and others
// expose. Nothing is polled on a timer: the session bus tells us when a player appears, goes
// away or changes its PlaybackStatus, and only then are the players asked for their state.

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_ROOT = 'org.mpris.MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const PLAYER_DEBOUNCE_MS = 200;
const PLAYER_TIMEOUT_MS = 1000;
const NOW_PLAYING_MAX = 3;

/** Whatever a player sent, as a plain string of sensible length. */
function playerText(value) {
    if (Array.isArray(value))
        value = value.filter(v => typeof v === 'string').join(', ');
    return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

class PlayerWatch {
    /** @param {function(boolean): void} onChange - called when "something is playing" flips */
    constructor(onChange) {
        this._onChange = onChange;
        this._playing = false;
        this._playingNames = [];
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._debounceId = 0;
        this._generation = 0;
        this._describing = 0;

        this._propertiesId = this._bus.signal_subscribe(
            null, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', MPRIS_PATH, MPRIS_PLAYER,
            Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _iface, _signal, params) => this._onProperties(params));
        this._namesId = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            () => this._schedule());
        this._poll();
    }

    get playing() {
        return this._playing;
    }

    /**
     * Ask the playing players what they are and what they are playing. Only called while the
     * menu is open. `callback(list)` gets up to NOW_PLAYING_MAX entries
     * {bus, app, desktopEntry, title, artist}; whatever a player does not tell stays ''.
     */
    describe(callback) {
        const names = this._playingNames.slice(0, NOW_PLAYING_MAX);
        if (names.length === 0) {
            callback([]);
            return;
        }
        // Only the newest question is answered: an older one may arrive late, with stale names.
        const asked = ++this._describing;
        const list = names.map(bus => ({bus, app: '', desktopEntry: '', title: '', artist: ''}));
        let pending = names.length * 2;
        const done = () => {
            if (--pending === 0 && asked === this._describing && !this._cancellable.is_cancelled())
                callback(list);
        };
        list.forEach(entry => {
            this._getAll(entry.bus, MPRIS_ROOT, properties => {
                entry.app = playerText(properties.Identity);
                entry.desktopEntry = playerText(properties.DesktopEntry);
                done();
            });
            this._getAll(entry.bus, MPRIS_PLAYER, properties => {
                const metadata = properties.Metadata;
                if (metadata !== null && typeof metadata === 'object') {
                    entry.title = playerText(metadata['xesam:title']);
                    entry.artist = playerText(metadata['xesam:artist']);
                }
                done();
            });
        });
    }

    /** Ask a player to bring its own window forward. Players may ignore this. */
    raise(busName) {
        this._bus.call(busName, MPRIS_PATH, MPRIS_ROOT, 'Raise', null, null,
            Gio.DBusCallFlags.NONE, PLAYER_TIMEOUT_MS, this._cancellable, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (e) {
                    // not supported by this player, or it just left
                }
            });
    }

    _getAll(busName, iface, callback) {
        this._bus.call(busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [iface]), new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE, PLAYER_TIMEOUT_MS, this._cancellable, (bus, result) => {
                let properties = {};
                try {
                    [properties] = bus.call_finish(result).recursiveUnpack();
                } catch (e) {
                    // the player left or did not answer: nothing known about it
                }
                callback(properties);
            });
    }

    destroy() {
        this._bus.signal_unsubscribe(this._propertiesId);
        this._bus.signal_unsubscribe(this._namesId);
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        this._cancellable.cancel();
        this._generation++;
    }

    // Players also announce track changes, volume and so on; only PlaybackStatus matters here.
    _onProperties(params) {
        let relevant = true;
        try {
            relevant = params.get_child_value(1).lookup_value('PlaybackStatus', null) !== null ||
                params.get_child_value(2).deep_unpack().includes('PlaybackStatus');
        } catch (e) {
            // an oddly shaped signal: just ask the players
        }
        if (relevant)
            this._schedule();
    }

    _schedule() {
        if (this._debounceId)
            return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLAYER_DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _poll() {
        const generation = ++this._generation;
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (bus, result) => {
                let names;
                try {
                    [names] = bus.call_finish(result).deep_unpack();
                } catch (e) {
                    return;
                }
                if (generation !== this._generation)
                    return;
                const players = names.filter(name => name.startsWith(MPRIS_PREFIX));
                if (players.length === 0) {
                    this._playingNames = [];
                    this._set(false);
                    return;
                }
                let pending = players.length;
                const playing = [];
                for (const name of players) {
                    bus.call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                        new GLib.Variant('(ss)', [MPRIS_PLAYER, 'PlaybackStatus']),
                        new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, PLAYER_TIMEOUT_MS,
                        this._cancellable, (b, r) => {
                            try {
                                const [status] = b.call_finish(r).deep_unpack();
                                if (status.unpack() === 'Playing')
                                    playing.push(name);
                            } catch (e) {
                                // the player left or did not answer: it counts as not playing
                            }
                            if (--pending === 0 && generation === this._generation) {
                                this._playingNames = playing.sort();
                                this._set(playing.length > 0);
                            }
                        });
                }
            });
    }

    _set(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        this._onChange(playing);
    }
}
