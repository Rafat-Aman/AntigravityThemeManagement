# Changelog

## 1.1.0

- **Editor extension:** installs as a regular `.vsix` in Antigravity IDE (and other VS Code-based editors), with a Window Themes icon in the Activity Bar of every window. Commands: random distinct theme, remove theme, find more themes, refresh catalog, open in an editor tab.
- **Find more tab:** search the Open VSX theme registry or paste an Open VSX, VS Code Marketplace, GitHub or raw `.json` link. Preview the themes, pick which to keep, and add them to your catalog. Added themes survive refreshes and can be removed.
- **Multi-root windows:** colors go into the `settings` of the `.code-workspace` file, where the editor actually reads them.
- Panel layout for narrow side bars; the panel follows the editor's colors.

## 1.0.0

- Antigravity sidecar plugin with a visual picker of 80 open-source themes, offline cache, per-window apply to `.vscode/settings.json`, exact undo, and distinct-theme randomizer.
