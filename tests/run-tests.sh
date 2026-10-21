#!/usr/bin/env bash
# Runs the test suite in a disposable headless GNOME Shell with its own D-Bus
# session, home directory and settings, so it never touches the desktop you're
# logged into. Needs gnome-shell, gjs, GTK 4 and Python 3.
#
# Set SOLAAR_TEST_KEEP_LOGS=1 to keep the shell and window logs afterwards.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d -t solaar-extension-tests.XXXXXX)

cleanup() {
  if [[ ${SOLAAR_TEST_KEEP_LOGS:-} == 1 ]]; then
    echo "Logs kept in $work/logs"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

export HOME=$work/home
export XDG_CONFIG_HOME=$work/config
export XDG_DATA_HOME=$work/data
export XDG_CACHE_HOME=$work/cache
export XDG_STATE_HOME=$work/state
export XDG_RUNTIME_DIR=$work/runtime
export SOLAAR_TEST_LOG_DIR=$work/logs
unset DISPLAY WAYLAND_DISPLAY

mkdir -p "$HOME" "$XDG_CONFIG_HOME/glib-2.0/settings" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" \
  "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_RUNTIME_DIR" "$SOLAAR_TEST_LOG_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

ln -s "$repo/solaar-extension@sidevesh" "$XDG_DATA_HOME/gnome-shell/extensions/"
ln -s "$repo/tests/helper/solaar-test-helper@sidevesh" "$XDG_DATA_HOME/gnome-shell/extensions/"

export GSETTINGS_BACKEND=keyfile
cat > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" <<'EOF'
[org/gnome/shell]
enabled-extensions=['solaar-extension@sidevesh', 'solaar-test-helper@sidevesh']
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
enable-animations=false

# With no input source set, GNOME Shell asks systemd-localed for the default
# one, and GNOME 45 and 47 crash when localed is missing, as in containers.
[org/gnome/desktop/input-sources]
sources=[('xkb', 'us')]
EOF

# Keep GTK's accessibility bridge out of the test windows.
export NO_AT_BRIDGE=1 GTK_A11Y=none

# The outer bus stands in for the system bus, so the shell can't reach the real
# logind, GDM or UPower; the inner one is the session bus.
status=0
dbus-run-session --config-file="$repo/tests/dbus.conf" -- \
  sh -c 'DBUS_SYSTEM_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS exec "$@"' sh \
  dbus-run-session --config-file="$repo/tests/dbus.conf" -- \
  gjs -m "$repo/tests/test-solaar.js" || status=$?

if [[ $status != 0 ]]; then
  echo
  echo "--- last 50 lines of the GNOME Shell log ---"
  tail -n 50 "$SOLAAR_TEST_LOG_DIR/gnome-shell.log" 2>/dev/null || echo "(no log written)"
fi
exit $status
