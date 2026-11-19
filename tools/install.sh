#!/bin/sh
# Install Tempo for the current user (no root needed), picking the build that matches the
# running GNOME Shell.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UUID=tempo@saikatnjm.github.io
DEST=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID

command -v gnome-shell >/dev/null 2>&1 || { echo "GNOME Shell not found: Tempo is a GNOME Shell extension." >&2; exit 1; }
major=$(gnome-shell --version | sed 's/[^0-9]*\([0-9][0-9]*\).*/\1/')
if [ "$major" -lt 42 ]; then
    echo "Tempo needs GNOME Shell 42 or newer (found $major)." >&2
    exit 1
fi
if [ "$major" -ge 45 ]; then variant=esm; else variant=legacy; fi

"$ROOT/tools/build.sh" >/dev/null
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$ROOT/build/$variant/$UUID" "$DEST"
echo "Installed Tempo $(cat "$ROOT/VERSION") for GNOME Shell $major in $DEST"

# A running shell only sees a new extension after it restarts, so switch it on in the settings
# directly; it loads at the next login.
if command -v gsettings >/dev/null 2>&1; then
    current=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "@as []")
    case "$current" in
        *"'$UUID'"*) ;;
        "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "$(printf '%s' "$current" | sed "s/]\$/, '$UUID']/")" ;;
    esac
    # GNOME keeps a second list of extensions that were switched off by hand, and that list
    # wins. Take Tempo off it, or a fresh install would stay off without saying why.
    disabled=$(gsettings get org.gnome.shell disabled-extensions 2>/dev/null || echo "@as []")
    case "$disabled" in
        *"'$UUID'"*)
            cleaned=$(printf '%s' "$disabled" | sed -e "s/'$UUID', //" -e "s/, '$UUID'//" -e "s/'$UUID'//")
            [ "$cleaned" = "[]" ] && cleaned="@as []"
            gsettings set org.gnome.shell disabled-extensions "$cleaned" ;;
    esac
fi
echo "Log out and back in (Wayland), or press Alt+F2, type r, Enter (X11), to load it."
