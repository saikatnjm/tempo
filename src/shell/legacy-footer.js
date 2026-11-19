
// ---- entry point (GNOME Shell 42-44) ---------------------------------------------------------

class TempoExtension {
    enable() {
        this._indicator = new TempoIndicator({
            settings: ExtensionUtils.getSettings(),
            path: Me.path,
            uuid: Me.metadata.uuid,
            openPreferences: () => ExtensionUtils.openPrefs(),
        });
    }

    disable() {
        if (this._indicator)
            this._indicator.destroy();
        this._indicator = null;
    }
}

function init() {
    ExtensionUtils.initTranslations();
    return new TempoExtension();
}
