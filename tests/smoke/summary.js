// Prints the probe's report and exits non-zero if any check failed.
const {GLib} = imports.gi;

const [, bytes] = GLib.file_get_contents(ARGV[0]);
const report = JSON.parse(new TextDecoder().decode(bytes));
let failed = 0;
for (const check of report.checks) {
    if (!check.ok)
        failed++;
    print(`${check.ok ? 'ok   ' : 'FAIL '} ${check.name}${check.ok || !check.detail ? '' : `  (${check.detail})`}`);
}
if (report.bench) {
    print('\nProcessor time used by this GNOME Shell, in percent of one core:');
    const base = report.bench[0].percent;
    for (const row of report.bench)
        print(`  ${row.percent.toFixed(2).padStart(6)} %   ${(row.percent - base >= 0 ? '+' : '') + (row.percent - base).toFixed(2)} %   ${row.name}`);
    print('  (second column: difference from "everything off")\n');
}
print(`GNOME Shell ${report.shell}: ${report.checks.length - failed} of ${report.checks.length} checks passed` +
    `${report.audio ? ', music bars tested with real sound' : ', music bars not tested (no sound server)'}`);
if (failed > 0 || report.checks.length === 0)
    imports.system.exit(1);
