// ---- capture: listens to what the speakers are playing ---------------------------------------
//
// Runs the stock `parec` recorder (part of the PulseAudio utilities, and it talks to PipeWire
// just the same) on the monitor of the default output, at a low sample rate. Its raw samples
// arrive on a pipe and go into Spectrum. Nothing is ever recorded to disk or sent anywhere, and
// the microphone is never opened.
//
// The pipe is read once per frame, not whenever sound arrives. Sound servers hand sound over in
// pieces of their own choosing: PulseAudio was measured delivering 100 to 200 small pieces a
// second while a browser plays, whatever latency is asked for. Reading each piece as it comes
// would wake the whole desktop shell that often; instead the pieces wait in the pipe (which
// holds two seconds of sound) and one read per frame takes them all.
//
// Measured on a Ryzen 5 3500U: parec uses about 1 % of one core and 6 MB of memory while it
// runs. It only runs while a media player is playing (see PlayerWatch).

const CAPTURE_PROGRAM = 'parec';
const CAPTURE_QUICK_EXIT_S = 3;     // exiting sooner than this counts as "could not start"

class AudioCapture {
    /**
     * @param {object} params
     * @param {number} params.bars
     * @param {number} params.fps
     * @param {function(Uint8Array, boolean): void} params.onLevels - called once per frame with
     *     the bar heights and whether any of them changed since the last frame
     * @param {function(boolean): void} params.onExit - the recorder stopped by itself; the
     *     argument is true when that happened right after starting
     */
    constructor({bars, fps, onLevels, onExit}) {
        this._bars = bars;
        this._fps = fps;
        this._onLevels = onLevels;
        this._onExit = onExit;
        this._process = null;
        this._stdout = null;
        this._cancellable = null;
        this._spectrum = null;
        this._startedAt = 0;
        this._timer = 0;
        this._period = Math.round(1000 / fps);       // milliseconds between frames
        // Bytes asked for per read: room for two frames (one frame is 2 * SPECTRUM_RATE / fps).
        this._chunk = Math.max(4096, 2 ** Math.ceil(Math.log2(4 * SPECTRUM_RATE / fps)));
    }

    /** Whether the recorder program is installed. */
    static available() {
        return GLib.find_program_in_path(CAPTURE_PROGRAM) !== null;
    }

    get running() {
        return this._process !== null;
    }

    /** Start listening. Returns false if the recorder could not be launched. */
    start() {
        if (this._process !== null)
            return true;
        const program = GLib.find_program_in_path(CAPTURE_PROGRAM);
        if (program === null)
            return false;
        const argv = [
            program,
            '--device=@DEFAULT_MONITOR@',
            '--format=s16le',
            `--rate=${SPECTRUM_RATE}`,
            '--channels=1',
            // One frame's worth per piece, for sound servers that honour it (PipeWire does): the
            // recorder itself then wakes up less often.
            `--latency-msec=${Math.ceil(1000 / this._fps)}`,
            '--client-name=Tempo',
            '--stream-name=Music bars',
            // GNOME shows its "microphone in use" icon for every recording stream, even one that
            // only reads the speakers, except the two level meters it knows by id. This stream
            // only ever reads the speaker output, so it borrows pavucontrol's id to keep that
            // icon truthful. `pactl list source-outputs` shows it as "Tempo" on the monitor.
            '--property=application.id=org.PulseAudio.pavucontrol',
        ];
        try {
            this._process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._process = null;
            return false;
        }
        this._startedAt = monotonicSeconds();
        this._spectrum = new Spectrum(this._bars, this._fps);
        this._cancellable = new Gio.Cancellable();
        this._stdout = this._process.get_stdout_pipe();
        this._read();
        return true;
    }

    /** Stop listening and end the recorder. Safe to call at any time. */
    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (this._cancellable !== null)
            this._cancellable.cancel();
        if (this._process !== null)
            this._process.force_exit();
        this._process = null;
        this._stdout = null;
        this._cancellable = null;
        this._spectrum = null;
    }

    // One frame: take everything that has arrived, work out the levels, and come back after one
    // frame's time. While no sound arrives nothing runs at all: the read just waits.
    _read() {
        const cancellable = this._cancellable;
        this._stdout.read_bytes_async(this._chunk, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            let bytes = null;
            try {
                bytes = source.read_bytes_finish(result);
            } catch (e) {
                // cancelled by stop(), or the pipe broke: handled below
            }
            if (cancellable.is_cancelled())
                return;
            const size = bytes === null ? 0 : bytes.get_size();
            if (size === 0) {
                this._exited();
                return;
            }
            this._spectrum.feed(bytes.toArray());
            if (size === this._chunk) {
                // A full read: more is waiting (the desktop was busy for a moment). Take the
                // rest first, so the frame shows the newest sound.
                this._read();
                return;
            }
            // Every frame is reported, with whether the levels changed: something on screen may
            // still be moving after the sound has settled (the visualizer's falling peak caps).
            this._onLevels(this._spectrum.levels, this._spectrum.frame());
            // A fresh one-shot timer each frame, rather than a repeating one: if the sound stops
            // arriving, the read above waits and no timer keeps firing for nothing.
            if (cancellable.is_cancelled())
                return;                          // the listener stopped the capture
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._period, () => {
                this._timer = 0;
                this._read();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _exited() {
        const quick = monotonicSeconds() - this._startedAt < CAPTURE_QUICK_EXIT_S;
        this.stop();
        this._onExit(quick);
    }
}
