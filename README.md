# Solaar Extension for GNOME

This allows Solaar to seamlessly support certain features on the Gnome desktop environment. Solaar is a powerful utility for managing Logitech Unifying receivers and devices, and with this extension, you can enhance its integration with Gnome Shell.

Available at [GNOME Shell Extensions](https://extensions.gnome.org/extension/6162/solaar-extension/)

For more information, visit the [Solaar GitHub repository](https://github.com/pwr-Solaar/Solaar)

## Tests

The tests start a disposable headless GNOME Shell with the extension enabled, open real windows in it and check the answers Solaar gets over D-Bus. They use their own D-Bus buses, home directory and settings, so they don't touch the desktop you're logged into.

Against the GNOME Shell installed on your machine (needs `gnome-shell`, `gjs` and GTK 4):

```sh
tests/run-tests.sh
```

Against another GNOME Shell version, in a container (needs Podman or Docker):

```sh
tests/run-in-container.sh fedora:42   # GNOME 48
```

CI runs them on every push and pull request for each supported GNOME Shell version; see `.github/workflows/test.yml` for which image provides which version.
