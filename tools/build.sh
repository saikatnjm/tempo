#!/bin/sh
# Build Tempo. GNOME Shell 45 changed extensions from scripts to ES modules, so there are two
# variants; they share every line of real code and differ only in a few lines of imports.
#
#   tools/build.sh          build both variants into build/
#   tools/build.sh zip      also write installable zips into dist/
#   tools/build.sh ego      write the two zips for extensions.gnome.org into dist/ego/
#
# The zips for extensions.gnome.org hold the same extension, packed the way that website's
# review asks (https://gjs.guide/extensions/review-guidelines/review-guidelines.html):
#   * No fan/ folder and no Install button for the optional fan service: an extension there may
#     not run a script with administrator rights out of its own folder, which the user can write
#     to. Its settings link to the install guide on the website instead (src/prefs/fan-guide.js).
#   * No "version" number in metadata.json: the website numbers every upload itself.
#   * The listing text as the description in metadata.json: the website shows that, and reads
#     it again at every upload. The text is kept in docs/ego-listing.md.
#   * No compiled settings schema for GNOME 45 and later: GNOME compiles it when it installs an
#     extension (since version 44). The zip for GNOME 42 to 44 keeps it, because 42 and 43 don't.
# Nothing else differs: extension.js is the same file in both, and the builds released on GitHub
# keep the fan installer, the compiled schema and their own short description.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UUID=tempo@saikatnjm.github.io
VERSION=$(cat "$ROOT/VERSION")
SRC=$ROOT/src

case "${1:-}" in
    ''|zip|ego) ;;
    *) echo "usage: tools/build.sh [zip|ego]" >&2; exit 2 ;;
esac

command -v glib-compile-schemas >/dev/null 2>&1 || {
    echo "glib-compile-schemas not found (Debian/Ubuntu: libglib2.0-bin, Fedora: glib2)" >&2
    exit 1
}

# The description for extensions.gnome.org, as the inside of a JSON string: the lines of the
# fenced block between the two marker lines in docs/ego-listing.md.
ego_description() {
    awk '
        /<!-- description:start -->/ { inside = 1; next }
        /<!-- description:end -->/ { inside = 0 }
        inside && /^```/ { fenced = !fenced; next }
        inside && fenced {
            gsub(/\\/, "\\\\\\\\"); gsub(/"/, "\\\""); gsub(/\t/, " ")
            printf "%s%s", (lines++ ? "\\n" : ""), $0
        }
    ' "$ROOT/docs/ego-listing.md"
}

# build_variant <legacy|esm> <shell versions as a JSON list> <output folder> [ego]
build_variant() {
    out=$3/$UUID
    rm -rf "$out"
    mkdir -p "$out/schemas" "$out/icons"
    cat "$SRC/shell/$1-header.js" "$SRC"/core/*.js "$SRC/shell/$1-footer.js" > "$out/extension.js"
    cp "$SRC/stylesheet.css" "$out/"
    cp "$SRC"/icons/*.svg "$out/icons/"
    cp "$SRC"/schemas/*.gschema.xml "$out/schemas/"
    if [ "${4:-}" = ego ]; then
        cat "$SRC/prefs/$1-header.js" "$SRC/prefs/prefs-core.js" "$SRC/prefs/fan-guide.js" \
            "$SRC/prefs/$1-footer.js" > "$out/prefs.js"
        if [ "$1" = esm ]; then
            glib-compile-schemas --strict --dry-run "$out/schemas"      # checked, not shipped
        else
            glib-compile-schemas --strict "$out/schemas"
        fi
        description=$(ego_description)
        [ -n "$description" ] || { echo "No description found in docs/ego-listing.md" >&2; exit 1; }
        sed -e "s|@SHELL_VERSIONS@|$2|" -e "s|@VERSION@|$VERSION|" -e '/^ *"version": /d' \
            "$SRC/metadata.json.in" |
            DESCRIPTION=$description awk '
                /^ *"description": / { print "  \"description\": \"" ENVIRON["DESCRIPTION"] "\","; next }
                { print }
            ' > "$out/metadata.json"
    else
        cat "$SRC/prefs/$1-header.js" "$SRC/prefs/prefs-core.js" "$SRC/prefs/fan-installer.js" \
            "$SRC/prefs/$1-footer.js" > "$out/prefs.js"
        # The optional fan service travels with the extension, for the Install button in settings.
        mkdir -p "$out/fan"
        cp "$ROOT/fan/tempo-fan" "$ROOT/fan/tempo-fan.service" "$ROOT/fan/install.sh" "$out/fan/"
        glib-compile-schemas --strict "$out/schemas"
        sed -e "s|@SHELL_VERSIONS@|$2|" -e "s|@VERSION@|$VERSION|" "$SRC/metadata.json.in" > "$out/metadata.json"
    fi
    cp "$ROOT/LICENSE" "$out/" 2>/dev/null || true
}

LEGACY_VERSIONS='["42", "43", "44"]'
ESM_VERSIONS='["45", "46", "47", "48", "49", "50", "51"]'

if [ "${1:-}" = ego ]; then
    build_variant legacy "$LEGACY_VERSIONS" "$ROOT/build/ego/legacy" ego
    build_variant esm "$ESM_VERSIONS" "$ROOT/build/ego/esm" ego
    rm -rf "$ROOT/dist/ego"
    mkdir -p "$ROOT/dist/ego"
    for pair in legacy:gnome42-44 esm:gnome45-plus; do
        variant=${pair%%:*}
        name=${pair#*:}
        zipfile=$ROOT/dist/ego/tempo-$VERSION-ego-$name.shell-extension.zip
        (cd "$ROOT/build/ego/$variant/$UUID" && zip -q -r "$zipfile" .)
        echo "Wrote dist/ego/tempo-$VERSION-ego-$name.shell-extension.zip"
    done
    echo "Upload both at https://extensions.gnome.org/upload/ (see docs/ego-listing.md)"
    exit 0
fi

build_variant legacy "$LEGACY_VERSIONS" "$ROOT/build/legacy"
build_variant esm "$ESM_VERSIONS" "$ROOT/build/esm"
echo "Built build/legacy (GNOME 42-44) and build/esm (GNOME 45+), version $VERSION"

# Each release carries every zip twice: once with its version in the name, and once under a
# fixed name, so https://github.com/saikatnjm/tempo/releases/latest/download/<fixed name> always
# downloads the newest version (the website's download buttons use those links).
if [ "${1:-}" = zip ]; then
    mkdir -p "$ROOT/dist"
    rm -f "$ROOT"/dist/*.zip            # not dist/ego/: those are made by "tools/build.sh ego"
    for pair in legacy:gnome42-44 esm:gnome45-plus; do
        variant=${pair%%:*}
        name=${pair#*:}
        zipfile=$ROOT/dist/tempo-$VERSION-$name.shell-extension.zip
        (cd "$ROOT/build/$variant/$UUID" && zip -q -r "$zipfile" .)
        cp "$zipfile" "$ROOT/dist/tempo-$name.shell-extension.zip"
        echo "Wrote dist/tempo-$VERSION-$name.shell-extension.zip and dist/tempo-$name.shell-extension.zip"
    done
fi
