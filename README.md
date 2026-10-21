# Solaar Extension for GNOME

This allows Solaar to seamlessly support certain features on the Gnome desktop environment. Solaar is a powerful utility for managing Logitech Unifying receivers and devices, and with this extension, you can enhance its integration with Gnome Shell.

Available at [GNOME Shell Extensions](https://extensions.gnome.org/extension/6162/solaar-extension/)

For more information, visit the [Solaar GitHub repository](https://github.com/pwr-Solaar/Solaar)

## Features

- **Process and MouseProcess rule conditions on Wayland.** Solaar asks the extension which window is focused and which window is under the pointer, which it can't find out by itself on Wayland.
- **Keyboard brightness OSD.** When a Logitech keyboard changes its backlight level, including with its own backlight keys, GNOME's keyboard brightness OSD shows the new level, as it does for laptop keyboards. No Solaar rules are needed.

  The keyboard announces the change in a HID++ notification, which every program reading the receiver (or the Bluetooth keyboard) gets. The extension reads it next to Solaar, with the access Solaar's udev rules already give, and asks each device once where its backlight feature (0x1982) is. That request uses its own HID++ software ID, so Solaar ignores the reply. The notification carries the new level and the keyboard's number of levels; a backlight that is only on or off, or that doesn't report its levels, shows as a full or empty bar, as GNOME does for laptop keyboards like that.

## Tests

The tests start a disposable headless GNOME Shell with the extension enabled, open real windows in it and check the answers Solaar gets over D-Bus. For the keyboard brightness OSD, a fake receiver (`tests/fake-receiver.py`) stands in for the hidraw node. They use their own D-Bus buses, home directory and settings, so they don't touch the desktop you're logged into.

Against the GNOME Shell installed on your machine (needs `gnome-shell`, `gjs`, GTK 4 and Python 3):

```sh
tests/run-tests.sh
```

Against another GNOME Shell version, in a container (needs Podman or Docker):

```sh
tests/run-in-container.sh fedora:42   # GNOME 48
```

CI runs them on every push and pull request for each supported GNOME Shell version; see `.github/workflows/test.yml` for which image provides which version.
