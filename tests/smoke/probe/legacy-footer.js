
function init() {
    return {
        enable() {
            new TempoProbe().start();
        },
        disable() {},
    };
}
