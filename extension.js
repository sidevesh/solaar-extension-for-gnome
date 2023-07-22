const { Gio } = imports.gi;

class SolaarGnomeExtension {
  constructor() {
  }

  enable() {
    const dbus_object = `
      <node>
        <interface name="io.github.pwr_solaar.solaar.gnome">
          <method name="ActiveWindow">
            <arg type="s" direction="out" name="win"/>
          </method>
          <method name="PointerOverWindow">
            <arg type="s" direction="out" name="win"/>
          </method>
        </interface>
      </node>
    `;
    this.dbus = Gio.DBusExportedObject.wrapJSObject(dbus_object, this);
    this.dbus.export(Gio.DBus.session, '/io/github/pwr_solaar/solaar/gnome');
  }

  disable() {
    this.dbus.flush();
    this.dbus.unexport();
    delete this.dbus;
  }

  ActiveWindow() {
    const found_actor = global.get_window_actors().find(a=>a.meta_window.has_focus()===true);
    if (found_actor) {
      const w = found_actor.get_meta_window();
      return w.get_wm_class();
    } else {
      return '';
    }
  }

  PointerOverWindow() {
    let [mouse_x, mouse_y, mask] = global.get_pointer();
    let window_actors = global.get_window_actors();
    let found_actor = null;
    window_actors.forEach(function(actor) {
      let xmin = actor.get_position()[0];
      let ymin = actor.get_position()[1];
      let xmax = xmin + actor.get_size()[0];
      let ymax = ymin + actor.get_size()[1];
      if(xmin < mouse_x && mouse_x < xmax && ymin < mouse_y && mouse_y < ymax) {
        found_actor = actor;
      }
    });
    if (found_actor) {
      const w = found_actor.get_meta_window();
      return w.get_wm_class();
    } else {
      return '';
    }
  }
}

function init() {
  return new SolaarGnomeExtension();
}
