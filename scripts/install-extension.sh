#!/usr/bin/env bash
# Builds the Window Theme Manager extension (.vsix) and installs it into
# Antigravity IDE, so it is available in every window (Activity Bar icon).
#
#   bash scripts/install-extension.sh            # build + install
#   bash scripts/install-extension.sh --no-build # install the existing .vsix
#   IDE_CLI=/path/to/cli bash scripts/install-extension.sh   # other VS Code-based editors
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
VSIX="$ROOT/dist/window-theme-manager-$VERSION.vsix"

if [ "${1:-}" != "--no-build" ]; then
  if [ ! -x node_modules/.bin/vsce ] || [ ! -x node_modules/.bin/esbuild ]; then
    echo "Installing build tools (npm install)"
    npm install --no-audit --no-fund --loglevel=error
  fi
  echo "Packaging $VSIX"
  npm run --silent package
fi
[ -f "$VSIX" ] || { echo "error: $VSIX not found; run without --no-build" >&2; exit 1; }

find_cli() {
  if [ -n "${IDE_CLI:-}" ]; then echo "$IDE_CLI"; return; fi
  local c
  for c in antigravity-ide \
           "/opt/Antigravity IDE/bin/antigravity-ide" \
           "/usr/share/antigravity-ide/bin/antigravity-ide" \
           "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
           "${LOCALAPPDATA:-/nonexistent}/Programs/Antigravity IDE/bin/antigravity-ide.cmd"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then echo "$c"; return; fi
  done
}

CLI="$(find_cli || true)"
if [ -z "$CLI" ]; then
  cat >&2 <<MSG
Could not find the Antigravity IDE command-line tool.
Install the extension from the IDE instead:
  Extensions view → "…" menu → "Install from VSIX…" → $VSIX
(or set IDE_CLI=/path/to/antigravity-ide and run this script again)
MSG
  exit 1
fi

echo "Installing with: $CLI"
# The IDE prints an unrelated analytics warning on stderr; keep only real errors.
"$CLI" --install-extension "$VSIX" --force 2>&1 | grep -v 'antigravityAnalytics' || true
if "$CLI" --list-extensions --show-versions 2>/dev/null | grep -qi "^local\.window-theme-manager@$VERSION$"; then
  cat <<MSG

Installed local.window-theme-manager@$VERSION in every Antigravity IDE window.
  • Click the "Window Themes" icon in the Activity Bar (left edge).
    If a window that was already open does not show it, run "Developer: Reload Window" there.
  • Command Palette: "Window Themes: …" (random distinct theme, remove, find more themes, open in editor tab).
MSG
else
  echo "error: the extension does not appear in --list-extensions" >&2
  exit 1
fi
