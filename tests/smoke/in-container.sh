#!/bin/sh
# Run the smoke test inside a container image that has GNOME Shell installed, to check Tempo
# against other GNOME versions than the one on your desktop.
#
#   tests/smoke/in-container.sh <image> [output-dir]
#
# TEMPO_SMOKE_EGO=1 tests the zip made for extensions.gnome.org instead: run "tools/build.sh ego"
# first, and the very files in dist/ego/ are what gets installed in the container.
#
# Images are built from tests/smoke/Dockerfile.apt or Dockerfile.dnf, for example:
#   docker build -t tempo-test:gnome46 -f tests/smoke/Dockerfile.apt --build-arg BASE=ubuntu:24.04 tests/smoke
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
IMAGE=${1:?usage: in-container.sh <image> [output-dir]}
OUT=${2:-$ROOT/build/smoke-$(printf '%s' "$IMAGE" | tr -c 'A-Za-z0-9._-' '-')}
ENGINE=${CONTAINER_ENGINE:-docker}

rm -rf "$OUT"
mkdir -p "$OUT"
chmod 777 "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd)    # docker takes a relative path for a volume name
# The sources are mounted read-only and copied inside, so the container cannot change them.
# CONTAINER_CPUS=2 limits the container to two processor cores, like a small CI machine.
"$ENGINE" run --rm ${CONTAINER_CPUS:+--cpus="$CONTAINER_CPUS"} -e TEMPO_SMOKE_EGO="${TEMPO_SMOKE_EGO:-}" \
    -v "$ROOT:/src:ro" -v "$OUT:/out" "$IMAGE" sh -c '
    set -e
    cp -r /src /tmp/tempo
    cd /tmp/tempo
    if [ "$TEMPO_SMOKE_EGO" = 1 ]; then
        rm -rf build
    else
        rm -rf build dist
        tools/build.sh >/dev/null
    fi
    tests/smoke/run.sh /out
'
