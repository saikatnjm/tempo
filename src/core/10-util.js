// ---- util: small shared helpers ---------------------------------------------------------------
//
// How the code is put together: tools/build.sh concatenates src/shell/<variant>-header.js, every
// file in src/core/ (in name order) and src/shell/<variant>-footer.js into one extension.js.
// The header supplies the names used here: GLib, Gio, St, Clutter, Shell, Main, PanelMenu,
// PopupMenu, Volume, CHROME_PARAMS and _ (gettext). There are two variants because GNOME Shell 45 switched
// extensions to ES modules; the code in src/core/ is identical for both.
//
// Nothing in this file touches the Shell UI, so it also runs in plain gjs (tests/unit).

const TEXT_DECODER = new TextDecoder();

/**
 * Read a text file on a worker thread, so reading can never stall the compositor (GNOME Shell
 * does everything else on one thread, and a hardware sensor can take its time to answer).
 * `callback(text)` runs on the main loop; `text` is null if the file could not be read.
 * Nothing is called once `cancellable` has been cancelled.
 */
function readTextAsync(path, cancellable, callback) {
    Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
        let text = null;
        try {
            const [ok, bytes] = file.load_contents_finish(result);
            if (ok)
                text = TEXT_DECODER.decode(bytes);
        } catch (e) {
            // missing file, I/O error or cancelled: reported as null below
        }
        if (!cancellable.is_cancelled())
            callback(text);
    });
}

/**
 * Read several text files at once, the same way. `callback(texts)` runs once, when all are back:
 * one text per path, in the same order, null where a file could not be read. A path that is null
 * is not read (its text is null), so a caller can leave out what it does not need this time.
 */
function readTextsAsync(paths, cancellable, callback) {
    const texts = paths.map(() => null);
    let pending = paths.filter(path => path !== null).length;
    if (pending === 0) {
        if (!cancellable.is_cancelled())
            callback(texts);
        return;
    }
    paths.forEach((path, i) => {
        if (path === null)
            return;
        readTextAsync(path, cancellable, text => {
            texts[i] = text;
            if (--pending === 0)
                callback(texts);
        });
    });
}

/**
 * The callback for an asynchronous call whose answer nobody needs. It has to be a function:
 * GNOME Shell turns some of these calls into promise-style ones, and those take "no callback"
 * to mean "give me a promise".
 */
function ignoreAnswer() {
    // nothing to do: the answer is not looked at
}

/**
 * What a D-Bus "PropertiesChanged" signal says about one property. The signal carries
 * (interface, {changed properties}, [properties to ask for again]). Returns the property's new
 * value (a GLib.Variant); `undefined` when it changed but the signal does not say to what, or is
 * not shaped as the standard says; null when the signal is not about this property.
 */
function changedProperty(params, name) {
    if (params.get_type_string() !== '(sa{sv}as)')
        return undefined;
    const value = params.get_child_value(1).lookup_value(name, null);
    if (value !== null)
        return value;
    return params.get_child_value(2).deep_unpack().includes(name) ? undefined : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function monotonicSeconds() {
    return GLib.get_monotonic_time() / 1e6;
}

/** Compact transfer rate for the top bar: "0K", "892K", "1.2M", "12M" (1 K = 1024 bytes). */
function formatRateCompact(bytesPerSecond) {
    const k = bytesPerSecond / 1024;
    if (!(k >= 1))
        return '0K';
    if (k < 999.5)
        return `${Math.round(k)}K`;
    const m = k / 1024;
    if (m < 9.95)
        return `${m.toFixed(1)}M`;
    if (m < 999.5)
        return `${Math.round(m)}M`;
    return `${(m / 1024).toFixed(1)}G`;
}

/** The same rate spelled out for the menu: "892 KiB/s", "1.2 MiB/s". */
function formatRateLong(bytesPerSecond) {
    const k = Math.max(0, bytesPerSecond) / 1024;
    if (k < 999.5)
        return `${Math.round(k)} KiB/s`;
    const m = k / 1024;
    if (m < 999.5)
        return `${m < 9.95 ? m.toFixed(1) : Math.round(m)} MiB/s`;
    return `${(m / 1024).toFixed(1)} GiB/s`;
}

/** Kibibytes (as in /proc/meminfo) to "5.4 GiB". */
function formatGiB(kib) {
    return `${(kib / 1048576).toFixed(1)} GiB`;
}

/** "52°" for the top bar, or "52.4 °C" / "126.3 °F" when `precise` is set. */
function formatTemperature(celsius, fahrenheit, precise) {
    const value = fahrenheit ? celsius * 9 / 5 + 32 : celsius;
    if (!precise)
        return `${Math.round(value)}°`;
    return `${value.toFixed(1)} ${fahrenheit ? '°F' : '°C'}`;
}

/**
 * Colour at position t (0..1) along a list of [r, g, b] stops (each 0..255).
 * Returns [r, g, b] as 0..1 floats, ready for cairo.
 */
function gradientColor(stops, t) {
    if (stops.length === 1)
        return stops[0].map(c => c / 255);
    const x = clamp(t, 0, 1) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    return [0, 1, 2].map(c => (stops[i][c] * (1 - f) + stops[i + 1][c] * f) / 255);
}
