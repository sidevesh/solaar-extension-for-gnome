import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { KeyboardBacklightOsd } from './keyboardBacklight.js';

const SolaarIface = `
  <node>
    <interface name="io.github.pwr_solaar.solaar">
      <method name="ActiveWindow">
        <arg type="s" direction="out" name="window_wm_class"/>
      </method>
      <method name="PointerOverWindow">
        <arg type="s" direction="out" name="window_wm_class"/>
      </method>
    </interface>
  </node>
`;

export default class SolaarExtension extends Extension {
  enable() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(SolaarIface, this);
    this._dbus.export(Gio.DBus.session, '/io/github/pwr_solaar/solaar');
    this._keyboardBacklight = new KeyboardBacklightOsd();
  }

  disable() {
    this._keyboardBacklight.destroy();
    this._keyboardBacklight = null;
    this._dbus.flush();
    this._dbus.unexport();
    this._dbus = null;
  }

  ActiveWindow() {
    return global.display.focus_window?.get_wm_class() ?? '';
  }

  PointerOverWindow() {
    const [x, y] = global.get_pointer();
    const workspace = global.workspace_manager.get_active_workspace();
    const window = global.get_window_actors()
      .map(actor => actor.get_meta_window())
      .findLast(w => !w.minimized && w.located_on_workspace(workspace) && containsPoint(w.get_frame_rect(), x, y));
    return window?.get_wm_class() ?? '';
  }
}

function containsPoint(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
