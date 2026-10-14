#!/usr/bin/env bash
# Runs the tests against another GNOME Shell version inside a container, e.g.
#   tests/run-in-container.sh fedora:42      (GNOME 48)
#   tests/run-in-container.sh ubuntu:24.04   (GNOME 46)
# Defaults to archlinux:latest. Needs podman or docker.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
image=${1:-archlinux:latest}
engine=$(command -v podman || command -v docker) || { echo "Needs podman or docker" >&2; exit 1; }

exec "$engine" run --rm -v "$repo:/src:ro" "$image" /src/tests/container-entrypoint.sh
