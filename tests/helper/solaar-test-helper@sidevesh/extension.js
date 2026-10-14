import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Test-only extension, loaded solely inside the disposable headless shell that
// tests/run-tests.sh starts. It lets the test driver run code inside the shell,
// which GNOME Shell otherwise only allows in unsafe mode.
const HelperIface = `
  <node>
    <interface name="io.github.sidevesh.SolaarTestHelper">
      <method name="Eval">
        <arg type="s" direction="in" name="code"/>
        <arg type="s" direction="out" name="json"/>
      </method>
    </interface>
  </node>
`;

const AsyncFunction = (async () => {}).constructor;

export default class SolaarTestHelperExtension extends Extension {
  enable() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(HelperIface, this);
    this._dbus.export(Gio.DBus.session, '/io/github/sidevesh/SolaarTestHelper');
  }

  disable() {
    this._dbus.unexport();
    this._dbus = null;
  }

  // The code is an async function body; its return value is sent back as JSON.
  async EvalAsync([code], invocation) {
    try {
      const fn = new AsyncFunction('Main', 'Config', 'Meta', 'Clutter', 'Gio', 'GLib', code);
      const result = await fn(Main, Config, Meta, Clutter, Gio, GLib);
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result ?? null)]));
    } catch (e) {
      invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, `${e}\n${e.stack ?? ''}`);
    }
  }
}
