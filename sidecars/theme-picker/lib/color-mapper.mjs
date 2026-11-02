// Maps a parsed VS Code / TextMate color theme onto the workbench color keys
// we inject into `workbench.colorCustomizations`, filling sensible fallbacks
// for keys a theme leaves undefined so the result looks coherent no matter
// which base theme the window is currently using.

import {
  chroma, composite, isDark, isHexColor, mix, normalizeHex, readableOn, toLab, deltaE, withAlpha,
} from './color-utils.mjs';

export const RULE_TAG = '[window-theme-manager]';

/** Keys written in "Frame only" mode (title bar, activity bar, status bar). */
export const FRAME_KEYS = [
  'titleBar.activeBackground',
  'titleBar.activeForeground',
  'titleBar.inactiveBackground',
  'titleBar.inactiveForeground',
  'titleBar.border',
  'activityBar.background',
  'activityBar.foreground',
  'activityBar.inactiveForeground',
  'activityBar.activeBorder',
  'activityBar.border',
  'activityBarBadge.background',
  'activityBarBadge.foreground',
  'statusBar.background',
  'statusBar.foreground',
  'statusBar.border',
  'statusBar.noFolderBackground',
  'statusBar.debuggingBackground',
  'statusBar.debuggingForeground',
  'statusBarItem.hoverBackground',
  'statusBarItem.remoteBackground',
  'statusBarItem.remoteForeground',
];

/** Additional keys always guaranteed in "Full theme" mode. */
export const SURFACE_KEYS = [
  'foreground', 'descriptionForeground', 'icon.foreground', 'focusBorder', 'widget.shadow',
  'editor.background', 'editor.foreground', 'editor.lineHighlightBackground', 'editor.selectionBackground',
  'editorCursor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground',
  'editorGutter.background', 'editorWhitespace.foreground', 'editorIndentGuide.background1',
  'sideBar.background', 'sideBar.foreground', 'sideBar.border', 'sideBarTitle.foreground',
  'sideBarSectionHeader.background', 'sideBarSectionHeader.foreground',
  'editorGroupHeader.tabsBackground', 'tab.activeBackground', 'tab.activeForeground', 'tab.inactiveBackground',
  'tab.inactiveForeground', 'tab.border', 'tab.activeBorderTop',
  'panel.background', 'panel.border', 'panelTitle.activeForeground', 'terminal.background', 'terminal.foreground',
  'breadcrumb.background', 'breadcrumb.foreground',
  'button.background', 'button.foreground', 'button.hoverBackground', 'badge.background', 'badge.foreground',
  'progressBar.background', 'textLink.foreground',
  'input.background', 'input.foreground', 'input.border', 'input.placeholderForeground',
  'dropdown.background', 'dropdown.foreground', 'dropdown.border',
  'editorWidget.background', 'editorWidget.foreground', 'editorWidget.border',
  'editorSuggestWidget.background', 'editorSuggestWidget.foreground', 'editorSuggestWidget.selectedBackground',
  'editorHoverWidget.background', 'quickInput.background', 'quickInput.foreground',
  'menu.background', 'menu.foreground', 'menu.selectionBackground', 'menu.selectionForeground',
  'list.activeSelectionBackground', 'list.activeSelectionForeground', 'list.inactiveSelectionBackground',
  'list.hoverBackground', 'notifications.background', 'notifications.foreground',
  'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground',
];

/** The headline colors shown in the UI and used for previews. */
export const CORE_KEYS = [
  'titleBar.activeBackground', 'titleBar.activeForeground', 'activityBar.background', 'activityBar.foreground',
  'statusBar.background', 'statusBar.foreground', 'sideBar.background', 'editor.background', 'editor.foreground',
  'focusBorder', 'button.background', 'activityBarBadge.background',
];

const TOKEN_TARGETS = {
  keyword: ['keyword.control', 'keyword', 'storage.type', 'storage'],
  string: ['string.quoted', 'string'],
  func: ['entity.name.function', 'support.function', 'meta.function-call'],
  comment: ['comment.line', 'comment'],
  number: ['constant.numeric', 'constant'],
  type: ['entity.name.type.class', 'entity.name.type', 'entity.name.class', 'support.class', 'support.type'],
  variable: ['variable.other', 'variable'],
};

const TOKEN_DEFAULTS = {
  dark: { keyword: '#c586c0', string: '#ce9178', func: '#dcdcaa', comment: '#6a9955', number: '#b5cea8', type: '#4ec9b0', variable: '#9cdcfe' },
  light: { keyword: '#af00db', string: '#a31515', func: '#795e26', comment: '#008000', number: '#098658', type: '#267f99', variable: '#001080' },
};

/** Classifies a theme as dark / light / hc-dark / hc-light. */
export function classifyKind(uiTheme, themeType, editorBg) {
  const u = String(uiTheme || themeType || '').toLowerCase();
  if (u === 'hc-black' || u === 'hc' || u === 'hcdark' || u === 'hc-dark') return 'hc-dark';
  if (u === 'hc-light' || u === 'hclight') return 'hc-light';
  if (u === 'vs' || u === 'light') return 'light';
  if (u === 'vs-dark' || u === 'dark') return 'dark';
  return editorBg && !isDark(editorBg) ? 'light' : 'dark';
}

function selectorsOf(scope) {
  if (!scope) return [];
  const list = Array.isArray(scope) ? scope : String(scope).split(',');
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** Finds the best-matching foreground for a TextMate scope. */
export function resolveTokenColor(tokenColors, targetScope) {
  let best = null;
  let bestScore = -1;
  for (const rule of tokenColors || []) {
    const fg = rule?.settings?.foreground;
    if (!isHexColor(fg)) continue;
    for (const selector of selectorsOf(rule.scope)) {
      if (selector.includes(' - ')) continue; // exclusions: skip for previews
      const parts = selector.split(/\s+/);
      const last = parts[parts.length - 1];
      if (targetScope !== last && !targetScope.startsWith(`${last}.`)) continue;
      const score = last.length * 10 - (parts.length - 1) * 5;
      if (score > bestScore) {
        bestScore = score;
        best = fg;
      }
    }
  }
  return best;
}

function defaultTokenForeground(tokenColors) {
  for (const rule of tokenColors || []) {
    if (!rule?.scope && isHexColor(rule?.settings?.foreground)) return rule.settings.foreground;
  }
  return null;
}

function pickAccent(candidates, editorBg) {
  const present = candidates.filter(isHexColor).map((c) => composite(c, editorBg));
  return present.find((c) => chroma(c) >= 22) || present[0] || '#007acc';
}

/**
 * Computes the full set of guaranteed colors (frame + surfaces) and a compact
 * preview palette for one theme.
 */
export function deriveTheme({ colors = {}, tokenColors = [], uiTheme, type }) {
  const c = (key) => (isHexColor(colors[key]) ? colors[key] : null);
  const rawBg = c('editor.background');
  const kind = classifyKind(uiTheme, type, rawBg ? composite(rawBg, '#000000') : null);
  const dark = kind === 'dark' || kind === 'hc-dark';
  const hc = kind.startsWith('hc');

  const editorBg = composite(rawBg || (dark ? '#1e1e1e' : '#ffffff'), dark ? '#000000' : '#ffffff');
  const fg = composite(c('editor.foreground') || c('foreground') || defaultTokenForeground(tokenColors) || (dark ? '#d4d4d4' : '#333333'), editorBg);
  const keywordColor = resolveTokenColor(tokenColors, 'keyword.control') || resolveTokenColor(tokenColors, 'keyword');
  const accent = pickAccent([
    c('activityBarBadge.background'), c('button.background'), c('progressBar.background'), c('textLink.foreground'),
    c('focusBorder'), c('activityBar.activeBorder'), c('tab.activeBorderTop'), keywordColor,
  ], editorBg);

  const sideBarBg = composite(c('sideBar.background') || editorBg, editorBg);
  const activityBg = composite(c('activityBar.background') || sideBarBg, editorBg);
  const titleBg = composite(c('titleBar.activeBackground') || activityBg, editorBg);
  const statusBg = composite(c('statusBar.background') || activityBg, editorBg);
  const muted = mix(fg, editorBg, 0.42);
  const border = hc ? (c('contrastBorder') || accent) : mix(editorBg, fg, 0.12);
  const raised = mix(editorBg, dark ? '#ffffff' : '#000000', dark ? 0.05 : 0.035);
  const widgetBg = composite(c('editorWidget.background') || (sideBarBg !== editorBg ? sideBarBg : raised), editorBg);
  const inputBg = composite(c('input.background') || mix(editorBg, fg, 0.06), editorBg);
  const selection = mix(editorBg, accent, 0.32);
  const accentFg = readableOn(accent, dark ? editorBg : '#ffffff');

  const titleFg = c('titleBar.activeForeground') || readableOn(titleBg, fg);
  const activityFg = c('activityBar.foreground') || readableOn(activityBg, fg);
  const statusFg = c('statusBar.foreground') || readableOn(statusBg, fg);

  const fallbacks = {
    'titleBar.activeBackground': titleBg,
    'titleBar.activeForeground': titleFg,
    'titleBar.inactiveBackground': c('titleBar.inactiveBackground') || titleBg,
    'titleBar.inactiveForeground': c('titleBar.inactiveForeground') || withAlpha(composite(titleFg, titleBg), 0.6),
    'titleBar.border': c('titleBar.border') || (hc ? border : titleBg),
    'activityBar.background': activityBg,
    'activityBar.foreground': activityFg,
    'activityBar.inactiveForeground': c('activityBar.inactiveForeground') || withAlpha(composite(activityFg, activityBg), 0.55),
    'activityBar.activeBorder': c('activityBar.activeBorder') || accent,
    'activityBar.border': c('activityBar.border') || (hc ? border : activityBg),
    'activityBarBadge.background': c('activityBarBadge.background') || accent,
    'activityBarBadge.foreground': c('activityBarBadge.foreground') || accentFg,
    'statusBar.background': statusBg,
    'statusBar.foreground': statusFg,
    'statusBar.border': c('statusBar.border') || (hc ? border : statusBg),
    'statusBar.noFolderBackground': c('statusBar.noFolderBackground') || statusBg,
    'statusBar.debuggingBackground': c('statusBar.debuggingBackground') || accent,
    'statusBar.debuggingForeground': c('statusBar.debuggingForeground') || accentFg,
    'statusBarItem.hoverBackground': c('statusBarItem.hoverBackground') || withAlpha(composite(statusFg, statusBg), 0.12),
    'statusBarItem.remoteBackground': c('statusBarItem.remoteBackground') || accent,
    'statusBarItem.remoteForeground': c('statusBarItem.remoteForeground') || accentFg,

    foreground: c('foreground') || fg,
    descriptionForeground: c('descriptionForeground') || muted,
    'icon.foreground': c('icon.foreground') || fg,
    focusBorder: c('focusBorder') || withAlpha(accent, 0.8),
    'widget.shadow': c('widget.shadow') || (dark ? '#00000066' : '#00000029'),
    'editor.background': editorBg,
    'editor.foreground': fg,
    'editor.lineHighlightBackground': c('editor.lineHighlightBackground') || withAlpha(fg, dark ? 0.06 : 0.05),
    'editor.selectionBackground': c('editor.selectionBackground') || withAlpha(accent, 0.3),
    'editorCursor.foreground': c('editorCursor.foreground') || accent,
    'editorLineNumber.foreground': c('editorLineNumber.foreground') || mix(fg, editorBg, 0.6),
    'editorLineNumber.activeForeground': c('editorLineNumber.activeForeground') || fg,
    'editorGutter.background': c('editorGutter.background') || editorBg,
    'editorWhitespace.foreground': c('editorWhitespace.foreground') || withAlpha(fg, 0.2),
    'editorIndentGuide.background1': c('editorIndentGuide.background1') || c('editorIndentGuide.background') || withAlpha(fg, 0.12),
    'sideBar.background': sideBarBg,
    'sideBar.foreground': c('sideBar.foreground') || fg,
    'sideBar.border': c('sideBar.border') || (hc ? border : sideBarBg),
    'sideBarTitle.foreground': c('sideBarTitle.foreground') || fg,
    'sideBarSectionHeader.background': c('sideBarSectionHeader.background') || sideBarBg,
    'sideBarSectionHeader.foreground': c('sideBarSectionHeader.foreground') || fg,
    'editorGroupHeader.tabsBackground': c('editorGroupHeader.tabsBackground') || sideBarBg,
    'tab.activeBackground': c('tab.activeBackground') || editorBg,
    'tab.activeForeground': c('tab.activeForeground') || fg,
    'tab.inactiveBackground': c('tab.inactiveBackground') || c('editorGroupHeader.tabsBackground') || sideBarBg,
    'tab.inactiveForeground': c('tab.inactiveForeground') || muted,
    'tab.border': c('tab.border') || c('editorGroupHeader.tabsBackground') || sideBarBg,
    'tab.activeBorderTop': c('tab.activeBorderTop') || accent,
    'panel.background': c('panel.background') || editorBg,
    'panel.border': c('panel.border') || border,
    'panelTitle.activeForeground': c('panelTitle.activeForeground') || fg,
    'terminal.background': c('terminal.background') || c('panel.background') || editorBg,
    'terminal.foreground': c('terminal.foreground') || fg,
    'breadcrumb.background': c('breadcrumb.background') || editorBg,
    'breadcrumb.foreground': c('breadcrumb.foreground') || muted,
    'button.background': c('button.background') || accent,
    'button.foreground': c('button.foreground') || accentFg,
    'button.hoverBackground': c('button.hoverBackground') || mix(accent, dark ? '#ffffff' : '#000000', 0.12),
    'badge.background': c('badge.background') || accent,
    'badge.foreground': c('badge.foreground') || accentFg,
    'progressBar.background': c('progressBar.background') || accent,
    'textLink.foreground': c('textLink.foreground') || accent,
    'input.background': inputBg,
    'input.foreground': c('input.foreground') || fg,
    'input.border': c('input.border') || border,
    'input.placeholderForeground': c('input.placeholderForeground') || muted,
    'dropdown.background': c('dropdown.background') || inputBg,
    'dropdown.foreground': c('dropdown.foreground') || fg,
    'dropdown.border': c('dropdown.border') || border,
    'editorWidget.background': widgetBg,
    'editorWidget.foreground': c('editorWidget.foreground') || fg,
    'editorWidget.border': c('editorWidget.border') || border,
    'editorSuggestWidget.background': c('editorSuggestWidget.background') || widgetBg,
    'editorSuggestWidget.foreground': c('editorSuggestWidget.foreground') || fg,
    'editorSuggestWidget.selectedBackground': c('editorSuggestWidget.selectedBackground') || selection,
    'editorHoverWidget.background': c('editorHoverWidget.background') || widgetBg,
    'quickInput.background': c('quickInput.background') || widgetBg,
    'quickInput.foreground': c('quickInput.foreground') || fg,
    'menu.background': c('menu.background') || widgetBg,
    'menu.foreground': c('menu.foreground') || fg,
    'menu.selectionBackground': c('menu.selectionBackground') || selection,
    'menu.selectionForeground': c('menu.selectionForeground') || fg,
    'list.activeSelectionBackground': c('list.activeSelectionBackground') || selection,
    'list.activeSelectionForeground': c('list.activeSelectionForeground') || fg,
    'list.inactiveSelectionBackground': c('list.inactiveSelectionBackground') || withAlpha(fg, 0.1),
    'list.hoverBackground': c('list.hoverBackground') || withAlpha(fg, 0.07),
    'notifications.background': c('notifications.background') || widgetBg,
    'notifications.foreground': c('notifications.foreground') || fg,
    'scrollbarSlider.background': c('scrollbarSlider.background') || withAlpha(fg, 0.16),
    'scrollbarSlider.hoverBackground': c('scrollbarSlider.hoverBackground') || withAlpha(fg, 0.26),
    'scrollbarSlider.activeBackground': c('scrollbarSlider.activeBackground') || withAlpha(fg, 0.36),
  };

  const defaults = TOKEN_DEFAULTS[dark ? 'dark' : 'light'];
  const tokens = {};
  for (const [name, targets] of Object.entries(TOKEN_TARGETS)) {
    let found = null;
    for (const t of targets) {
      found = resolveTokenColor(tokenColors, t);
      if (found) break;
    }
    tokens[name] = composite(found || defaults[name], editorBg);
  }

  const palette = {
    editorBg,
    fg,
    muted,
    sideBarBg,
    activityBg,
    activityFg: composite(activityFg, activityBg),
    titleBg,
    titleFg: composite(titleFg, titleBg),
    statusBg,
    statusFg: composite(statusFg, statusBg),
    accent,
    tabActiveBg: composite(fallbacks['tab.activeBackground'], editorBg),
    tabInactiveBg: composite(fallbacks['tab.inactiveBackground'], editorBg),
    lineHighlight: composite(fallbacks['editor.lineHighlightBackground'], editorBg),
    border: composite(border, editorBg),
    ...tokens,
  };

  const core = {};
  for (const key of CORE_KEYS) core[key] = normalizeHex(fallbacks[key]) || fallbacks[key];

  return { kind, fallbacks, palette, core };
}

/** Builds the `workbench.colorCustomizations` entries for a scope. */
export function buildColorCustomizations(theme, scope) {
  const { fallbacks } = deriveTheme(theme);
  const out = {};
  if (scope === 'frame') {
    for (const key of FRAME_KEYS) out[key] = fallbacks[key];
    return out;
  }
  for (const [key, value] of Object.entries(theme.colors || {})) {
    if (isHexColor(value)) out[key] = value;
  }
  for (const key of [...FRAME_KEYS, ...SURFACE_KEYS]) {
    if (!(key in out) && fallbacks[key]) out[key] = fallbacks[key];
  }
  return out;
}

/** Builds tagged TextMate rules for `editor.tokenColorCustomizations`. */
export function buildTokenRules(theme) {
  const rules = [];
  for (const rule of theme.tokenColors || []) {
    const settings = {};
    for (const k of ['foreground', 'background', 'fontStyle']) {
      if (rule?.settings && typeof rule.settings[k] === 'string') settings[k] = rule.settings[k];
    }
    if (!Object.keys(settings).length) continue;
    const out = { name: `${RULE_TAG} ${rule.name || ''}`.trim() };
    if (rule.scope) out.scope = rule.scope;
    out.settings = settings;
    rules.push(out);
  }
  return rules;
}

/** Builds `editor.semanticTokenColorCustomizations` when the theme has rules. */
export function buildSemanticCustomization(theme) {
  const rules = theme.semanticTokenColors;
  if (!rules || typeof rules !== 'object' || !Object.keys(rules).length) return null;
  return { enabled: theme.semanticHighlighting !== false, rules };
}

/** Lab-space signature used to measure how visually distinct two themes are. */
export function signatureOf(palette) {
  return [
    [toLab(palette.titleBg), 1.5],
    [toLab(palette.statusBg), 1.2],
    [toLab(palette.activityBg), 1.0],
    [toLab(palette.editorBg), 1.0],
    [toLab(palette.accent), 0.8],
  ];
}

export function themeDistance(sigA, sigB) {
  let sum = 0;
  let weights = 0;
  for (let i = 0; i < sigA.length; i++) {
    sum += deltaE(sigA[i][0], sigB[i][0]) * sigA[i][1];
    weights += sigA[i][1];
  }
  return sum / weights;
}
