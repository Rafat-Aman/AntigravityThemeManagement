import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

import {
  transformSettings, updateSettingsFile, SettingsError, COLOR_KEY, TOKEN_KEY, SEMANTIC_KEY,
} from '../sidecars/theme-picker/lib/settings-writer.mjs';
import { RULE_TAG } from '../sidecars/theme-picker/lib/color-mapper.mjs';

const read = (text) => parse(text, [], { allowTrailingComma: true });

const USER_SETTINGS = `{
  // Formatting preferences: keep me!
  "editor.tabSize": 2,
  "files.exclude": { "**/.git": true },
  "workbench.colorCustomizations": {
    // my own tweak
    "editorCursor.foreground": "#ff0000",
    "titleBar.activeBackground": "#123456",
  },
  "python.defaultInterpreterPath": "/usr/bin/python3",
}
`;

const payloadA = {
  colors: { 'titleBar.activeBackground': '#282a36', 'statusBar.background': '#191a21' },
  tokenRules: [{ name: `${RULE_TAG} Keywords`, scope: 'keyword', settings: { foreground: '#ff79c6' } }],
  semantic: { enabled: true, rules: { function: '#50fa7b' } },
  meta: { themeId: 'a', themeName: 'Theme A', scope: 'full' },
};

const payloadB = {
  colors: { 'activityBar.background': '#2e3440' },
  tokenRules: null,
  semantic: null,
  meta: { themeId: 'b', themeName: 'Theme B', scope: 'frame' },
};

test('apply merges colors while preserving comments and unrelated settings', () => {
  const { text, record } = transformSettings(USER_SETTINGS, payloadA, null);
  const json = read(text);
  assert.match(text, /\/\/ Formatting preferences: keep me!/);
  assert.match(text, /\/\/ my own tweak/);
  assert.equal(json['editor.tabSize'], 2);
  assert.deepEqual(json['files.exclude'], { '**/.git': true });
  assert.equal(json['python.defaultInterpreterPath'], '/usr/bin/python3');
  assert.equal(json[COLOR_KEY]['editorCursor.foreground'], '#ff0000', 'unrelated color untouched');
  assert.equal(json[COLOR_KEY]['titleBar.activeBackground'], '#282a36');
  assert.equal(json[COLOR_KEY]['statusBar.background'], '#191a21');
  assert.equal(record.colors['titleBar.activeBackground'].previous, '#123456');
  assert.equal(json[TOKEN_KEY].textMateRules.length, 1);
  assert.deepEqual(json[SEMANTIC_KEY], { rules: { function: '#50fa7b' }, enabled: true });
});

test('re-applying another theme undoes the previous one but keeps user edits', () => {
  const first = transformSettings(USER_SETTINGS, payloadA, null);
  // The user tweaks one of our keys after applying.
  const edited = first.text.replace('"statusBar.background": "#191a21"', '"statusBar.background": "#00ff00"');
  const second = transformSettings(edited, payloadB, first.record);
  const json = read(second.text);
  assert.equal(json[COLOR_KEY]['titleBar.activeBackground'], '#123456', 'user value restored');
  assert.equal(json[COLOR_KEY]['statusBar.background'], '#00ff00', 'user edit kept');
  assert.equal(json[COLOR_KEY]['activityBar.background'], '#2e3440');
  assert.equal(json[COLOR_KEY]['editorCursor.foreground'], '#ff0000');
  assert.equal(json[TOKEN_KEY], undefined, 'our token block removed');
  assert.equal(json[SEMANTIC_KEY], undefined, 'our semantic block removed');
  assert.match(second.text, /\/\/ my own tweak/);
});

test('remove restores the original file content semantically', () => {
  const first = transformSettings(USER_SETTINGS, payloadA, null);
  const removed = transformSettings(first.text, null, first.record);
  assert.deepEqual(read(removed.text), read(USER_SETTINGS));
  assert.match(removed.text, /\/\/ Formatting preferences: keep me!/);
});

test("user's own textMateRules survive and keep priority", () => {
  const withRules = `{
  "editor.tokenColorCustomizations": {
    "comments": "#888888",
    "textMateRules": [{ "scope": "string", "settings": { "foreground": "#00ff00" } }]
  }
}`;
  const applied = transformSettings(withRules, payloadA, null);
  const rules = read(applied.text)[TOKEN_KEY].textMateRules;
  assert.equal(rules.length, 2);
  assert.ok(rules[0].name.startsWith(RULE_TAG), 'theme rules first');
  assert.equal(rules[1].scope, 'string', 'user rule last (wins)');
  assert.equal(read(applied.text)[TOKEN_KEY].comments, '#888888');

  const removed = transformSettings(applied.text, null, applied.record);
  assert.deepEqual(read(removed.text), read(withRules));
});

test('empty or missing file gets a clean settings object', () => {
  const { text } = transformSettings('', payloadB, null);
  assert.deepEqual(read(text), { [COLOR_KEY]: { 'activityBar.background': '#2e3440' } });
  assert.ok(text.endsWith('\n'));
});

test('tab-indented files stay tab-indented', () => {
  const tabbed = '{\n\t"editor.tabSize": 4,\n\t"workbench.colorCustomizations": {\n\t\t// keep\n\t\t"foo.bar": "#111111"\n\t}\n}\n';
  const { text } = transformSettings(tabbed, payloadB, null);
  assert.match(text, /\n\t\t"activityBar.background": "#2e3440"/);
  assert.doesNotMatch(text, /\n {2}"/);
});

test('refuses to touch a file with syntax errors', () => {
  assert.throws(() => transformSettings('{ "a": 1,, }', payloadA, null), SettingsError);
  assert.throws(() => transformSettings('[1, 2]', payloadA, null), SettingsError);
  assert.throws(() => transformSettings('{ "workbench.colorCustomizations": "oops" }', payloadA, null), SettingsError);
});

test('updateSettingsFile writes atomically, creates .vscode and follows symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtm-'));
  try {
    const file = join(dir, '.vscode', 'settings.json');
    const res = await updateSettingsFile(file, payloadB, null);
    assert.equal(res.changed, true);
    assert.equal(read(await readFile(file, 'utf8'))[COLOR_KEY]['activityBar.background'], '#2e3440');

    // Symlinked settings.json: the link must survive and the target must change.
    const real = join(dir, 'shared-settings.json');
    await writeFile(real, '{ "editor.tabSize": 2 }\n');
    const linkDir = join(dir, 'proj', '.vscode');
    await mkdir(linkDir, { recursive: true });
    await symlink(real, join(linkDir, 'settings.json'));
    await updateSettingsFile(join(linkDir, 'settings.json'), payloadB, null);
    assert.ok((await lstat(join(linkDir, 'settings.json'))).isSymbolicLink());
    assert.equal(read(await readFile(real, 'utf8'))['editor.tabSize'], 2);
    assert.ok(read(await readFile(real, 'utf8'))[COLOR_KEY]);

    // Removing from a project that never had settings is a no-op.
    const none = await updateSettingsFile(join(dir, 'empty', '.vscode', 'settings.json'), null, null);
    assert.equal(none.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- .code-workspace files (multi-root windows keep window colors in "settings") ---

const WORKSPACE_FILE = `{
  // my multi-root workspace
  "folders": [{ "path": "api" }, { "path": "web" }],
  "settings": {
    "editor.tabSize": 2,
  },
}
`;

test('applies inside the "settings" object of a .code-workspace file and restores it exactly', () => {
  const opts = { root: ['settings'], label: 'demo.code-workspace' };
  const applied = transformSettings(WORKSPACE_FILE, payloadA, null, opts);
  const json = read(applied.text);
  assert.deepEqual(json.folders, [{ path: 'api' }, { path: 'web' }]);
  assert.equal(json.settings['editor.tabSize'], 2);
  assert.equal(json.settings[COLOR_KEY]['titleBar.activeBackground'], '#282a36');
  assert.ok(json.settings[TOKEN_KEY].textMateRules.length);
  assert.equal(json[COLOR_KEY], undefined, 'nothing written at the top level');
  assert.match(applied.text, /\/\/ my multi-root workspace/);

  const switched = transformSettings(applied.text, payloadB, applied.record, opts);
  assert.equal(read(switched.text).settings[COLOR_KEY]['titleBar.activeBackground'], undefined);
  const removed = transformSettings(switched.text, null, switched.record, opts);
  assert.equal(removed.text, WORKSPACE_FILE);
});

test('creates and later removes a missing "settings" object in a workspace file', () => {
  const text = '{\n  "folders": [{ "path": "." }]\n}\n';
  const opts = { root: ['settings'], label: 'x.code-workspace' };
  const applied = transformSettings(text, payloadB, null, opts);
  assert.equal(read(applied.text).settings[COLOR_KEY]['activityBar.background'], '#2e3440');
  assert.equal(applied.record.createdRoot, true);
  const removed = transformSettings(applied.text, null, applied.record, opts);
  assert.deepEqual(read(removed.text), { folders: [{ path: '.' }] });
});

test('refuses a workspace file whose "settings" is not an object', () => {
  assert.throws(
    () => transformSettings('{ "settings": [] }', payloadB, null, { root: ['settings'], label: 'x.code-workspace' }),
    (err) => err instanceof SettingsError && /x\.code-workspace/.test(err.message),
  );
});
