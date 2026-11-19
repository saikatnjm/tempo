// ---- sampler: reads CPU, memory, network, sensors and processes from /proc and /sys ----------
//
// The parse* functions are pure (text in, numbers out) so they can be unit-tested with fixtures.

const USER_HZ = 100;          // clock ticks per second in /proc/<pid>/stat on Linux
const PROC_SLICE = 32;        // processes read per main-loop slice (about 1 ms)
const TOP_PROCESSES = 4;
const HWMON_MAX = 32;
const SAMPLE_MIN_WINDOW_S = 0.9;   // shorter windows give wild percentages

/** First line of /proc/stat -> cumulative {idle, total} ticks, or null. */
function parseCpuTimes(text) {
    if (!text || !text.startsWith('cpu '))
        return null;
    const end = text.indexOf('\n');
    const f = (end < 0 ? text : text.slice(0, end)).trim().split(/\s+/);
    if (f.length < 5)
        return null;
    // user nice system idle iowait irq softirq steal (guest time is already inside user/nice)
    let total = 0;
    const last = Math.min(f.length, 9);
    for (let i = 1; i < last; i++)
        total += Number(f[i]);
    const idle = Number(f[4]) + (f.length > 5 ? Number(f[5]) : 0);
    if (!Number.isFinite(total) || !Number.isFinite(idle))
        return null;
    return {idle, total};
}

/** Number of logical CPUs listed in /proc/stat (at least 1). */
function countCpus(text) {
    const matches = text ? text.match(/^cpu\d+ /gm) : null;
    return matches ? matches.length : 1;
}

/** /proc/meminfo -> {total, available, swapTotal, swapFree} in KiB, or null. */
function parseMeminfo(text) {
    if (!text)
        return null;
    let total = 0, available = -1, free = 0, buffers = 0, cached = 0, swapTotal = 0, swapFree = 0;
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const value = parseInt(line.slice(colon + 1), 10) || 0;
        switch (line.slice(0, colon)) {
        case 'MemTotal': total = value; break;
        case 'MemAvailable': available = value; break;
        case 'MemFree': free = value; break;
        case 'Buffers': buffers = value; break;
        case 'Cached': cached = value; break;
        case 'SwapTotal': swapTotal = value; break;
        case 'SwapFree': swapFree = value; break;
        }
    }
    if (total <= 0)
        return null;
    if (available < 0)
        available = free + buffers + cached;        // kernels older than 3.14
    return {total, available: Math.min(available, total), swapTotal, swapFree};
}

/**
 * /proc/net/dev -> {rx, tx, interfaces}: byte counters summed over the interfaces `accept(name)`
 * says yes to.
 */
function parseNetDev(text, accept) {
    if (!text)
        return null;
    let rx = 0, tx = 0, interfaces = 0;
    const lines = text.split('\n');
    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        if (!accept(line.slice(0, colon).trim()))
            continue;
        const f = line.slice(colon + 1).trim().split(/\s+/);
        if (f.length < 9)
            continue;
        const r = Number(f[0]), t = Number(f[8]);
        if (!Number.isFinite(r) || !Number.isFinite(t))
            continue;
        rx += r;
        tx += t;
        interfaces++;
    }
    return {rx, tx, interfaces};
}

/** /proc/<pid>/stat -> {name, ticks} (user + system CPU time), or null. */
function parseProcStat(text) {
    if (!text)
        return null;
    // The name sits in parentheses and may itself contain spaces or parentheses.
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open)
        return null;
    const f = text.slice(close + 2).split(' ');
    if (f.length < 13)
        return null;
    const ticks = Number(f[11]) + Number(f[12]);    // utime + stime
    if (!Number.isFinite(ticks))
        return null;
    return {name: text.slice(open + 1, close), ticks};
}

/** /proc/cpuinfo -> average clock speed in MHz, or null where the kernel doesn't report it. */
function parseCpuMhz(text) {
    if (!text)
        return null;
    const pattern = /^cpu MHz\s*:\s*([\d.]+)/gm;
    let sum = 0, count = 0, match;
    while ((match = pattern.exec(text)) !== null) {
        sum += parseFloat(match[1]);
        count++;
    }
    return count > 0 && Number.isFinite(sum) ? sum / count : null;
}

/**
 * Find the temperature and fan sensors once. Every path is a sysfs file holding millidegrees
 * Celsius (or RPM for fans); a missing sensor is null. Works for AMD, Intel and ARM boards.
 */
function findSensors() {
    const monitors = [];
    for (let i = 0; i < HWMON_MAX; i++) {
        const dir = `/sys/class/hwmon/hwmon${i}`;
        const name = readText(`${dir}/name`);
        if (name !== null)
            monitors.push({dir, name: name.trim()});
    }
    const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
    const firstNamed = names => {
        for (const wanted of names) {
            for (const m of monitors) {
                if (m.name === wanted && exists(`${m.dir}/temp1_input`))
                    return `${m.dir}/temp1_input`;
            }
        }
        return null;
    };

    // AMD: Tctl can carry an offset on some chips; Tdie, when the driver offers it, does not.
    let cpu = null;
    for (const m of monitors) {
        if (m.name !== 'k10temp' && m.name !== 'zenpower')
            continue;
        if (!exists(`${m.dir}/temp1_input`))
            continue;
        cpu = `${m.dir}/temp1_input`;
        for (let i = 2; i <= 4; i++) {
            if ((readText(`${m.dir}/temp${i}_label`) ?? '').trim() === 'Tdie')
                cpu = `${m.dir}/temp${i}_input`;
        }
        break;
    }
    cpu ??= firstNamed(['coretemp', 'cpu_thermal', 'cpu-thermal', 'soc_thermal', 'thinkpad', 'acpitz']);
    for (const pattern of [/x86_pkg_temp|cpu|soc/i, /acpitz/i]) {
        for (let i = 0; i < 16 && cpu === null; i++) {
            const type = readText(`/sys/class/thermal/thermal_zone${i}/type`);
            if (type !== null && pattern.test(type))
                cpu = `/sys/class/thermal/thermal_zone${i}/temp`;
        }
    }

    return {
        cpu,
        gpu: firstNamed(['amdgpu', 'radeon', 'nouveau', 'nvidia', 'xe', 'i915']),
        disk: firstNamed(['nvme', 'drivetemp']),
        fans: monitors.map(m => `${m.dir}/fan1_input`).filter(exists),
    };
}

/** Remembers the previous CPU and network counters and turns them into rates. */
class Sampler {
    constructor() {
        this._cpu = null;
        this._net = null;
        this._physical = new Map();
        this.cpuCount = countCpus(readText('/proc/stat'));
    }

    /**
     * Share of CPU time spent busy since the previous call (0..1).
     * Returns null for the first call, or when the previous one is older than `maxAge` seconds.
     */
    cpu(maxAge) {
        const now = monotonicSeconds();
        const prev = this._cpu;
        // Asked again too soon (a settings change, the menu opening): keep the old baseline.
        if (prev !== null && now - prev.time < SAMPLE_MIN_WINDOW_S)
            return null;
        const times = parseCpuTimes(readText('/proc/stat'));
        if (times === null)
            return null;
        this._cpu = {idle: times.idle, total: times.total, time: now};
        if (prev === null || now - prev.time > maxAge || times.total <= prev.total)
            return null;
        return clamp(1 - (times.idle - prev.idle) / (times.total - prev.total), 0, 1);
    }

    /** {total, available, swapTotal, swapFree} in KiB, or null. */
    memory() {
        return parseMeminfo(readText('/proc/meminfo'));
    }

    /** {down, up} in bytes per second since the previous call; null as for cpu(). */
    network(maxAge) {
        const now = monotonicSeconds();
        const prev = this._net;
        if (prev !== null && now - prev.time < SAMPLE_MIN_WINDOW_S)
            return null;
        const text = readText('/proc/net/dev');
        let counters = parseNetDev(text, name => this._isPhysical(name));
        // No real network card at all (a VM or container): count everything except loopback.
        const everything = counters !== null && counters.interfaces === 0;
        if (everything)
            counters = parseNetDev(text, name => name !== 'lo');
        if (counters === null)
            return null;
        this._net = {rx: counters.rx, tx: counters.tx, time: now, everything};
        // The set of interfaces being counted changed (a card was unplugged): the old totals
        // are for something else, so start again from here.
        if (prev === null || prev.everything !== everything || now - prev.time > maxAge)
            return null;
        const seconds = now - prev.time;
        return {
            down: Math.max(0, counters.rx - prev.rx) / seconds,
            up: Math.max(0, counters.tx - prev.tx) / seconds,
        };
    }

    // Real hardware has a "device" link in sysfs; bridges, Docker, VPN tunnels and loopback do
    // not. Counting only real cards avoids counting the same traffic twice.
    _isPhysical(name) {
        let physical = this._physical.get(name);
        if (physical === undefined) {
            if (this._physical.size > 256)
                this._physical.clear();
            physical = name !== 'lo' &&
                GLib.file_test(`/sys/class/net/${name}/device`, GLib.FileTest.EXISTS);
            this._physical.set(name, physical);
        }
        return physical;
    }
}

/**
 * Finds the busiest processes without ever blocking the compositor: the directory listing runs on
 * a worker thread and the per-process reads are spread over idle slices of the main loop.
 *
 * `onResult(list)` gets up to TOP_PROCESSES entries {name, share} (share of all CPUs, 0..1),
 * or null when there is no earlier scan to compare with yet.
 */
class ProcScanner {
    constructor(cpuCount, onResult) {
        this._cpuCount = Math.max(1, cpuCount);
        this._onResult = onResult;
        this._prev = null;
        this._prevTime = 0;
        this._cancellable = null;
        this._idleId = 0;
    }

    get busy() {
        return this._cancellable !== null;
    }

    /** Forget the previous scan, so the next result is a fresh baseline. */
    reset() {
        this._prev = null;
    }

    scan() {
        if (this.busy)
            return;
        const cancellable = this._cancellable = new Gio.Cancellable();
        const pids = [];
        Gio.File.new_for_path('/proc').enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable,
            (dir, result) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(result);
                } catch (e) {
                    this._done(cancellable);
                    return;
                }
                this._collect(enumerator, pids, cancellable);
            });
    }

    cancel() {
        if (this._cancellable !== null)
            this._cancellable.cancel();
        this._cancellable = null;
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
    }

    _done(cancellable) {
        if (this._cancellable === cancellable)
            this._cancellable = null;
    }

    _collect(enumerator, pids, cancellable) {
        enumerator.next_files_async(1024, GLib.PRIORITY_LOW, cancellable, (source, result) => {
            let infos;
            try {
                infos = source.next_files_finish(result);
            } catch (e) {
                this._done(cancellable);
                return;
            }
            if (cancellable.is_cancelled())
                return;
            if (infos.length > 0) {
                for (const info of infos) {
                    const name = info.get_name();
                    const c = name.charCodeAt(0);
                    if (c >= 48 && c <= 57)         // numeric names are process ids
                        pids.push(name);
                }
                this._collect(source, pids, cancellable);
                return;
            }
            try {
                source.close(null);
            } catch (e) {
                // nothing to clean up if the directory handle is already gone
            }
            this._readSlices(pids, cancellable);
        });
    }

    _readSlices(pids, cancellable) {
        const current = new Map();
        const time = monotonicSeconds();
        let index = 0;
        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const end = Math.min(pids.length, index + PROC_SLICE);
            for (; index < end; index++) {
                const stat = parseProcStat(readText(`/proc/${pids[index]}/stat`));
                if (stat !== null)
                    current.set(pids[index], stat);
            }
            if (index < pids.length)
                return GLib.SOURCE_CONTINUE;
            this._idleId = 0;
            this._done(cancellable);
            this._finish(current, time);
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish(current, time) {
        const prev = this._prev;
        const seconds = time - this._prevTime;
        this._prev = current;
        this._prevTime = time;
        if (prev === null || seconds <= 0 || seconds > 60) {
            this._onResult(null);
            return;
        }
        // Add up by name, so an app made of many processes (a browser) shows as one line.
        const byName = new Map();
        for (const [pid, stat] of current) {
            const before = prev.get(pid);
            if (before === undefined || before.name !== stat.name)
                continue;
            const ticks = stat.ticks - before.ticks;
            if (ticks > 0)
                byName.set(stat.name, (byName.get(stat.name) ?? 0) + ticks);
        }
        const scale = 1 / (USER_HZ * seconds * this._cpuCount);
        const list = [];
        for (const [name, ticks] of byName)
            list.push({name, share: Math.min(1, ticks * scale)});
        list.sort((a, b) => b.share - a.share);
        this._onResult(list.slice(0, TOP_PROCESSES));
    }
}
