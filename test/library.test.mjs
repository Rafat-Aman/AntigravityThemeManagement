import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

import { buildEntry, sourceKey, ThemeCatalog } from '../sidecars/theme-picker/lib/theme-fetcher.mjs';
import { LibraryStore } from '../sidecars/theme-picker/lib/library-store.mjs';
import { createApi } from '../sidecars/theme-picker/lib/api.mjs';

function fakeTheme(label, bg, key) {
  return buildEntry({
    id: `fake.pack/${label.toLowerCase()}`,
    label,
    family: 'Fake Pack',
    publisher: 'fake',
    license: 'MIT',
    uiTheme: 'vs-dark',
    source: { type: 'openvsx', key, extension: 'fake.pack', url: `https://x.test/${label}.json` },
    theme: {
      colors: { 'editor.background': bg, 'titleBar.activeBackground': bg, 'statusBar.background': '#ff0000' },
      tokenColors: [{ scope: 'keyword', settings: { foreground: '#00ff00' } }],
      semanticTokenColors: {},
    },
  });
}

const SPEC = { type: 'openvsx', id: 'fake.pack' };
const KEY = sourceKey(SPEC);
let fetches = 0;
const fakeFetchSource = async (spec) => {
  fetches++;
  if (spec.id !== 'fake.pack') throw new Error('unexpected source');
  const entries = [fakeTheme('One', '#101010', KEY), fakeTheme('Two', '#202020', KEY), fakeTheme('Three', '#303030', KEY)]
    .filter((e) => !spec.include || spec.include.includes(e.name));
  return { entries, errors: [], total: 3, truncated: false, meta: { title: 'Fake Pack' } };
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'wtm-lib-'));
  const library = new LibraryStore(join(dir, 'library.json'));
  const catalog = new ThemeCatalog({ cacheFile: join(dir, 'themes-cache.json'), library, fetchSource: fakeFetchSource });
  return { dir, library, catalog };
}

test('adding a source stores the selection in the library and its themes in the cache', async () => {
  const { dir, library, catalog } = await setup();
  try {
    fetches = 0;
    const preview = await catalog.preview(SPEC);
    assert.equal(preview.entries.length, 3);
    const res = await catalog.addSource(SPEC, ['One', 'Three']);
    assert.equal(fetches, 1, 'add reuses the preview download');
    assert.deepEqual(res.themeIds, ['fake.pack/one', 'fake.pack/three']);
    assert.deepEqual((await library.list()).map((s) => [s.key, s.include]), [[KEY, ['One', 'Three']]]);
    assert.deepEqual(catalog.summaries(await library.keys()).filter((t) => t.user).map((t) => t.name), ['One', 'Three']);

    // Another window (process) sees the change through the cache file.
    const other = new ThemeCatalog({ cacheFile: catalog.cacheFile, library });
    await other.load();
    assert.ok(other.get('fake.pack/one'));

    // A refresh re-downloads user sources with the same selection.
    await catalog.refresh();
    assert.deepEqual(catalog.data.themes.map((t) => t.name), ['One', 'Three']);
    assert.ok(catalog.data.sources.find((s) => s.key === KEY)?.user);

    const removed = await catalog.removeSource(KEY);
    assert.equal(removed.removed, 2);
    assert.deepEqual(await library.list(), []);
    assert.equal(catalog.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('built-in sources cannot be added or removed', async () => {
  const { dir, catalog } = await setup();
  try {
    await assert.rejects(catalog.addSource({ type: 'openvsx', id: 'dracula-theme.theme-dracula' }), { status: 409 });
    await assert.rejects(catalog.removeSource('openvsx:dracula-theme.theme-dracula'), { status: 400 });
    await assert.rejects(catalog.removeSource('openvsx:not.there'), { status: 404 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the API applies to a multi-root .code-workspace file and removes cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtm-api-'));
  try {
    const dataDir = join(dir, 'data');
    await mkdir(dataDir);
    // Seed the cache with one theme.
    await writeFile(join(dataDir, 'themes-cache.json'), JSON.stringify({
      version: 1, fetchedAt: new Date().toISOString(), sources: [], themes: [fakeTheme('One', '#101010', KEY)],
    }));
    const wsFile = join(dir, 'proj.code-workspace');
    const original = '{\n  "folders": [{ "path": "." }],\n  "settings": {}\n}\n';
    await writeFile(wsFile, original);

    const api = createApi({ dataDir });
    await api.init({ autoRefresh: false });
    assert.equal((await api.handle('GET', '/api/nope')).status, 404);
    assert.equal((await api.handle('POST', '/api/catalog')).status, 405);

    const res = await api.handle('POST', '/api/apply', { workspaceUri: wsFile, themeId: 'fake.pack/one', scope: 'frame' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const json = parse(await readFile(wsFile, 'utf8'));
    assert.equal(json.settings['workbench.colorCustomizations']['titleBar.activeBackground'], '#101010');
    assert.equal(json['workbench.colorCustomizations'], undefined);

    const { body } = await api.handle('GET', '/api/applied');
    assert.deepEqual(body.records.map((r) => [r.workspacePath, r.themeName]), [[wsFile, 'One']]);

    assert.equal((await api.handle('POST', '/api/remove', { workspaceUri: wsFile })).status, 200);
    assert.equal(await readFile(wsFile, 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
