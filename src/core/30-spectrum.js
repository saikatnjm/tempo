// ---- spectrum: turns raw sound into a few smooth bar heights ---------------------------------
//
// Pure maths on typed arrays: no imports, no allocation per frame. One frame costs roughly 55
// microseconds on a 2019 laptop CPU, i.e. well under 0.1 % of one core at 12 frames a second.

const SPECTRUM_RATE = 16000;     // Hz. The recorder resamples for us; 8 kHz of range is plenty.
const SPECTRUM_SIZE = 1024;      // FFT size: a 64 ms window, 15.6 Hz per bin
const SPECTRUM_LEVELS = 32;      // height steps per bar
const SPECTRUM_LOW_HZ = 50;
const SPECTRUM_HIGH_HZ = 7000;
const SPECTRUM_GAIN_FLOOR = 1.0; // keeps faint noise (below about -48 dBFS) from filling the bars

class Spectrum {
    /**
     * @param {number} bars - how many bars to produce
     * @param {number} fps - frames per second the caller wants
     */
    constructor(bars, fps) {
        const n = SPECTRUM_SIZE;
        this.bars = bars;
        /** Current bar heights, 0..SPECTRUM_LEVELS. The same array is reused for every frame. */
        this.levels = new Uint8Array(bars);
        /** How many frames have been worked out so far (for tests and measurements). */
        this.frames = 0;

        this._shown = new Float32Array(bars);
        this._targets = new Float32Array(bars);
        this._samples = new Float32Array(n);     // the most recent n samples, oldest first
        this._re = new Float32Array(n);
        this._im = new Float32Array(n);
        this._fresh = 0;                         // samples counted towards the next frame
        this._elapsed = 0;                       // samples since the last frame was made
        this._carry = -1;                        // first byte of a sample split across two chunks
        this._gain = SPECTRUM_GAIN_FLOOR;
        this._hop = Math.max(1, Math.round(SPECTRUM_RATE / fps));

        // Lookup tables: Hann window, twiddle factors and the bit-reversal permutation.
        this._window = new Float32Array(n);
        this._cos = new Float32Array(n / 2);
        this._sin = new Float32Array(n / 2);
        this._reverse = new Uint16Array(n);
        const bits = Math.round(Math.log2(n));
        for (let i = 0; i < n; i++) {
            this._window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
            let r = 0;
            for (let b = 0; b < bits; b++)
                r |= ((i >> b) & 1) << (bits - 1 - b);
            this._reverse[i] = r;
        }
        for (let i = 0; i < n / 2; i++) {
            this._cos[i] = Math.cos(2 * Math.PI * i / n);
            this._sin[i] = -Math.sin(2 * Math.PI * i / n);
        }

        // Bars cover equal musical intervals (log-spaced), each at least one FFT bin wide.
        this._low = new Uint16Array(bars);
        this._high = new Uint16Array(bars);
        this._tilt = new Float32Array(bars);
        const span = SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ;
        for (let b = 0; b < bars; b++) {
            const f0 = SPECTRUM_LOW_HZ * Math.pow(span, b / bars);
            const f1 = SPECTRUM_LOW_HZ * Math.pow(span, (b + 1) / bars);
            let low = Math.max(1, Math.floor(f0 * n / SPECTRUM_RATE));
            let high = Math.min(n / 2 - 1, Math.floor(f1 * n / SPECTRUM_RATE));
            if (b > 0 && low <= this._high[b - 1])
                low = this._high[b - 1] + 1;
            if (low > n / 2 - 1)
                low = n / 2 - 1;
            if (high < low)
                high = low;
            this._low[b] = low;
            this._high[b] = high;
            // Music carries far more energy in the bass; lift the higher bars a little.
            this._tilt[b] = Math.pow(Math.sqrt(f0 * f1) / SPECTRUM_LOW_HZ, 0.25);
        }
    }

    /**
     * Feed a chunk of raw sound: signed 16-bit little-endian, mono, SPECTRUM_RATE Hz.
     * Chunks may be any size, including odd byte counts.
     * @param {Uint8Array} bytes
     * @returns {boolean} true when `levels` changed and should be redrawn
     */
    push(bytes) {
        const length = bytes.length;
        if (length === 0)
            return false;
        const n = SPECTRUM_SIZE;
        const samples = this._samples;

        let pos = 0;
        let first = null;
        if (this._carry >= 0) {
            first = ((this._carry | (bytes[0] << 8)) << 16 >> 16) / 32768;
            pos = 1;
            this._carry = -1;
        }
        const whole = (length - pos) >> 1;
        const total = whole + (first === null ? 0 : 1);
        if (((length - pos) & 1) === 1)
            this._carry = bytes[length - 1];
        if (total === 0)
            return false;

        // Keep only the newest n samples: slide the window, or skip ahead in a very large chunk.
        let skip = 0, write;
        if (total >= n) {
            skip = total - n;
            write = 0;
        } else {
            samples.copyWithin(0, total);
            write = n - total;
        }
        let taken = 0;
        if (first !== null) {
            if (skip === 0)
                samples[write++] = first;
            taken = 1;
        }
        let p = pos;
        if (taken < skip)
            p += (skip - taken) * 2;
        const end = pos + whole * 2;
        for (; p < end; p += 2)
            samples[write++] = ((bytes[p] | (bytes[p + 1] << 8)) << 16 >> 16) / 32768;

        // Sound servers hand over sound in chunks of their own size, usually not one frame's
        // worth. Keep the remainder, so the frame rate averages out to what was asked for.
        this._fresh += total;
        this._elapsed += total;
        if (this._fresh < this._hop)
            return false;
        this._fresh %= this._hop;
        const seconds = Math.min(0.5, this._elapsed / SPECTRUM_RATE);
        this._elapsed = 0;
        return this._frame(seconds);
    }

    // `seconds` is the time since the previous frame. Motion is defined per second, so the bars
    // rise and fall at the same speed however unevenly the chunks arrive.
    _frame(seconds) {
        const rise = 1 - Math.pow(0.3, 30 * seconds);    // 70 % of the way up per 1/30 s
        const fall = 2.1 * seconds;                      // a full bar drops in about half a second
        const decay = Math.pow(0.996, 30 * seconds);     // automatic gain relaxes ~11 % a second
        this.frames++;
        const n = SPECTRUM_SIZE;
        const re = this._re, im = this._im, samples = this._samples;
        const bars = this.bars, shown = this._shown, targets = this._targets;

        let energy = 0;
        for (let i = 0; i < n; i++)
            energy += samples[i] * samples[i];
        const silent = energy / n < 1e-8;        // below -80 dBFS: skip the maths entirely

        if (!silent) {
            const reverse = this._reverse, hann = this._window, cos = this._cos, sin = this._sin;
            for (let i = 0; i < n; i++)
                re[reverse[i]] = samples[i] * hann[i];
            im.fill(0);
            // In-place iterative radix-2 FFT.
            for (let size = 2; size <= n; size <<= 1) {
                const half = size >> 1, step = n / size;
                for (let i = 0; i < n; i += size) {
                    for (let j = 0, t = 0; j < half; j++, t += step) {
                        const a = i + j, b = a + half;
                        const wr = cos[t], wi = sin[t];
                        const xr = re[b] * wr - im[b] * wi;
                        const xi = re[b] * wi + im[b] * wr;
                        re[b] = re[a] - xr;
                        im[b] = im[a] - xi;
                        re[a] += xr;
                        im[a] += xi;
                    }
                }
            }
            // Loudest bin of each band, gently compressed (fourth root of the power).
            let peak = 0;
            for (let b = 0; b < bars; b++) {
                let power = 0;
                for (let k = this._low[b]; k <= this._high[b]; k++) {
                    const v = re[k] * re[k] + im[k] * im[k];
                    if (v > power)
                        power = v;
                }
                const raw = Math.sqrt(Math.sqrt(power)) * this._tilt[b];
                targets[b] = raw;
                if (raw > peak)
                    peak = raw;
            }
            // Automatic gain: jump up at once for loud passages, relax slowly afterwards.
            if (peak > this._gain * 0.92)
                this._gain = peak / 0.92;
            else
                this._gain = Math.max(SPECTRUM_GAIN_FLOOR, this._gain * decay);
        }

        let changed = false;
        for (let b = 0; b < bars; b++) {
            let target = silent ? 0 : Math.pow(targets[b] / this._gain, 0.7);
            if (target > 1)
                target = 1;
            const current = shown[b];
            // Rise quickly, fall with gravity.
            const next = target > current
                ? current + (target - current) * rise
                : Math.max(target, current - fall);
            shown[b] = next;
            const level = Math.round(next * SPECTRUM_LEVELS);
            if (level !== this.levels[b]) {
                this.levels[b] = level;
                changed = true;
            }
        }
        return changed;
    }
}
