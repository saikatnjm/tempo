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

    // The signal carries (interface, {changed properties}, [properties to ask for again]). This
    // interface has other properties too; only PowerSaveMode matters here.
    _onProperties(params) {
        let value = null, ask = false;
        try {
            value = params.get_child_value(1).lookup_value('PowerSaveMode', null);
            ask = value === null && params.get_child_value(2).deep_unpack().includes('PowerSaveMode');
        } catch (e) {
            ask = true;                          // an oddly shaped signal: ask instead
        }
        if (value !== null && value.is_of_type(new GLib.VariantType('i')))
            this._set(value.get_int32());
        else if (value !== null || ask)
            this._ask();
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
