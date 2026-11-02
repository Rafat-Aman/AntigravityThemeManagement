import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanSource, parseDiscoverQuery } from '../sidecars/theme-picker/lib/discovery.mjs';

const src = (q) => parseDiscoverQuery(q).source;

test('plain text is a registry search; publisher.name ids are looked up directly', () => {
  assert.deepEqual(parseDiscoverQuery('  tokyo night '), { type: 'text', text: 'tokyo night' });
  assert.deepEqual(parseDiscoverQuery(''), { type: 'text', text: '' });
  assert.deepEqual(parseDiscoverQuery('sdras.night-owl'), {
    type: 'source', source: { type: 'openvsx', id: 'sdras.night-owl' }, fallbackText: 'sdras.night-owl',
  });
});

test('extension pages on Open VSX and the VS Code Marketplace resolve to Open VSX ids', () => {
  assert.deepEqual(src('https://open-vsx.org/extension/enkia/tokyo-night'), { type: 'openvsx', id: 'enkia.tokyo-night' });
  assert.deepEqual(src('https://marketplace.visualstudio.com/items?itemName=sdras.night-owl'), { type: 'openvsx', id: 'sdras.night-owl' });
  assert.throws(() => parseDiscoverQuery('https://open-vsx.org/'), /extension page/);
});

test('GitHub links become repository or raw theme-file sources', () => {
  assert.deepEqual(src('https://github.com/dracula/visual-studio-code'), {
    type: 'github-repo', repo: 'dracula/visual-studio-code', ref: 'HEAD', path: '',
  });
  assert.deepEqual(src('https://github.com/a/monorepo/tree/main/packages/theme'), {
    type: 'github-repo', repo: 'a/monorepo', ref: 'main', path: 'packages/theme',
  });
  assert.deepEqual(src('https://github.com/a/b/blob/main/themes/x-color-theme.json'), {
    type: 'url', url: 'https://raw.githubusercontent.com/a/b/main/themes/x-color-theme.json',
  });
  assert.deepEqual(src('https://github.com/a/b/blob/v2/sub/package.json'), {
    type: 'github-repo', repo: 'a/b', ref: 'v2', path: 'sub',
  });
  assert.deepEqual(src('https://raw.githubusercontent.com/a/b/main/t.json'), { type: 'url', url: 'https://raw.githubusercontent.com/a/b/main/t.json' });
});

test('only https links are accepted (http is upgraded)', () => {
  assert.deepEqual(src('http://example.com/theme.json'), { type: 'url', url: 'https://example.com/theme.json' });
  assert.throws(() => parseDiscoverQuery('file:///etc/passwd'), /https/);
  assert.throws(() => parseDiscoverQuery('ftp://x/y.json'), /https/);
});

test('cleanSource rejects malformed or unsafe specs from the panel', () => {
  assert.deepEqual(cleanSource({ type: 'openvsx', id: 'a.b', extra: 1 }), { type: 'openvsx', id: 'a.b' });
  assert.deepEqual(cleanSource({ type: 'github-repo', repo: 'a/b', ref: '../../x', path: '../etc' }), { type: 'github-repo', repo: 'a/b', ref: 'HEAD', path: '' });
  for (const bad of [null, {}, { type: 'openvsx', id: 'no-dot' }, { type: 'url', url: 'http://x/y.json' }, { type: 'url', url: 'https://u:p@x/y.json' }, { type: 'github-repo', repo: 'a/b/c' }, { type: 'file', path: '/etc' }]) {
    assert.throws(() => cleanSource(bad), /source/i, JSON.stringify(bad));
  }
});
