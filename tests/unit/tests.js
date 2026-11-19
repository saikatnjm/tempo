// ---- unit tests (appended after the core files by run.sh) ------------------------------------

let failures = 0, passed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failures++;
        print(`FAIL  ${name}${detail === undefined ? '' : `  (${detail})`}`);
    }
}

function equal(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    check(name, a === e, `got ${a}, expected ${e}`);
}

function tone(frequency, amplitude, byteCount) {
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount >> 1; i++) {
        const s = Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * frequency * i / SPECTRUM_RATE));
        bytes[2 * i] = s & 255;
        bytes[2 * i + 1] = (s >> 8) & 255;
    }
    return bytes;
}

// ---- formatting ----
equal('rate 0', formatRateCompact(0), '0K');
equal('rate below 1K', formatRateCompact(900), '0K');
equal('rate NaN', formatRateCompact(NaN), '0K');
equal('rate 892K', formatRateCompact(892 * 1024), '892K');
equal('rate 1.2M', formatRateCompact(1.2 * 1048576), '1.2M');
equal('rate 12M', formatRateCompact(12 * 1048576), '12M');
equal('rate 1.5G', formatRateCompact(1.5 * 1073741824), '1.5G');
equal('rate rolls over to M', formatRateCompact(1023.9 * 1024), '1.0M');
equal('long rate KiB', formatRateLong(5 * 1024), '5 KiB/s');
equal('long rate MiB', formatRateLong(3.25 * 1048576), '3.3 MiB/s');
equal('long rate negative', formatRateLong(-5), '0 KiB/s');
equal('GiB', formatGiB(13.5 * 1048576), '13.5 GiB');
equal('temperature bar', formatTemperature(51.6, false, false), '52°');
equal('temperature bar F', formatTemperature(50, true, false), '122°');
equal('temperature menu C', formatTemperature(51.64, false, true), '51.6 °C');
equal('temperature menu F', formatTemperature(100, true, true), '212.0 °F');
equal('clamp low', clamp(-1, 0, 1), 0);
equal('clamp high', clamp(7, 0, 1), 1);
equal('gradient start', gradientColor([[255, 0, 0], [0, 0, 255]], 0), [1, 0, 0]);
equal('gradient end', gradientColor([[255, 0, 0], [0, 0, 255]], 1), [0, 0, 1]);
equal('gradient middle of three', gradientColor([[0, 0, 0], [255, 255, 255], [0, 0, 0]], 0.5), [1, 1, 1]);
equal('gradient single stop', gradientColor([[255, 255, 255]], 0.3), [1, 1, 1]);
equal('gradient clamps', gradientColor([[255, 0, 0], [0, 0, 255]], 7), [0, 0, 1]);

// ---- /proc parsers ----
const STAT = 'cpu  100 5 50 800 20 3 2 0 9 9\ncpu0 50 2 25 400 10 1 1 0 0 0\ncpu1 50 3 25 400 10 2 1 0 0 0\nintr 1 2 3\n';
equal('cpu times', parseCpuTimes(STAT), {idle: 820, total: 980});
equal('cpu count', countCpus(STAT), 2);
equal('cpu count without text', countCpus(null), 1);
equal('cpu times empty', parseCpuTimes(''), null);
equal('cpu times garbage', parseCpuTimes('cpu  a b c d'), null);
equal('cpu times old kernel (4 fields)', parseCpuTimes('cpu  1 2 3 4\n'), {idle: 4, total: 10});

const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nBuffers:          500000 kB\nCached:          3000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n';
equal('meminfo', parseMeminfo(MEMINFO), {total: 16000000, available: 6000000, swapTotal: 2000000, swapFree: 1500000});
equal('meminfo without MemAvailable', parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 5 kB\nCached: 20 kB\n'),
    {total: 100, available: 35, swapTotal: 0, swapFree: 0});
equal('meminfo empty', parseMeminfo(''), null);
equal('meminfo no total', parseMeminfo('MemFree: 10 kB\n'), null);

const NETDEV = 'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
    '    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n' +
    'wlp3s0: 5000 50 0 0 0 0 0 0 700 7 0 0 0 0 0 0\n' +
    'docker0: 9999 9 0 0 0 0 0 0 9999 9 0 0 0 0 0 0\n' +
    'enp2s0:300 3 0 0 0 0 0 0 20 2 0 0 0 0 0 0\n';
equal('net dev physical only', parseNetDev(NETDEV, n => n === 'wlp3s0' || n === 'enp2s0'), {rx: 5300, tx: 720, interfaces: 2});
equal('net dev nothing accepted', parseNetDev(NETDEV, () => false), {rx: 0, tx: 0, interfaces: 0});
equal('net dev null', parseNetDev(null, () => true), null);

equal('proc stat', parseProcStat('1234 (brave) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0 20 0 30 0 100 200 300\n'), {name: 'brave', ticks: 300});
equal('proc stat name with spaces and parens', parseProcStat('77 (Web (Content) x) R 1 2 3 4 5 6 7 8 9 10 7 3 0 0\n'), {name: 'Web (Content) x', ticks: 10});
equal('proc stat truncated', parseProcStat('77 (x) R 1 2'), null);
equal('proc stat null', parseProcStat(null), null);

equal('cpu MHz', parseCpuMhz('processor\t: 0\ncpu MHz\t\t: 1000.000\nprocessor\t: 1\ncpu MHz\t\t: 3000.000\n'), 2000);
equal('cpu MHz missing (ARM)', parseCpuMhz('processor\t: 0\nBogoMIPS\t: 108.00\n'), null);

// ---- spectrum ----
const span = SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ;
for (const frequency of [60, 180, 440, 1200, 3000, 6000]) {
    const spectrum = new Spectrum(10, 12);
    let changed = false;
    for (let i = 0; i < 6; i++)
        changed = spectrum.push(tone(frequency, 0.3, 2666)) || changed;
    let tallest = 0;
    for (let b = 1; b < 10; b++) {
        if (spectrum.levels[b] > spectrum.levels[tallest])
            tallest = b;
    }
    const expected = Math.min(9, Math.floor(10 * Math.log(frequency / SPECTRUM_LOW_HZ) / Math.log(span)));
    equal(`tone ${frequency} Hz lights the right bar`, tallest, expected);
    check(`tone ${frequency} Hz reports a change`, changed);
    check(`tone ${frequency} Hz is tall`, spectrum.levels[tallest] > SPECTRUM_LEVELS * 0.8, spectrum.levels[tallest]);
}
{
    const even = new Spectrum(10, 12), odd = new Spectrum(10, 12);
    const data = tone(440, 0.3, 2666 * 6);
    for (let i = 0; i < 6; i++)
        even.push(data.subarray(i * 2666, (i + 1) * 2666));
    const sizes = [1, 2665, 3, 1333, 4001, 7, 999];
    let offset = 0, k = 0;
    while (offset < data.length) {
        const size = sizes[k++ % sizes.length];
        odd.push(data.subarray(offset, Math.min(data.length, offset + size)));
        offset += size;
    }
    check('odd-sized chunks give identical samples', even._samples.every((v, i) => v === odd._samples[i]));
}
{
    const spectrum = new Spectrum(10, 12);
    for (let i = 0; i < 30; i++)
        spectrum.push(new Uint8Array(2666));
    check('silence stays at zero', spectrum.levels.every(v => v === 0));
    check('empty chunk is ignored', spectrum.push(new Uint8Array(0)) === false);
}
{
    const spectrum = new Spectrum(10, 12);
    for (let i = 0; i < 8; i++)
        spectrum.push(tone(440, 0.5, 2666));
    check('bars are up while sound plays', spectrum.levels.some(v => v > 0));
    for (let i = 0; i < 20; i++)
        spectrum.push(new Uint8Array(2666));
    check('bars fall back to zero after the sound stops', spectrum.levels.every(v => v === 0));
}
{
    // A chunk far larger than the window must keep exactly the newest samples.
    const big = new Spectrum(10, 12), small = new Spectrum(10, 12);
    const data = tone(1000, 0.4, 2 * 5000);
    big.push(data);
    small.push(data.subarray(data.length - 2 * SPECTRUM_SIZE));
    check('oversized chunk keeps the newest window', big._samples.every((v, i) => v === small._samples[i]));
    const carry = new Spectrum(10, 12), plain = new Spectrum(10, 12);
    carry.push(data.subarray(0, 1));
    carry.push(data.subarray(1));
    plain.push(data);
    check('oversized chunk after a split sample', carry._samples.every((v, i) => v === plain._samples[i]));
}
for (const fps of [5, 12, 30]) {
    const spectrum = new Spectrum(10, fps);
    const hopBytes = Math.round(SPECTRUM_RATE / fps) * 2;
    let frames = 0;
    for (let i = 0; i < fps * 2; i++) {
        if (spectrum.push(tone(300 + 40 * i, 0.3, hopBytes)))
            frames++;
    }
    check(`${fps} fps produces frames`, frames >= fps, frames);
    check(`${fps} fps levels stay in range`, spectrum.levels.every(v => v <= SPECTRUM_LEVELS));
}
// The sound server chooses the chunk size, not us. Whatever it is, the frame rate must come out
// as asked: these are the sizes PulseAudio and PipeWire were seen to deliver at 12 fps.
for (const [fps, samplesPerChunk] of [[12, 1035], [12, 1328], [12, 1344], [12, 340], [30, 235], [5, 2080], [12, 4000]]) {
    const spectrum = new Spectrum(10, fps);
    const seconds = 6;
    const total = SPECTRUM_RATE * seconds;
    let fed = 0, k = 0;
    while (fed < total) {
        spectrum.push(tone(200 + 37 * (k++ % 40), 0.3, samplesPerChunk * 2));
        fed += samplesPerChunk;
    }
    const frames = spectrum.frames;
    const expected = Math.min(fps, SPECTRUM_RATE / samplesPerChunk) * seconds;
    check(`${fps} fps holds with ${samplesPerChunk}-sample chunks`,
        frames >= expected * 0.9 && frames <= expected * 1.02 + 1, `${frames} frames, expected about ${expected.toFixed(0)}`);
}
{
    // Bars must fall at the same speed however the sound is chunked: half a second from the top.
    for (const samplesPerChunk of [1035, 1333, 2666]) {
        const spectrum = new Spectrum(10, 12);
        for (let i = 0; i < 40; i++)
            spectrum.push(tone(440, 0.5, samplesPerChunk * 2));
        const top = Math.max(...spectrum.levels);
        let silentSamples = 0;
        while (spectrum.levels.some(v => v > 0) && silentSamples < SPECTRUM_RATE * 3) {
            spectrum.push(new Uint8Array(samplesPerChunk * 2));
            silentSamples += samplesPerChunk;
        }
        const fall = silentSamples / SPECTRUM_RATE;
        check(`bars fall in about half a second with ${samplesPerChunk}-sample chunks`,
            top > 24 && fall > 0.3 && fall < 0.85, `fell in ${fall.toFixed(2)} s from level ${top}`);
    }
}

for (const bars of [1, 4, 16, 32]) {
    const spectrum = new Spectrum(bars, 12);
    spectrum.push(tone(440, 0.3, 4000));
    let ordered = true;
    for (let b = 0; b < bars; b++)
        ordered = ordered && spectrum._low[b] <= spectrum._high[b] && (b === 0 || spectrum._low[b] > spectrum._high[b - 1] || spectrum._low[b] === SPECTRUM_SIZE / 2 - 1);
    check(`${bars} bars have ordered bands`, ordered);
}

// ---- against this machine's real /proc and /sys ----
{
    const sampler = new Sampler();
    check('cpu count is positive', sampler.cpuCount >= 1, sampler.cpuCount);
    equal('first cpu reading has nothing to compare with', sampler.cpu(10), null);
    const memory = sampler.memory();
    check('memory is readable', memory !== null && memory.total > 0 && memory.available <= memory.total);
    equal('first network reading has nothing to compare with', sampler.network(10), null);
    let x = 0;
    for (let i = 0; i < 3e6; i++)
        x += Math.sqrt(i);
    GLib.usleep(120000);
    equal('a reading asked for too soon is refused', sampler.cpu(10), null);
    equal('a network reading asked for too soon is refused', sampler.network(10), null);
    GLib.usleep(900000);
    const cpu = sampler.cpu(10);
    check('a reading after a full second is a share', cpu !== null && cpu >= 0 && cpu <= 1, cpu);
    check('the refused reading did not move the baseline: this window saw the busy loop', cpu > 0, cpu);
    const network = sampler.network(10);
    check('second network reading is a rate', network !== null && network.down >= 0 && network.up >= 0);
    GLib.usleep(950000);
    equal('stale readings are not compared', sampler.cpu(0), null);

    const sensors = findSensors();
    check('sensor search returns the expected shape',
        'cpu' in sensors && 'gpu' in sensors && 'disk' in sensors && Array.isArray(sensors.fans));
    if (sensors.cpu !== null) {
        const milli = parseInt(readText(sensors.cpu), 10);
        check('cpu temperature is plausible', milli > 0 && milli < 130000, milli);
    }
}

// ---- asynchronous parts ----
const loop = new GLib.MainLoop(null, false);
let pendingAsync = 3;
function asyncDone() {
    if (--pendingAsync === 0)
        loop.quit();
}

{
    const cancellable = new Gio.Cancellable();
    readTextAsync('/proc/loadavg', cancellable, text => {
        check('async read returns text', typeof text === 'string' && text.split(' ').length >= 3);
        asyncDone();
    });
    readTextAsync('/nonexistent/tempo-test', cancellable, text => {
        equal('async read of a missing file gives null', text, null);
        asyncDone();
    });
    const cancelled = new Gio.Cancellable();
    readTextAsync('/proc/loadavg', cancelled, () => check('cancelled read must not call back', false));
    cancelled.cancel();
}
{
    const results = [];
    const scanner = new ProcScanner(4, list => {
        results.push(list);
        if (results.length === 1) {
            equal('first process scan is a baseline', list, null);
            check('scanner is idle after a scan', !scanner.busy);
            let x = 0;
            for (let i = 0; i < 6e6; i++)
                x += Math.sqrt(i);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                scanner.scan();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            check('second process scan lists processes', Array.isArray(list) && list.length >= 1 && list.length <= TOP_PROCESSES, JSON.stringify(list));
            check('process list is sorted', list.every((e, i) => i === 0 || list[i - 1].share >= e.share));
            check('this test shows up as busy', list.some(e => e.name === 'gjs' || e.name === 'gjs-console'), JSON.stringify(list));
            check('shares are fractions', list.every(e => e.share > 0 && e.share <= 1));
            scanner.scan();
            check('scanner reports busy while scanning', scanner.busy);
            scanner.cancel();
            check('cancel stops the scan', !scanner.busy);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                equal('a cancelled scan reports nothing', results.length, 2);
                asyncDone();
                return GLib.SOURCE_REMOVE;
            });
        }
    });
    scanner.scan();
}
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    check('asynchronous tests finished in time', false);
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

print(`${passed} checks passed, ${failures} failed`);
if (failures > 0)
    imports.system.exit(1);
