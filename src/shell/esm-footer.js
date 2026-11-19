
// ---- entry point (GNOME Shell 45+) -----------------------------------------------------------

export default class TempoExtension extends Extension {
    enable() {
        this._indicator = new TempoIndicator({
            settings: this.getSettings(),
            path: this.path,
            uuid: this.uuid,
            openPreferences: () => this.openPreferences(),
        });
    }

    disable() {
        if (this._indicator)
            this._indicator.destroy();
        this._indicator = null;
    }
}
