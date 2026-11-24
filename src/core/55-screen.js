// ---- screen: knows whether the screens are switched off --------------------------------------
//
// GNOME blanks the screens after a while without input. Mutter says so through the PowerSaveMode
// property of org.gnome.Mutter.DisplayConfig (the one GNOME's own power settings use). Nothing is
// polled: the property is read once, and after that the session bus reports each change.

const DISPLAY_CONFIG = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';

/**
 * PowerSaveMode -> are the screens off? 0 is on; 1, 2 and 3 are standby, suspend and off; -1
 * means these screens cannot be switched off at all. Anything unexpected counts as on.
 */
function screensAreOff(mode) {
    return mode === 1 || mode === 2 || mode === 3;
}

class ScreenWatch {
    /** @param {function(boolean): void} onChange - called with true when the screens go off */
    constructor(onChange) {
        this._onChange = onChange;
        this._off = false;
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._id = this._bus.signal_subscribe(
            DISPLAY_CONFIG, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            DISPLAY_CONFIG_PATH, DISPLAY_CONFIG, Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _iface, _signal, params) => this._onProperties(params));
        this._ask();
    }

    get off() {
        return this._off;
    }

    destroy() {
        this._bus.signal_unsubscribe(this._id);
        this._cancellable.cancel();
    }

    // This interface has other properties too; only PowerSaveMode matters here.
    _onProperties(params) {
        const value = changedProperty(params, 'PowerSaveMode');
        if (value === null)
            return;
        if (value !== undefined && value.get_type_string() === 'i')
            this._set(value.get_int32());
        else
            this._ask();                         // changed, but the signal does not say to what
    }

    _ask() {
        this._bus.call(DISPLAY_CONFIG, DISPLAY_CONFIG_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [DISPLAY_CONFIG, 'PowerSaveMode']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 2000, this._cancellable, (bus, result) => {
                let mode = 0;
                try {
                    const [value] = bus.call_finish(result).deep_unpack();
                    mode = value.unpack();
                } catch (e) {
                    // no answer (or cancelled): carry on as if the screens were on
                }
                if (!this._cancellable.is_cancelled())
                    this._set(mode);
            });
    }

    _set(mode) {
        const off = screensAreOff(mode);
        if (off === this._off)
            return;
        this._off = off;
        this._onChange(off);
    }
}
