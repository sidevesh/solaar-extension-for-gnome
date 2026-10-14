import Gtk from 'gi://Gtk?version=4.0';

// A plain window whose WM class is the application ID given as the first argument.
const [appId] = ARGV;
const app = new Gtk.Application({ application_id: appId });
app.connect('activate', () => {
  new Gtk.ApplicationWindow({ application: app, title: appId, default_width: 300, default_height: 200 }).present();
});
app.run([]);
