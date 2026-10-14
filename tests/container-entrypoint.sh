#!/usr/bin/env bash
# Installs what the tests need in a fresh Arch, Fedora or Ubuntu container and
# runs them as an unprivileged user. Used by CI and tests/run-in-container.sh.

set -euo pipefail

tests_dir=$(cd "$(dirname "$0")" && pwd)

. /etc/os-release
case $ID in
  arch)
    pacman -Syu --noconfirm --needed gnome-shell gtk4 mesa ;;
  fedora)
    dnf install -y gnome-shell gtk4 mesa-dri-drivers dbus-daemon shadow-utils util-linux ;;
  ubuntu | debian)
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gnome-shell gjs gir1.2-gtk-4.0 dbus libgl1-mesa-dri ;;
  *)
    echo "Unsupported distribution: $ID" >&2
    exit 1 ;;
esac > /tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }

useradd -m tester
su tester -c "$tests_dir/run-tests.sh"
