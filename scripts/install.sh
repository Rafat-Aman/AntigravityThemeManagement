#!/usr/bin/env bash
# Installs the *sidecar plugin* (for sidecar-enabled Antigravity hosts and
# standalone `npm start`). For Antigravity IDE, install the editor extension
# instead: bash scripts/install-extension.sh
#
# Installs the plugin into Antigravity's global customization root
# (~/.gemini/config/plugins/window-theme-manager by default), installs its npm
# dependencies and pre-downloads the theme catalog.
#
#   bash scripts/install.sh [destination]
#
# Antigravity watches the directory and starts the sidecar automatically.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/.gemini/config/plugins/window-theme-manager}"

command -v node >/dev/null || { echo "error: node (>= 20.10) is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "error: npm is required" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=10)?0:1)' \
  || { echo "error: Node >= 20.10 is required (found $(node --version))" >&2; exit 1; }

if [ "$SRC" = "$(cd "$(dirname "$DEST")" 2>/dev/null && pwd)/$(basename "$DEST")" ]; then
  echo "Source and destination are the same; installing dependencies in place."
else
  echo "Copying plugin to $DEST"
  mkdir -p "$DEST"
  if command -v rsync >/dev/null; then
    rsync -a --delete --exclude node_modules --exclude .data --exclude .cache --exclude /dist --exclude extension/dist "$SRC/" "$DEST/"
  else
    (cd "$SRC" && tar --exclude=node_modules --exclude=.data --exclude=.cache --exclude=./dist --exclude=./extension/dist -cf - .) | (cd "$DEST" && tar -xf -)
  fi
fi

echo "Installing npm dependencies"
(cd "$DEST" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

echo "Pre-downloading the theme catalog (for offline use)"
(cd "$DEST" && node scripts/fetch-themes.mjs) || echo "warning: catalog download failed; the panel will retry when it opens"

echo
echo "Installed to $DEST"
echo "  • Sidecar-enabled Antigravity hosts start it automatically:"
echo "      Agent Manager → Extensions menu → \"Window Themes\""
echo "  • Antigravity IDE does not run sidecars; install the editor extension instead:"
echo "      bash \"$SRC/scripts/install-extension.sh\""
echo "    (or standalone: cd \"$DEST\" && npm start, then open the printed URL)"
