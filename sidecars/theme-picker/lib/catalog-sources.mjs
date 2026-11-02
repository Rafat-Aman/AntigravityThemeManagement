// Curated list of open-source theme sources.
//
// `openvsx` entries are resolved through the Open VSX registry: we read the
// extension's package.json, iterate `contributes.themes`, and download each
// theme file. This works for themes that are generated at build time (e.g.
// Dracula, Catppuccin) because the published package contains the output.
//
// `github` entries point at raw theme JSON files (used for VS Code's own
// MIT-licensed built-in themes, which Open VSX does not serve).
//
// Edit this file to add or remove themes; then press "Refresh" in the panel or
// run `npm run fetch-themes`.

export const OPENVSX_REGISTRY = 'https://open-vsx.org';

export const OPENVSX_EXTENSIONS = [
  { id: 'dracula-theme.theme-dracula', family: 'Dracula' },
  { id: 'Catppuccin.catppuccin-vsc', family: 'Catppuccin' },
  { id: 'enkia.tokyo-night', family: 'Tokyo Night' },
  { id: 'arcticicestudio.nord-visual-studio-code', family: 'Nord' },
  { id: 'jdinhlife.gruvbox', family: 'Gruvbox' },
  { id: 'zhuangtongfa.material-theme', family: 'One Dark Pro' },
  { id: 'akamud.vscode-theme-onelight', family: 'One Light' },
  { id: 'mvllow.rose-pine', family: 'Rosé Pine', skip: /no italics/i },
  { id: 'RobbOwen.synthwave-vscode', family: "SynthWave '84", license: 'MIT' },
  { id: 'teabyii.ayu', family: 'Ayu', skip: /unbordered/i },
  { id: 'GitHub.github-vscode-theme', family: 'GitHub' },
  { id: 'sainnhe.everforest', family: 'Everforest' },
  { id: 'sdras.night-owl', family: 'Night Owl', skip: /no italics/i },
  { id: 'jolaleye.horizon-theme-vscode', family: 'Horizon', skip: /italic|bold/i },
  { id: 'ahmadawais.shades-of-purple', family: 'Shades of Purple' },
  { id: 'wesbos.theme-cobalt2', family: 'Cobalt2' },
  { id: 'liviuschera.noctis', family: 'Noctis', license: 'MIT' },
  { id: 'antfu.theme-vitesse', family: 'Vitesse' },
  { id: 'atomiks.moonlight', family: 'Moonlight', skip: /italic/i },
  { id: 'uloco.theme-bluloco-dark', family: 'Bluloco', skip: /italic/i },
  { id: 'uloco.theme-bluloco-light', family: 'Bluloco', skip: /italic/i },
];

const VSCODE_RAW = 'https://raw.githubusercontent.com/microsoft/vscode/main/extensions';

// Monokai Pro is a commercial theme, so the MIT-licensed VS Code Monokai
// themes are used instead.
export const GITHUB_THEMES = [
  { label: 'Dark Modern', family: 'VS Code', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-defaults/themes/dark_modern.json` },
  { label: 'Light Modern', family: 'VS Code', uiTheme: 'vs', url: `${VSCODE_RAW}/theme-defaults/themes/light_modern.json` },
  { label: 'Dark High Contrast', family: 'VS Code', uiTheme: 'hc-black', url: `${VSCODE_RAW}/theme-defaults/themes/hc_black.json` },
  { label: 'Light High Contrast', family: 'VS Code', uiTheme: 'hc-light', url: `${VSCODE_RAW}/theme-defaults/themes/hc_light.json` },
  { label: 'Monokai', family: 'Monokai', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-monokai/themes/monokai-color-theme.json` },
  { label: 'Monokai Dimmed', family: 'Monokai', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-monokai-dimmed/themes/dimmed-monokai-color-theme.json` },
  { label: 'Solarized Dark', family: 'Solarized', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-solarized-dark/themes/solarized-dark-color-theme.json` },
  { label: 'Solarized Light', family: 'Solarized', uiTheme: 'vs', url: `${VSCODE_RAW}/theme-solarized-light/themes/solarized-light-color-theme.json` },
  { label: 'Abyss', family: 'VS Code', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-abyss/themes/abyss-color-theme.json` },
  { label: 'Tomorrow Night Blue', family: 'VS Code', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-tomorrow-night-blue/themes/tomorrow-night-blue-color-theme.json` },
  { label: 'Quiet Light', family: 'VS Code', uiTheme: 'vs', url: `${VSCODE_RAW}/theme-quietlight/themes/quietlight-color-theme.json` },
  { label: 'Kimbie Dark', family: 'VS Code', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-kimbie-dark/themes/kimbie-dark-color-theme.json` },
  { label: 'Red', family: 'VS Code', uiTheme: 'vs-dark', url: `${VSCODE_RAW}/theme-red/themes/Red-color-theme.json` },
].map((t) => ({ ...t, license: 'MIT', publisher: 'Microsoft (VS Code built-in)' }));
