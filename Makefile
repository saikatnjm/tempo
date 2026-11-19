# Tempo: developer shortcuts. Run "make help" for the list.
UUID := tempo@saikatnjm.github.io

.PHONY: help build zip install uninstall test smoke bench pot clean

help:
	@echo "make build      build both variants into build/"
	@echo "make zip        build installable zips into dist/"
	@echo "make install    install for this user (matches your GNOME Shell version)"
	@echo "make uninstall  remove it again"
	@echo "make test       unit tests (plain gjs, no desktop needed)"
	@echo "make smoke      load the extension in a throwaway headless GNOME Shell"
	@echo "make bench      measure Tempo's processor cost in a clean, hidden GNOME Shell"
	@echo "make pot        refresh the translation template"
	@echo "make clean      remove build/ and dist/"

build:
	@tools/build.sh

zip:
	@tools/build.sh zip

install:
	@tools/install.sh

uninstall:
	@gnome-extensions reset $(UUID) 2>/dev/null || true
	@rm -rf "$${XDG_DATA_HOME:-$$HOME/.local/share}/gnome-shell/extensions/$(UUID)"
	@echo "Removed $(UUID)"

test:
	@tests/unit/run.sh

smoke: build
	@tests/smoke/run.sh

bench:
	@tools/bench.sh

pot:
	@mkdir -p po
	@xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --package-name=Tempo \
		--package-version="$$(cat VERSION)" -o po/tempo.pot src/core/*.js src/prefs/prefs-core.js
	@echo "Wrote po/tempo.pot"

clean:
	@rm -rf build dist
