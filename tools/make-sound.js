// Writes a few seconds of lively, music-like sound (kick, bass, chords, hi-hat, a short melody)
// as a WAV file. Used only to make the music bars dance for the documentation pictures:
//   gjs tools/make-sound.js out.wav
const {GLib} = imports.gi;

const RATE = 44100, SECONDS = 8;
const total = RATE * SECONDS;
const samples = new Float32Array(total);
const TAU = 2 * Math.PI;
const BEAT = 0.5;                                   // 120 beats a minute
const BASS = [55, 55, 82.4, 73.4, 65.4, 65.4, 98, 82.4];
const CHORDS = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]];
const MELODY = [880, 987.8, 1174.7, 1318.5, 1174.7, 987.8, 880, 784, 1568, 1318.5, 1174.7, 987.8, 880, 784, 659.3, 784];

let seed = 12345;
function noise() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
}

let previousNoise = 0;
for (let i = 0; i < total; i++) {
    const t = i / RATE;
    const beat = Math.floor(t / BEAT), inBeat = t - beat * BEAT;
    let v = 0;
    // kick drum on every beat: a sine sweeping down from 120 Hz
    v += 0.55 * Math.exp(-inBeat * 14) * Math.sin(TAU * (45 + 75 * Math.exp(-inBeat * 30)) * inBeat);
    // bass line
    v += 0.22 * Math.sin(TAU * BASS[beat % BASS.length] * t) * (0.6 + 0.4 * Math.exp(-inBeat * 4));
    // chord pad with slow tremolo
    for (const f of CHORDS[Math.floor(beat / 4) % CHORDS.length])
        v += 0.06 * Math.sin(TAU * f * t) * (0.75 + 0.25 * Math.sin(TAU * 3 * t));
    // melody, two notes per beat
    const step = Math.floor(t / (BEAT / 2)), inStep = t - step * (BEAT / 2);
    const note = MELODY[step % MELODY.length];
    v += 0.10 * Math.exp(-inStep * 9) * (Math.sin(TAU * note * t) + 0.4 * Math.sin(TAU * 2 * note * t));
    // hi-hat on the off-beats: high-passed noise
    const white = noise();
    const hat = white - previousNoise;
    previousNoise = white;
    const offBeat = inBeat - BEAT / 2;
    if (offBeat >= 0)
        v += 0.10 * Math.exp(-offBeat * 45) * hat;
    samples[i] = v;
}

const bytes = new Uint8Array(44 + total * 2);
const view = new DataView(bytes.buffer);
const text = (offset, s) => { for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i); };
text(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); text(8, 'WAVEfmt ');
view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true);
view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, total * 2, true);
for (let i = 0; i < total; i++)
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i] * 0.9)) * 32767), true);
GLib.file_set_contents(ARGV[0], bytes);
print(`Wrote ${ARGV[0]} (${SECONDS} s)`);
