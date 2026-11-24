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

// ---- fans ----
const F = (name, rpm, priority) => ({name, rpm, priority});
equal('fans: processor fan first, then the fastest',
    fansToShow([F('Fan 1', 1500, 1), F('CPU Fan', 900, 2), F('Fan 3', 2100, 1)], 20000, 4),
    [{name: 'CPU Fan', rpm: 900}, {name: 'Fan 3', rpm: 2100}, {name: 'Fan 1', rpm: 1500}]);
equal('fans: empty desktop connectors (0 RPM) are left out',
    fansToShow([F('Fan 1', 0, 1), F('Fan 2', 1200, 1), F('Fan 4', 0, 1)], 20000, 4), [{name: 'Fan 2', rpm: 1200}]);
equal('fans: a stopped processor fan is still listed',
    fansToShow([F('Processor Fan', 0, 2), F('Graphics fan', 1800, 0)], 20000, 4),
    [{name: 'Processor Fan', rpm: 0}, {name: 'Graphics fan', rpm: 1800}]);
equal('fans: impossible readings are dropped',
    fansToShow([F('Fan', 65280, 1), F('Processor Fan', 3000, 2)], 20000, 4), [{name: 'Processor Fan', rpm: 3000}]);
equal('fans: all still -> one line saying so',
    fansToShow([F('Fan 1', 0, 1), F('Graphics fan', 0, 0)], 20000, 4), [{name: 'Fan 1', rpm: 0}]);
equal('fans: nothing readable', fansToShow([F('Fan', NaN, 1), F('Fan', 65280, 2)], 20000, 4), []);
equal('fans: at most the limit', fansToShow([F('a', 1, 1), F('b', 2, 1), F('c', 3, 1)], 20000, 2).length, 2);
equal('fans: labels', [fanPriority('CPU Fan', 'nct6798'), fanPriority('', 'it8688'), fanPriority('', 'amdgpu'), fanPriority('Processor Fan', 'dell_smm')], [2, 1, 0, 2]);

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

{
    // Paced by the caller, as the recorder does: feed() every piece the sound server sent, then
    // one frame() per tick, however many pieces there were.
    const paced = new Spectrum(10, 8), pushed = new Spectrum(10, 8);
    const data = tone(440, 0.4, 8 * 4000);               // one second at 8 frames a second
    for (let tick = 0; tick < 8; tick++) {
        const chunk = data.subarray(tick * 4000, (tick + 1) * 4000);
        for (let offset = 0; offset < chunk.length; offset += 322)
            paced.feed(chunk.subarray(offset, Math.min(chunk.length, offset + 322)));
        paced.frame();
        pushed.push(chunk);
    }
    equal('paced: one frame per tick, however many pieces arrived', paced.frames, 8);
    check('paced: the tone shows', Math.max(...paced.levels) > SPECTRUM_LEVELS * 0.8, Math.max(...paced.levels));
    check('paced and pushed give the same levels', paced.levels.every((v, i) => v === pushed.levels[i]));
    equal('paced: no new sound, no frame', paced.frame(), false);
    equal('paced: the frame count stays', paced.frames, 8);
    equal('paced: an empty piece is nothing', paced.feed(new Uint8Array(0)), 0);
    equal('paced: feed reports the samples taken', paced.feed(new Uint8Array(322)), 161);
}

// ---- small helpers of the widgets ----
{
    const levels = Uint8Array.from({length: 64}, (_v, i) => i % 32);
    equal('reduceLevels: same size is a copy', Array.from(reduceLevels(levels, new Uint8Array(64))), Array.from(levels));
    equal('reduceLevels: loudest of each group', Array.from(reduceLevels(Uint8Array.from([1, 9, 3, 4, 7, 2]), new Uint8Array(3))), [9, 4, 7]);
    equal('reduceLevels: uneven groups cover every band', Array.from(reduceLevels(Uint8Array.from([5, 1, 1, 1, 1, 1, 8]), new Uint8Array(3))), [5, 1, 8]);
    check('sameColor: equal values', sameColor([1, 2, 3], [1, 2, 3]));
    check('sameColor: different values', !sameColor([1, 2, 3], [1, 2, 4]));
    check('sameColor: null and a colour', !sameColor(null, [1, 2, 3]) && !sameColor([1, 2, 3], null));
    check('sameColor: null and null', sameColor(null, null));
    check('sameColor: nothing set yet differs from null', !sameColor(null, undefined));
    equal('screens: which power-save modes mean off', [-1, 0, 1, 2, 3, 4, NaN].map(screensAreOff), [false, false, true, true, true, false, false]);

    // What a "PropertiesChanged" signal says about one property (the screens' and the players').
    const signal = (changed, again) => new GLib.Variant('(sa{sv}as)', ['some.Interface', changed, again]);
    const value = changedProperty(signal({PowerSaveMode: new GLib.Variant('i', 3), Other: new GLib.Variant('s', 'x')}, []), 'PowerSaveMode');
    check('changed property: its new value', value instanceof GLib.Variant && value.get_type_string() === 'i' && value.get_int32() === 3);
    check('changed property: changed, but the signal does not say to what',
        changedProperty(signal({}, ['Other', 'PowerSaveMode']), 'PowerSaveMode') === undefined);
    check('changed property: a signal about other properties',
        changedProperty(signal({Other: new GLib.Variant('s', 'x')}, ['Another']), 'PowerSaveMode') === null);
    check('changed property: an empty signal', changedProperty(signal({}, []), 'PowerSaveMode') === null);
    check('changed property: a signal of another shape counts as changed',
        changedProperty(new GLib.Variant('(si)', ['some.Interface', 3]), 'PowerSaveMode') === undefined);
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
// Tempo itself never reads a file on the main thread; these tests may, to keep them simple.
function readNow(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}
{
    const sampler = new Sampler();
    equal('cpu count before the first reading', sampler.cpuCount, 1);
    equal('first cpu reading has nothing to compare with', sampler.cpu(readNow('/proc/stat'), 10), null);
    check('cpu count comes with the first reading', sampler.cpuCount >= 1 && sampler.cpuCount === countCpus(readNow('/proc/stat')),
        sampler.cpuCount);
    equal('an unreadable /proc/stat gives no reading', new Sampler().cpu(null, 10), null);
    const memory = sampler.memory(readNow('/proc/meminfo'));
    check('memory is readable', memory !== null && memory.total > 0 && memory.available <= memory.total);
    equal('first network reading has nothing to compare with', sampler.network(readNow('/proc/net/dev'), 10), null);
    // Keep the processor busy for a fixed 0.2 s (not a fixed amount of work: slow machines
    // would overrun the 0.9 s window this test is about).
    let x = 0;
    const until = GLib.get_monotonic_time() + 200000;
    while (GLib.get_monotonic_time() < until)
        x += Math.sqrt(x + 1);
    GLib.usleep(120000);
    equal('a reading asked for too soon is refused', sampler.cpu(readNow('/proc/stat'), 10), null);
    equal('a network reading asked for too soon is refused', sampler.network(readNow('/proc/net/dev'), 10), null);
    GLib.usleep(900000);
    const cpu = sampler.cpu(readNow('/proc/stat'), 10);
    check('a reading after a full second is a share', cpu !== null && cpu >= 0 && cpu <= 1, cpu);
    check('the refused reading did not move the baseline: this window saw the busy loop', cpu > 0, cpu);
    const network = sampler.network(readNow('/proc/net/dev'), 10);
    check('second network reading is a rate', network !== null && network.down >= 0 && network.up >= 0);
    GLib.usleep(950000);
    equal('stale readings are not compared', sampler.cpu(readNow('/proc/stat'), 0), null);
}

// ---- asynchronous parts ----
const loop = new GLib.MainLoop(null, false);
let pendingAsync = 6;
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
    readTextsAsync(['/proc/loadavg', '/proc/stat'], cancelled, () => check('cancelled reads must not call back', false));
    cancelled.cancel();
    readTextsAsync([], cancelled, () => check('nothing to read and cancelled: must not call back', false));

    // Several files at once: one answer, in the order asked, null for what is missing or left out.
    let answers = 0;
    readTextsAsync(['/proc/loadavg', '/nonexistent/tempo-test', null, '/proc/stat'], cancellable, texts => {
        answers++;
        equal('reading several files answers once', answers, 1);
        equal('one text per path', texts.length, 4);
        check('texts come in the order asked', typeof texts[0] === 'string' && texts[0].split(' ').length >= 3 &&
            typeof texts[3] === 'string' && texts[3].startsWith('cpu '));
        equal('a missing file and a path left out are null', [texts[1], texts[2]], [null, null]);
        asyncDone();
    });
    let empty = null;
    readTextsAsync([null, null], cancellable, texts => (empty = texts));
    equal('nothing to read answers at once', empty, [null, null]);

    findSensors(cancellable, sensors => {
        check('sensor search returns the expected shape',
            'cpu' in sensors && 'gpu' in sensors && 'disk' in sensors && Array.isArray(sensors.fans));
        check('every fan has a path, a number and a priority', sensors.fans.every(fan =>
            fan.path.endsWith(`/fan${fan.number}_input`) && [0, 1, 2].includes(fan.priority) && typeof fan.label === 'string'));
        asyncDone();
        if (sensors.cpu === null) {
            asyncDone();
            return;
        }
        readTextAsync(sensors.cpu, cancellable, text => {
            const milli = parseInt(text, 10);
            check('cpu temperature is plausible', milli > 0 && milli < 130000, milli);
            asyncDone();
        });
    });
    findSensors(cancelled, () => check('a cancelled sensor search must not call back', false));
}
{
    const results = [];
    const scanner = new ProcScanner(() => 4, list => {
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
