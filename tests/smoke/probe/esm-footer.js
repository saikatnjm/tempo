
export default class TempoProbeExtension extends Extension {
    enable() {
        new TempoProbe().start();
    }

    disable() {}
}
