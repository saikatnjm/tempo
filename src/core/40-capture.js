// ---- capture: listens to what the speakers are playing ---------------------------------------
//
// Runs the stock `parec` recorder (part of the PulseAudio utilities, and it talks to PipeWire
// just the same) on the monitor of the default output, at a low sample rate. Its raw samples
// arrive on a pipe and go straight into Spectrum. Nothing is ever recorded to disk or sent
// anywhere, and the microphone is never opened.
//
// Measured on a Ryzen 5 3500U: parec uses about 1 % of one core and 6 MB of memory while it
// runs. It only runs while a media player is playing (see PlayerWatch).

const CAPTURE_PROGRAM = 'parec';
const CAPTURE_CHUNK = 8192;         // bytes per read; one frame is at most 6400 bytes (5 fps)
const CAPTURE_QUICK_EXIT_S = 3;     // exiting sooner than this counts as "could not start"

class AudioCapture {
    /**
     * @param {object} params
     * @param {number} params.bars
     * @param {number} params.fps
     * @param {function(Uint8Array): void} params.onLevels - bar heights changed
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
            // Rounded up so one chunk is never a few samples short of one frame.
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
        this._read(this._stdout, this._cancellable);
        return true;
    }

    /** Stop listening and end the recorder. Safe to call at any time. */
    stop() {
        if (this._cancellable !== null)
            this._cancellable.cancel();
        if (this._process !== null)
            this._process.force_exit();
        this._process = null;
        this._stdout = null;
        this._cancellable = null;
        this._spectrum = null;
    }

    _read(stream, cancellable) {
        stream.read_bytes_async(CAPTURE_CHUNK, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            let bytes = null;
            try {
                bytes = source.read_bytes_finish(result);
            } catch (e) {
                // cancelled by stop(), or the pipe broke: handled below
            }
            if (cancellable.is_cancelled())
                return;
            if (bytes === null || bytes.get_size() === 0) {
                this._exited();
                return;
            }
            if (this._spectrum.push(bytes.toArray()))
                this._onLevels(this._spectrum.levels);
            this._read(stream, cancellable);
        });
    }

    _exited() {
        const quick = monotonicSeconds() - this._startedAt < CAPTURE_QUICK_EXIT_S;
        this.stop();
        this._onExit(quick);
    }
}
