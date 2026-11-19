
function init() {
    ExtensionUtils.initTranslations();
}

function fillPreferencesWindow(window) {
    fillTempoPreferences(window, ExtensionUtils.getSettings(), Me.metadata);
}
