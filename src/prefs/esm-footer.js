
export default class TempoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        fillTempoPreferences(window, this.getSettings(), this.metadata);
    }
}
