// Merges theme colors into a workspace's .vscode/settings.json without
// disturbing anything else in the file.
//
// * The file is edited with jsonc-parser (the library VS Code itself uses),
//   so comments, key order and formatting outside the edited values survive.
// * Every value we write is recorded together with the value it replaced.
//   Re-applying another theme or removing the theme restores the user's own
//   previous values, and leaves alone any value the user edited afterwards.

import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, SyntaxKind,
} from 'jsonc-parser';

import { RULE_TAG } from './color-mapper.mjs';

export const COLOR_KEY = 'workbench.colorCustomizations';
export const TOKEN_KEY = 'editor.tokenColorCustomizations';
export const SEMANTIC_KEY = 'editor.semanticTokenColorCustomizations';

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

export class SettingsError extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

function lineCol(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

/** Parses settings text; throws SettingsError rather than risk clobbering a broken file. */
export function parseSettings(text, label = 'settings.json') {
  if (text.trim() === '') return {};
  const errors = [];
  const value = parse(text, errors, PARSE_OPTIONS);
  if (errors.length) {
    const e = errors[0];
    throw new SettingsError(`${label} has a syntax error (${printParseErrorCode(e.error)} at ${lineCol(text, e.offset)}). Fix it and try again; the file was not modified.`);
  }
  if (!isPlainObject(value)) throw new SettingsError(`${label} does not contain a JSON object; the file was not modified.`);
  return value;
}

export function detectFormatting(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/^([ \t]+)["/]/m);
  if (m?.[1].includes('\t')) return { insertSpaces: false, tabSize: 4, eol };
  return { insertSpaces: true, tabSize: m ? Math.min(Math.max(m[1].length, 2), 8) : 4, eol };
}

class Doc {
  constructor(text) {
    this.text = text.trim() === '' ? '{}' : text;
    this.formatting = detectFormatting(text);
  }

  set(path, value) {
    const edits = modify(this.text, path, value, { formattingOptions: this.formatting });
    this.text = applyEdits(this.text, edits);
  }

  get(path) {
    const tree = parseTree(this.text, [], PARSE_OPTIONS);
    const node = tree && findNodeAtLocation(tree, path);
    return node ? { node, value: parse(this.text.slice(node.offset, node.offset + node.length), [], PARSE_OPTIONS) } : null;
  }

  hasCommentsIn(path) {
    const found = this.get(path);
    if (!found) return false;
    const scanner = createScanner(this.text.slice(found.node.offset, found.node.offset + found.node.length), false);
    for (let t = scanner.scan(); t !== SyntaxKind.EOF; t = scanner.scan()) {
      if (t === SyntaxKind.LineCommentTrivia || t === SyntaxKind.BlockCommentTrivia) return true;
    }
    return false;
  }
}

/**
 * Updates the object at `path` so that managed keys from `prev` are undone and
 * `next` entries are applied. Returns the new record of managed entries.
 */
function applyManagedMap(doc, path, prev = {}, next = null) {
  const existing = doc.get(path);
  if (existing && !isPlainObject(existing.value)) {
    throw new SettingsError(`"${path.join('.')}" in settings.json is not an object; the file was not modified.`);
  }
  const current = existing ? { ...existing.value } : {};
  const ops = new Map(); // key -> value (undefined = delete)

  // 1. Undo what we wrote last time, unless the user has changed it since.
  for (const [key, entry] of Object.entries(prev || {})) {
    if (!(key in current) || !deepEqual(current[key], entry.value)) continue;
    if (entry.previous === undefined || entry.previous === null) {
      delete current[key];
      ops.set(key, undefined);
    } else {
      current[key] = entry.previous;
      ops.set(key, entry.previous);
    }
  }

  // 2. Apply the new values, remembering what each one replaces.
  const record = {};
  for (const [key, value] of Object.entries(next || {})) {
    record[key] = { value, previous: key in current ? current[key] : null };
    current[key] = value;
    ops.set(key, value);
  }

  if (!ops.size) return { record, created: false };

  const created = !existing;
  if (!existing || !doc.hasCommentsIn(path)) {
    // Fast path: rewrite the block in one edit (no comments inside to lose).
    doc.set(path, Object.keys(current).length ? current : undefined);
  } else {
    for (const [key, value] of ops) doc.set([...path, key], value);
  }
  return { record, created };
}

/** Turns an object that ended up empty except for whitespace back into `{}`. */
function collapseEmptyObject(doc, path) {
  const found = doc.get(path);
  if (!found || found.node.type !== 'object' || found.node.children?.length) return;
  const { offset, length } = found.node;
  if (/^\{\s+\}$/.test(doc.text.slice(offset, offset + length))) {
    doc.text = `${doc.text.slice(0, offset)}{}${doc.text.slice(offset + length)}`;
  }
}

function removeEmptyBlock(doc, path) {
  const found = doc.get(path);
  if (found && isPlainObject(found.value) && !Object.keys(found.value).length && !doc.hasCommentsIn(path)) {
    doc.set(path, undefined);
  }
}

function applyTokenRules(doc, rules, root = []) {
  const existing = doc.get([...root, TOKEN_KEY]);
  if (existing && !isPlainObject(existing.value)) {
    throw new SettingsError(`"${TOKEN_KEY}" in settings.json is not an object; the file was not modified.`);
  }
  const currentRules = Array.isArray(existing?.value?.textMateRules) ? existing.value.textMateRules : [];
  const userRules = currentRules.filter((r) => !(typeof r?.name === 'string' && r.name.startsWith(RULE_TAG)));
  // Theme rules first so the user's own rules keep winning.
  const nextRules = [...(rules || []), ...userRules];
  if (deepEqual(nextRules, currentRules)) return false;
  doc.set([...root, TOKEN_KEY, 'textMateRules'], nextRules.length ? nextRules : undefined);
  return !existing;
}

/**
 * Pure transformation used by both apply and remove.
 * @param {string} text      current file contents ('' if missing)
 * @param {object|null} payload  {colors, tokenRules, semantic, meta} or null to remove
 * @param {object|null} prev     record returned by the previous apply
 * @param {{root?: string[], label?: string}} [opts]
 *   root: where the settings object lives (['settings'] in a .code-workspace file)
 */
export function transformSettings(text, payload, prev, { root = [], label = 'settings.json' } = {}) {
  parseSettings(text, label); // validate before touching anything
  const doc = new Doc(text);
  const at = (...keys) => [...root, ...keys];
  if (root.length) {
    const container = doc.get(root);
    if (container && !isPlainObject(container.value)) {
      throw new SettingsError(`"${root.join('.')}" in ${label} is not an object; the file was not modified.`);
    }
  }
  const rootCreated = root.length > 0 && !doc.get(root) && !!payload;
  const createdBlocks = new Set(prev?.createdBlocks || []);

  const colorResult = applyManagedMap(doc, at(COLOR_KEY), prev?.colors, payload?.colors || null);
  if (colorResult.created) createdBlocks.add(COLOR_KEY);

  if (payload?.tokenRules || prev?.tokenRules) {
    if (applyTokenRules(doc, payload?.tokenRules || null, root)) createdBlocks.add(TOKEN_KEY);
  }

  const semanticExisted = !!doc.get(at(SEMANTIC_KEY));
  const semRules = applyManagedMap(doc, at(SEMANTIC_KEY, 'rules'), prev?.semanticRules, payload?.semantic?.rules || null);
  const semEnabled = applyManagedMap(
    doc, at(SEMANTIC_KEY), prev?.semanticEnabled,
    payload?.semantic ? { enabled: payload.semantic.enabled } : null,
  );
  if (!semanticExisted && payload?.semantic) createdBlocks.add(SEMANTIC_KEY);

  // Tidy up containers that we created and that are now empty.
  if (prev?.semanticRules && Object.keys(prev.semanticRules).length) removeEmptyBlock(doc, at(SEMANTIC_KEY, 'rules'));
  for (const key of createdBlocks) {
    removeEmptyBlock(doc, at(key));
    if (!doc.get(at(key))) createdBlocks.delete(key);
  }
  const createdRoot = rootCreated || (!!prev?.createdRoot && !!payload);
  if (prev?.createdRoot && !payload) removeEmptyBlock(doc, root);
  if (!payload) collapseEmptyObject(doc, root);

  let out = doc.text;
  if (!out.endsWith('\n')) out += doc.formatting.eol;
  parseSettings(out, label); // sanity check: never write invalid JSON

  const record = payload ? {
    ...payload.meta,
    appliedAt: new Date().toISOString(),
    colors: colorResult.record,
    tokenRules: !!payload.tokenRules?.length,
    semanticRules: semRules.record,
    semanticEnabled: semEnabled.record,
    createdBlocks: [...createdBlocks],
    ...(createdRoot ? { createdRoot: true } : {}),
  } : null;
  return { text: out, record, changed: out !== text };
}

async function resolveTarget(file) {
  try {
    return await realpath(file); // write through symlinks instead of replacing them
  } catch {
    return file;
  }
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  let mode;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch { /* new file */ }
  const tmp = join(dirname(file), `.${basename(file)}.wtm-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, text, mode ? { mode } : undefined);
  await rename(tmp, file);
}

/**
 * Applies (payload) or removes (payload = null) the theme in a settings file.
 * `opts` is passed to transformSettings (root/label for .code-workspace files).
 */
export async function updateSettingsFile(settingsFile, payload, prev, opts = {}) {
  const target = await resolveTarget(settingsFile);
  const original = await readIfExists(target);
  if (original === null && !payload) return { record: null, changed: false, file: target };
  const result = transformSettings(original ?? '', payload, prev, opts);
  if (result.changed) await atomicWrite(target, result.text);
  return { ...result, file: target };
}
