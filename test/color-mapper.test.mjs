import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildColorCustomizations, buildTokenRules, classifyKind, deriveTheme, FRAME_KEYS, RULE_TAG, resolveTokenColor,
  signatureOf, themeDistance,
} from '../sidecars/theme-picker/lib/color-mapper.mjs';
import { contrast, isHexColor, composite } from '../sidecars/theme-picker/lib/color-utils.mjs';

const minimalDark = { uiTheme: 'vs-dark', colors: { 'editor.background': '#282a36' }, tokenColors: [] };

test('classifyKind maps uiTheme values and falls back to luminance', () => {
  assert.equal(classifyKind('vs-dark'), 'dark');
  assert.equal(classifyKind('vs'), 'light');
  assert.equal(classifyKind('hc-black'), 'hc-dark');
  assert.equal(classifyKind('hc-light'), 'hc-light');
  assert.equal(classifyKind(undefined, undefined, '#fdf6e3'), 'light');
  assert.equal(classifyKind(undefined, undefined, '#002b36'), 'dark');
});

test('frame mode always yields every frame key with valid, readable colors', () => {
  const colors = buildColorCustomizations(minimalDark, 'frame');
  assert.deepEqual(Object.keys(colors).sort(), [...FRAME_KEYS].sort());
  for (const [k, v] of Object.entries(colors)) assert.ok(isHexColor(v), `${k}=${v}`);
  const bg = colors['titleBar.activeBackground'];
  assert.ok(contrast(composite(colors['titleBar.activeForeground'], bg), bg) >= 4.5);
  const sbg = colors['statusBar.background'];
  assert.ok(contrast(composite(colors['statusBar.foreground'], sbg), sbg) >= 4.5);
});

test('full mode keeps the theme’s own colors and fills core gaps', () => {
  const theme = {
    uiTheme: 'vs',
    colors: { 'editor.background': '#fdf6e3', 'activityBar.background': '#eee8d5', 'some.custom.key': '#123456', bogus: 'red' },
    tokenColors: [],
  };
  const colors = buildColorCustomizations(theme, 'full');
  assert.equal(colors['editor.background'], '#fdf6e3');
  assert.equal(colors['activityBar.background'], '#eee8d5');
  assert.equal(colors['some.custom.key'], '#123456');
  assert.equal(colors.bogus, undefined, 'non-hex values are dropped');
  for (const k of ['sideBar.background', 'input.background', 'menu.background', 'statusBar.foreground']) {
    assert.ok(isHexColor(colors[k]), `${k} filled`);
  }
});

test('resolveTokenColor prefers the most specific selector', () => {
  const tokens = [
    { scope: 'keyword', settings: { foreground: '#111111' } },
    { scope: ['keyword.control', 'storage'], settings: { foreground: '#222222' } },
    { scope: 'source.js keyword.control.flow', settings: { foreground: '#333333' } },
    { scope: 'string, constant.numeric', settings: { foreground: '#444444' } },
  ];
  assert.equal(resolveTokenColor(tokens, 'keyword.operator'), '#111111');
  assert.equal(resolveTokenColor(tokens, 'keyword.control'), '#222222');
  assert.equal(resolveTokenColor(tokens, 'keyword.control.flow'), '#333333');
  assert.equal(resolveTokenColor(tokens, 'constant.numeric.integer'), '#444444');
  assert.equal(resolveTokenColor(tokens, 'comment'), null);
});

test('token rules are tagged and stripped of unknown settings', () => {
  const rules = buildTokenRules({ tokenColors: [
    { name: 'Comment', scope: 'comment', settings: { foreground: '#6272a4', fontStyle: 'italic', junk: 1 } },
    { scope: 'x', settings: {} },
  ] });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, `${RULE_TAG} Comment`);
  assert.deepEqual(rules[0].settings, { foreground: '#6272a4', fontStyle: 'italic' });
});

test('palette distance separates different-looking themes', () => {
  const a = deriveTheme(minimalDark).palette;
  const b = deriveTheme({ uiTheme: 'vs', colors: { 'editor.background': '#ffffff', 'statusBar.background': '#007acc' } }).palette;
  const c = deriveTheme({ uiTheme: 'vs-dark', colors: { 'editor.background': '#292b37' } }).palette;
  const ab = themeDistance(signatureOf(a), signatureOf(b));
  const ac = themeDistance(signatureOf(a), signatureOf(c));
  assert.ok(ab > ac * 5, `ab=${ab} ac=${ac}`);
});
