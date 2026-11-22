#!/bin/sh
# Build Tempo. GNOME Shell 45 changed extensions from scripts to ES modules, so there are two
# variants; they share every line of real code and differ only in a few lines of imports.
#
#   tools/build.sh          build both variants into build/
#   tools/build.sh zip      also write installable zips into dist/
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UUID=tempo@saikatnjm.github.io
VERSION=$(cat "$ROOT/VERSION")
SRC=$ROOT/src

command -v glib-compile-schemas >/dev/null 2>&1 || {
    echo "glib-compile-schemas not found (Debian/Ubuntu: libglib2.0-bin, Fedora: glib2)" >&2
    exit 1
}

# build_variant <legacy|esm> <shell versions as a JSON list>
build_variant() {
    out=$ROOT/build/$1/$UUID
    rm -rf "$out"
    mkdir -p "$out/schemas" "$out/icons"
    cat "$SRC/shell/$1-header.js" "$SRC"/core/*.js "$SRC/shell/$1-footer.js" > "$out/extension.js"
    cat "$SRC/prefs/$1-header.js" "$SRC/prefs/prefs-core.js" "$SRC/prefs/$1-footer.js" > "$out/prefs.js"
    cp "$SRC/stylesheet.css" "$out/"
    cp "$SRC"/icons/*.svg "$out/icons/"
    cp "$SRC"/schemas/*.gschema.xml "$out/schemas/"
    glib-compile-schemas --strict "$out/schemas"
    sed -e "s|@SHELL_VERSIONS@|$2|" -e "s|@VERSION@|$VERSION|" "$SRC/metadata.json.in" > "$out/metadata.json"
    cp "$ROOT/LICENSE" "$out/" 2>/dev/null || true
}

build_variant legacy '["42", "43", "44"]'
build_variant esm '["45", "46", "47", "48", "49", "50"]'
echo "Built build/legacy (GNOME 42-44) and build/esm (GNOME 45+), version $VERSION"

# Each release carries every zip twice: once with its version in the name, and once under a
# fixed name, so https://github.com/saikatnjm/tempo/releases/latest/download/<fixed name> always
# downloads the newest version (the website's download buttons use those links).
if [ "${1:-}" = zip ]; then
    rm -rf "$ROOT/dist"
    mkdir -p "$ROOT/dist"
    for pair in legacy:gnome42-44 esm:gnome45-plus; do
        variant=${pair%%:*}
        name=${pair#*:}
        zipfile=$ROOT/dist/tempo-$VERSION-$name.shell-extension.zip
        (cd "$ROOT/build/$variant/$UUID" && zip -q -r "$zipfile" .)
        cp "$zipfile" "$ROOT/dist/tempo-$name.shell-extension.zip"
        echo "Wrote dist/tempo-$VERSION-$name.shell-extension.zip and dist/tempo-$name.shell-extension.zip"
    done
fi
