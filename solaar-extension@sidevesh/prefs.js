import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SolaarExtensionPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const osdRow = new Adw.SwitchRow({
      title: 'Keyboard Brightness OSD',
      subtitle: 'Show the keyboard brightness level when a Logitech keyboard changes its backlight',
    });
    settings.bind('keyboard-brightness-osd', osdRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const group = new Adw.PreferencesGroup();
    group.add(osdRow);

    const page = new Adw.PreferencesPage();
    page.add(group);
    window.add(page);
  }
}
