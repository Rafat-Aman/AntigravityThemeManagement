import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadThemeFile, parseThemeJson } from '../sidecars/theme-picker/lib/theme-fetcher.mjs';

test('parseThemeJson accepts comments and trailing commas', () => {
  const json = parseThemeJson(`{
    // comment
    "name": "X", /* block */
    "colors": { "editor.background": "#000000", },
  }`);
  assert.equal(json.name, 'X');
  assert.equal(json.colors['editor.background'], '#000000');
  assert.throws(() => parseThemeJson('not json at all'));
});

test('loadThemeFile follows include chains and external tokenColors', async () => {
  const files = {
    'https://x.test/themes/dark_modern.json': {
      name: 'Dark Modern',
      include: './dark_plus.json',
      colors: { 'editor.background': '#1f1f1f', 'statusBar.background': '#181818' },
    },
    'https://x.test/themes/dark_plus.json': {
      include: './base/dark_vs.json',
      tokenColors: [{ scope: 'entity.name.function', settings: { foreground: '#dcdcaa' } }],
      semanticTokenColors: { newOperator: '#c586c0' },
    },
    'https://x.test/themes/base/dark_vs.json': {
      colors: { 'editor.background': '#1e1e1e', 'editor.foreground': '#d4d4d4', bad: 'nope' },
      tokenColors: './tokens.json',
      semanticHighlighting: true,
    },
    'https://x.test/themes/base/tokens.json': {
      tokenColors: [{ scope: 'keyword', settings: { foreground: '#569cd6' } }],
    },
  };
  const loadJson = async (url) => {
    if (!files[url]) throw new Error(`unexpected fetch ${url}`);
    return files[url];
  };
  const theme = await loadThemeFile(new URL('https://x.test/themes/dark_modern.json'), { loadJson });
  assert.equal(theme.name, 'Dark Modern');
  assert.equal(theme.colors['editor.background'], '#1f1f1f', 'child overrides parent');
  assert.equal(theme.colors['editor.foreground'], '#d4d4d4', 'inherited from grandparent');
  assert.equal(theme.colors.bad, undefined);
  assert.deepEqual(theme.tokenColors.map((t) => t.scope), ['keyword', 'entity.name.function'], 'parent rules first');
  assert.deepEqual(theme.semanticTokenColors, { newOperator: '#c586c0' });
  assert.equal(theme.semanticHighlighting, true);
});
