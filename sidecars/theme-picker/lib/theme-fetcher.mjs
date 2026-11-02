// Downloads, parses and caches the theme catalog: the curated sources in
// catalog-sources.mjs plus any sources the user added from the Discover tab.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

import { GITHUB_THEMES, OPENVSX_EXTENSIONS, OPENVSX_REGISTRY } from './catalog-sources.mjs';
import { deriveTheme } from './color-mapper.mjs';
import { isHexColor } from './color-utils.mjs';

const CACHE_VERSION = 1;
const USER_AGENT = 'window-theme-manager/1.1 (Antigravity theme picker; +https://open-vsx.org)';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PARALLEL_REQUESTS = 8;
const MAX_PARALLEL_SOURCES = 6;
const MAX_INCLUDE_DEPTH = 5;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
/** Theme packs can contribute hundreds of variants; only the first ones are loaded. */
export const MAX_THEMES_PER_SOURCE = 60;

// ---------------------------------------------------------------------------
// Networking

let activeRequests = 0;
const waiting = [];

async function withRequestSlot(fn) {
  if (activeRequests >= MAX_PARALLEL_REQUESTS) await new Promise((resolve) => waiting.push(resolve));
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
    waiting.shift()?.();
  }
}

export async function fetchText(url, { retries = 1 } = {}) {
  return withRequestSlot(async () => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          const err = new Error(res.status === 404 ? `Not found: ${url}` : `HTTP ${res.status} for ${url}`);
          err.status = res.status;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
          lastError = err;
        } else {
          if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw tooLarge(url);
          const text = await res.text();
          if (text.length > MAX_DOWNLOAD_BYTES) throw tooLarge(url);
          return text;
        }
      } catch (err) {
        lastError = err;
        if (err.fatal || (err.status && err.status < 500 && err.status !== 429)) throw err;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastError;
  });
}

function tooLarge(url) {
  const err = new Error(`File is too large (over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB): ${url}`);
  err.fatal = true;
  return err;
}

/** Parses JSON-with-comments (theme files commonly contain comments/trailing commas). */
export function parseThemeJson(text, source = 'theme') {
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new Error(`Could not parse ${source} (${errors.length} JSON errors)`);
  }
  return value;
}

export async function fetchJson(url) {
  return parseThemeJson(await fetchText(url), url);
}

// ---------------------------------------------------------------------------
// Theme normalization

function normalizeColors(colors) {
  const out = {};
  if (!colors || typeof colors !== 'object') return out;
  for (const [key, value] of Object.entries(colors)) {
    if (isHexColor(value)) out[key] = value.trim();
  }
  return out;
}

function normalizeTokenColors(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const rule of list) {
    if (!rule || typeof rule !== 'object' || !rule.settings || typeof rule.settings !== 'object') continue;
    const settings = {};
    for (const k of ['foreground', 'background', 'fontStyle']) {
      if (typeof rule.settings[k] === 'string') settings[k] = rule.settings[k];
    }
    if (!Object.keys(settings).length) continue;
    const entry = {};
    if (typeof rule.name === 'string') entry.name = rule.name;
    if (typeof rule.scope === 'string' || Array.isArray(rule.scope)) entry.scope = rule.scope;
    entry.settings = settings;
    out.push(entry);
  }
  return out;
}

/**
 * Loads a theme file, following `include` chains and external `tokenColors`
 * references. `loadJson` is injectable for tests.
 */
export async function loadThemeFile(url, { loadJson = fetchJson, depth = 0 } = {}) {
  const json = await loadJson(String(url));
  let base = { colors: {}, tokenColors: [], semanticTokenColors: {}, semanticHighlighting: undefined };
  if (typeof json.include === 'string' && depth < MAX_INCLUDE_DEPTH) {
    base = await loadThemeFile(new URL(json.include, url), { loadJson, depth: depth + 1 });
  }

  let ownTokens = [];
  if (Array.isArray(json.tokenColors)) {
    ownTokens = json.tokenColors;
  } else if (typeof json.tokenColors === 'string' && json.tokenColors.toLowerCase().endsWith('.json')) {
    const ref = await loadJson(String(new URL(json.tokenColors, url)));
    ownTokens = ref.tokenColors || ref.settings || [];
  } else if (Array.isArray(json.settings)) {
    ownTokens = json.settings; // legacy tmTheme-as-JSON layout
  }

  return {
    name: typeof json.name === 'string' ? json.name : base.name,
    type: typeof json.type === 'string' ? json.type : base.type,
    colors: { ...base.colors, ...normalizeColors(json.colors) },
    tokenColors: [...base.tokenColors, ...normalizeTokenColors(ownTokens)],
    semanticTokenColors: {
      ...base.semanticTokenColors,
      ...(json.semanticTokenColors && typeof json.semanticTokenColors === 'object' ? json.semanticTokenColors : {}),
    },
    semanticHighlighting: typeof json.semanticHighlighting === 'boolean' ? json.semanticHighlighting : base.semanticHighlighting,
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const titleCase = (s) => s.replace(/[-_.]+/g, ' ').trim().replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'theme';
const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

export function buildEntry({ id, label, family, publisher, license, uiTheme, source, theme }) {
  const derived = deriveTheme({ ...theme, uiTheme });
  return {
    id,
    name: label,
    family,
    publisher,
    license: license || 'unknown',
    uiTheme: uiTheme || null,
    kind: derived.kind,
    source,
    palette: derived.palette,
    core: derived.core,
    colors: theme.colors,
    tokenColors: theme.tokenColors,
    semanticTokenColors: theme.semanticTokenColors,
    semanticHighlighting: theme.semanticHighlighting,
  };
}

/** The light-weight theme description sent to the panel. */
export function summarize(t) {
  return {
    id: t.id,
    name: t.name,
    family: t.family,
    publisher: t.publisher,
    license: t.license,
    kind: t.kind,
    palette: t.palette,
    core: t.core,
    colorCount: Object.keys(t.colors || {}).length,
    tokenRuleCount: (t.tokenColors || []).length,
    source: t.source,
  };
}

// ---------------------------------------------------------------------------
// Sources
//
// A source spec is one of:
//   { type: 'openvsx', id: 'publisher.extension', family?, skip?: RegExp, include?: string[] }
//   { type: 'github-repo', repo: 'owner/name', ref?: 'HEAD', path?: 'sub/dir', include?: string[] }
//   { type: 'url', url: 'https://…/theme.json', label?, family? }
//   { type: 'github', url, label, family, uiTheme, … }   (curated single files)

export const OPENVSX_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;

export function sourceKey(spec) {
  switch (spec.type) {
    case 'openvsx': return `openvsx:${spec.id.toLowerCase()}`;
    case 'github-repo': return `github-repo:${spec.repo.toLowerCase()}${spec.path ? `/${spec.path}` : ''}`;
    case 'url': return `url:${spec.url}`;
    default: return `github:${spec.url}`;
  }
}

/** Source key of a cached theme entry (older caches have no explicit key). */
export function sourceKeyOf(entry) {
  if (entry.source?.key) return entry.source.key;
  return entry.source?.type === 'openvsx' ? `openvsx:${String(entry.source.extension).toLowerCase()}` : `github:${entry.source?.url}`;
}

export const CURATED_SPECS = [
  ...OPENVSX_EXTENSIONS.map((spec) => ({ type: 'openvsx', ...spec })),
  ...GITHUB_THEMES.map((spec) => ({ type: 'github', ...spec })),
];
export const CURATED_KEYS = new Set(CURATED_SPECS.map(sourceKey));

/**
 * Loads the color themes an extension contributes. `base` is the URL of the
 * extension root (the folder holding its package.json).
 */
async function loadContributedThemes(base, { idPrefix, family, publisher, license, skip, include, sourceInfo }) {
  const pkg = await fetchJson(`${base}package.json`);
  const contributed = (Array.isArray(pkg?.contributes?.themes) ? pkg.contributes.themes : [])
    .filter((c) => c && typeof c.path === 'string');
  if (!contributed.length) throw new Error('This extension contributes no color themes (it may be an icon or product-icon theme).');

  let nls = null;
  const localize = async (label) => {
    if (typeof label !== 'string' || !/^%.+%$/.test(label)) return label;
    nls ??= await fetchJson(`${base}package.nls.json`).catch(() => ({}));
    const v = nls[label.slice(1, -1)];
    return typeof v === 'string' ? v : v?.message || null;
  };

  const all = await Promise.all(contributed.map(async (contrib) => ({
    contrib,
    label: (await localize(contrib.label)) || contrib.id || contrib.path.replace(/^.*\/|\.json$/g, ''),
  })));
  const wanted = all.filter(({ label }) => !skip?.test(label) && (!include || include.includes(label)));
  const picked = wanted.slice(0, MAX_THEMES_PER_SOURCE);
  const resolvedFamily = family || (await localize(pkg.displayName)) || pkg.name || idPrefix;

  const entries = [];
  const errors = [];
  let missing = 0;
  await Promise.all(picked.map(async ({ contrib, label }) => {
    try {
      const url = new URL(contrib.path, base);
      const theme = await loadThemeFile(url);
      entries.push(buildEntry({
        id: `${idPrefix}/${slug(label)}`,
        label,
        family: resolvedFamily,
        publisher: publisher || pkg.publisher || 'unknown',
        license: license || (typeof pkg.license === 'string' ? pkg.license : null),
        uiTheme: contrib.uiTheme,
        source: { ...sourceInfo, url: String(url) },
        theme,
      }));
    } catch (err) {
      if (err.status === 404) missing++;
      errors.push(`${label}: ${err.message}`);
    }
  }));
  // Preserve the extension's own ordering (downloads finish out of order).
  const order = picked.map(({ contrib }) => String(new URL(contrib.path, base)));
  entries.sort((a, b) => order.indexOf(a.source.url) - order.indexOf(b.source.url));
  if (!entries.length) {
    const err = new Error(errors.join('; ') || 'no themes loaded');
    if (missing === picked.length) Object.assign(err, { code: 'THEME_FILES_MISSING', pkg });
    throw err;
  }
  return { entries, errors, total: all.length, truncated: wanted.length > picked.length };
}

async function fetchOpenVsxSource(spec) {
  const [namespace, ...rest] = spec.id.split('.');
  const name = rest.join('.');
  const meta = await fetchJson(`${OPENVSX_REGISTRY}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
  const version = meta.version;
  const base = `${OPENVSX_REGISTRY}/vscode/unpkg/${encodeURIComponent(meta.namespace)}/${encodeURIComponent(meta.name)}/${encodeURIComponent(version)}/extension/`;
  const page = `${OPENVSX_REGISTRY}/extension/${meta.namespace}/${meta.name}`;
  const result = await loadContributedThemes(base, {
    idPrefix: spec.id,
    family: spec.family || meta.displayName || meta.name,
    publisher: meta.namespaceDisplayName || meta.publishedBy?.loginName || namespace,
    license: spec.license || meta.license,
    skip: spec.skip,
    include: spec.include,
    sourceInfo: { type: 'openvsx', key: sourceKey(spec), extension: spec.id, version, page },
  });
  return {
    ...result,
    version,
    meta: {
      title: meta.displayName || meta.name, description: meta.description || '', publisher: meta.namespaceDisplayName || namespace,
      license: spec.license || meta.license || null, version, page, iconUrl: meta.files?.icon || null,
      downloads: meta.downloadCount ?? null, repository: meta.repository || null,
    },
  };
}

async function fetchGithubRepoSource(spec) {
  const [owner] = spec.repo.split('/');
  const ref = spec.ref || 'HEAD';
  const sub = spec.path ? `${spec.path.replace(/^\/+|\/+$/g, '')}/` : '';
  const base = `https://raw.githubusercontent.com/${spec.repo}/${encodeURIComponent(ref)}/${sub}`;
  const page = `https://github.com/${spec.repo}${ref !== 'HEAD' || sub ? `/tree/${ref}/${sub}` : ''}`;
  let result;
  try {
    result = await loadContributedThemes(base, {
      idPrefix: `gh/${spec.repo.toLowerCase()}${sub ? `/${slug(sub)}` : ''}`,
      family: spec.family,
      publisher: owner,
      license: spec.license,
      include: spec.include,
      sourceInfo: { type: 'github-repo', key: sourceKey(spec), repo: spec.repo, ref, page },
    });
  } catch (err) {
    if (err.status === 404 && /package\.json/.test(err.message)) {
      throw httpError(404, 'No package.json in that folder of the repository. Link to the folder that contains it, or to a theme .json file.');
    }
    if (err.code === 'THEME_FILES_MISSING') {
      // The theme files are generated at build time (e.g. Dracula, Catppuccin),
      // so only the published extension has them: use its Open VSX release.
      const { publisher, name } = err.pkg || {};
      if (typeof publisher === 'string' && typeof name === 'string' && OPENVSX_ID.test(`${publisher}.${name}`)) {
        const resolvedSource = { type: 'openvsx', id: `${publisher}.${name}` };
        try {
          return { ...(await fetchOpenVsxSource(resolvedSource)), resolvedSource };
        } catch { /* fall through to the explanation below */ }
      }
      throw httpError(404, 'The theme files listed in package.json are not in the repository (they are generated at build time), and no Open VSX release was found. Search for the theme by name instead.');
    }
    throw err;
  }
  const first = result.entries[0];
  return {
    ...result,
    meta: { title: first.family, description: '', publisher: owner, license: first.license, page, iconUrl: null, downloads: null },
  };
}

async function fetchUrlSource(spec) {
  const theme = await loadThemeFile(new URL(spec.url));
  const file = titleCase(decodeURIComponent(new URL(spec.url).pathname.split('/').pop() || 'theme')
    .replace(/\.jsonc?$/i, '').replace(/[-_]?colou?r[-_]?theme$/i, '').replace(/[-_]?theme$/i, '')) || 'Theme';
  const label = spec.label || theme.name || file;
  const family = spec.family || label;
  const page = githubPageFor(spec.url) || spec.url;
  const entry = buildEntry({
    id: `url/${shortHash(spec.url)}/${slug(label)}`,
    label,
    family,
    publisher: new URL(page).hostname === 'github.com' ? new URL(page).pathname.split('/')[1] : new URL(spec.url).hostname,
    license: spec.license,
    uiTheme: spec.uiTheme,
    source: { type: 'url', key: sourceKey(spec), url: spec.url, page },
    theme,
  });
  return {
    entries: [entry], errors: [], total: 1, truncated: false,
    meta: { title: label, description: spec.url, publisher: entry.publisher, license: spec.license || null, page, iconUrl: null, downloads: null },
  };
}

async function fetchGithubSource(spec) {
  const theme = await loadThemeFile(new URL(spec.url));
  return {
    entries: [buildEntry({
      id: `github/${slug(spec.family)}/${slug(spec.label)}`,
      label: spec.label,
      family: spec.family,
      publisher: spec.publisher,
      license: spec.license,
      uiTheme: spec.uiTheme,
      source: { type: 'github', url: spec.url, page: githubPageFor(spec.url) },
      theme,
    })],
    errors: [],
  };
}

function githubPageFor(url) {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${m[4]}` : null;
}

export function fetchSource(spec) {
  switch (spec.type) {
    case 'openvsx': return fetchOpenVsxSource(spec);
    case 'github-repo': return fetchGithubRepoSource(spec);
    case 'url': return fetchUrlSource(spec);
    case 'github': return fetchGithubSource(spec);
    default: return Promise.reject(new Error(`Unknown source type: ${spec.type}`));
  }
}

function sourceLabel(spec) {
  if (spec.family) return spec.type === 'github' ? `${spec.family} ${spec.label}` : spec.family;
  return spec.id || spec.repo || spec.label || spec.url;
}

function paletteSignature(entry) {
  const p = entry.palette;
  return [p.editorBg, p.fg, p.titleBg, p.statusBg, p.sideBarBg, p.accent, p.keyword, p.string, p.func, p.comment].join('|');
}

// ---------------------------------------------------------------------------
// Catalog (cache + refresh job + user library)

export class ThemeCatalog {
  /**
   * @param {{cacheFile: string, seedFile?: string, log?: (msg: string) => void,
   *          library?: import('./library-store.mjs').LibraryStore, fetchSource?: typeof fetchSource}} opts
   */
  constructor({ cacheFile, seedFile, log = () => {}, library = null, fetchSource: fetcher = fetchSource }) {
    this.cacheFile = cacheFile;
    this.seedFile = seedFile;
    this.log = log;
    this.library = library;
    this.fetchSource = fetcher;
    this.data = { version: CACHE_VERSION, fetchedAt: null, sources: [], themes: [] };
    this.byId = new Map();
    this.job = { state: 'idle', done: 0, total: 0, current: [], startedAt: null, finishedAt: null, errors: [] };
    this.loadedFrom = null;
    this.cacheMtime = 0;
    this.previews = new Map(); // source key -> { at, promise }
  }

  async load() {
    for (const [file, label] of [[this.cacheFile, 'cache'], [this.seedFile, 'seed']]) {
      if (!file) continue;
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed?.version === CACHE_VERSION && Array.isArray(parsed.themes)) {
          this.#setData(parsed);
          this.loadedFrom = label;
          if (label === 'cache') this.cacheMtime = (await stat(file)).mtimeMs;
          this.log(`Loaded ${parsed.themes.length} themes from ${label} (${file})`);
          return true;
        }
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`Ignoring unreadable ${label} file ${file}: ${err.message}`);
      }
    }
    return false;
  }

  /**
   * Reloads the cache if another process (another IDE window) rewrote it.
   * Cheap: one stat() call when nothing changed.
   */
  async syncFromDisk() {
    if (this.job.state === 'running') return false;
    try {
      const { mtimeMs } = await stat(this.cacheFile);
      if (mtimeMs <= this.cacheMtime) return false;
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.themes)) return false;
      this.#setData(parsed);
      this.loadedFrom = 'cache';
      this.cacheMtime = mtimeMs;
      return true;
    } catch {
      return false;
    }
  }

  #setData(data) {
    this.data = data;
    this.byId = new Map(data.themes.map((t) => [t.id, t]));
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  get size() {
    return this.data.themes.length;
  }

  /** @param {Set<string>} [userKeys] keys of user-added sources, to flag their themes */
  summaries(userKeys = new Set()) {
    return this.data.themes.map((t) => ({ ...summarize(t), user: userKeys.has(sourceKeyOf(t)) }));
  }

  countBySource() {
    const counts = new Map();
    for (const t of this.data.themes) counts.set(sourceKeyOf(t), (counts.get(sourceKeyOf(t)) || 0) + 1);
    return counts;
  }

  status() {
    return {
      ...this.job,
      promise: undefined,
      fetchedAt: this.data.fetchedAt,
      themeCount: this.data.themes.length,
      revision: this.cacheMtime, // changes whenever the cache file is rewritten
      loadedFrom: this.loadedFrom,
      sources: this.data.sources,
    };
  }

  /** Starts a background refresh (no-op if one is already running). */
  refresh() {
    if (this.job.state === 'running') return this.job.promise;
    this.job = { state: 'running', done: 0, total: CURATED_SPECS.length, current: [], startedAt: new Date().toISOString(), finishedAt: null, errors: [] };
    this.job.promise = this.#runRefresh().catch((err) => {
      this.job.state = 'error';
      this.job.errors.push(err.message);
      this.job.finishedAt = new Date().toISOString();
      this.log(`Catalog refresh failed: ${err.message}`);
    });
    return this.job.promise;
  }

  async #allSpecs() {
    const user = this.library ? await this.library.list() : [];
    return [...CURATED_SPECS, ...user.filter((s) => !CURATED_KEYS.has(s.key))];
  }

  async #runRefresh() {
    const specs = await this.#allSpecs();
    this.job.total = specs.length;
    this.log(`Refreshing theme catalog from ${specs.length} sources...`);
    const results = new Map();
    const queue = [...specs];
    const worker = async () => {
      for (let spec = queue.shift(); spec; spec = queue.shift()) {
        const key = sourceKey(spec);
        const label = sourceLabel(spec);
        this.job.current.push(label);
        try {
          const res = await this.fetchSource(spec);
          results.set(key, { ok: true, ...res });
          for (const e of res.errors) this.job.errors.push(`${label}: ${e}`);
        } catch (err) {
          results.set(key, { ok: false, error: err.message });
          this.job.errors.push(`${label}: ${err.message}`);
          this.log(`Source failed (${key}): ${err.message}`);
        } finally {
          this.job.current = this.job.current.filter((l) => l !== label);
          this.job.done++;
        }
      }
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL_SOURCES }, worker));

    // Keep previously cached themes for sources that failed this time.
    const previousBySource = new Map();
    for (const t of this.data.themes) {
      const key = sourceKeyOf(t);
      if (!previousBySource.has(key)) previousBySource.set(key, []);
      previousBySource.get(key).push(t);
    }

    const themes = [];
    const seen = new Set();
    const sourceStatus = [];
    for (const spec of specs) {
      const key = sourceKey(spec);
      const res = results.get(key);
      const entries = res?.ok ? res.entries : previousBySource.get(key) || [];
      const kept = this.#addUnique(themes, seen, entries);
      sourceStatus.push({
        key, label: sourceLabel(spec), ok: !!res?.ok, error: res?.ok ? null : res?.error,
        themes: kept, stale: !res?.ok && kept > 0, user: !CURATED_KEYS.has(key),
      });
    }

    if (!themes.length) throw new Error('No themes could be downloaded (are you offline?)');

    this.#setData({ version: CACHE_VERSION, fetchedAt: new Date().toISOString(), sources: sourceStatus, themes });
    await this.save();
    this.loadedFrom = 'network';
    this.job.state = 'done';
    this.job.finishedAt = new Date().toISOString();
    this.log(`Catalog refreshed: ${themes.length} themes, ${this.job.errors.length} errors`);
  }

  #addUnique(themes, seen, entries) {
    let kept = 0;
    for (const entry of entries) {
      const sig = `${entry.family}|${paletteSignature(entry)}`;
      if (seen.has(sig) || seen.has(entry.id)) continue; // drop italic/bold-only duplicates
      seen.add(sig);
      seen.add(entry.id);
      themes.push(entry);
      kept++;
    }
    return kept;
  }

  /** Downloads a source without adding it (cached briefly so "Add" is instant). */
  preview(spec) {
    const key = sourceKey(spec);
    const hit = this.previews.get(key);
    if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.promise;
    const promise = this.fetchSource({ ...spec, include: undefined });
    promise.catch(() => this.previews.delete(key));
    this.previews.set(key, { at: Date.now(), promise });
    for (const [k, v] of this.previews) if (Date.now() - v.at > PREVIEW_TTL_MS) this.previews.delete(k);
    return promise;
  }

  /**
   * Adds a user source to the library and its themes to the catalog.
   * @param {object} spec  source spec (see above)
   * @param {string[]|null} include  theme labels to keep (null = all)
   */
  async addSource(requested, include = null) {
    if (!this.library) throw new Error('No library configured');
    if (CURATED_KEYS.has(sourceKey(requested))) throw httpError(409, 'These themes are already part of the built-in catalog.');
    if (this.job.state === 'running') await this.job.promise; // a refresh would overwrite the result

    const result = await this.preview(requested);
    const spec = result.resolvedSource || requested; // e.g. GitHub repo -> its Open VSX release
    const key = sourceKey(spec);
    if (CURATED_KEYS.has(key)) throw httpError(409, 'These themes are already part of the built-in catalog.');
    const wanted = include?.length ? result.entries.filter((e) => include.includes(e.name)) : result.entries;
    if (!wanted.length) throw httpError(400, 'Select at least one theme to add.');

    await this.syncFromDisk();
    const others = this.data.themes.filter((t) => sourceKeyOf(t) !== key);
    const seen = new Set();
    for (const t of others) {
      seen.add(t.id);
      seen.add(`${t.family}|${paletteSignature(t)}`);
    }
    const fresh = [];
    this.#addUnique(fresh, seen, wanted);
    if (!fresh.length) throw httpError(409, 'Those themes are already in your catalog.');

    const record = {
      ...spec,
      key,
      include: include?.length && include.length < result.total ? wanted.map((e) => e.name) : null,
      family: fresh[0].family,
      publisher: fresh[0].publisher,
      addedAt: new Date().toISOString(),
    };
    await this.library.add(record);
    this.#setData({
      ...this.data,
      sources: [...this.data.sources.filter((s) => s.key !== key), { key, label: record.family, ok: true, error: null, themes: fresh.length, stale: false, user: true }],
      themes: [...others, ...fresh],
    });
    await this.save();
    this.log(`Added ${fresh.length} theme(s) from ${key}`);
    return { key, family: record.family, themeIds: fresh.map((t) => t.id) };
  }

  /** Removes a user-added source and its themes. */
  async removeSource(key) {
    if (!this.library) throw new Error('No library configured');
    if (CURATED_KEYS.has(key)) throw httpError(400, 'Built-in themes cannot be removed.');
    if (this.job.state === 'running') await this.job.promise;
    const removedFromLibrary = await this.library.remove(key);
    await this.syncFromDisk();
    const themes = this.data.themes.filter((t) => sourceKeyOf(t) !== key);
    const removed = this.data.themes.length - themes.length;
    if (!removedFromLibrary && !removed) throw httpError(404, 'That source is not in your library.');
    this.#setData({ ...this.data, sources: this.data.sources.filter((s) => s.key !== key), themes });
    await this.save();
    this.log(`Removed ${removed} theme(s) from ${key}`);
    return { key, removed };
  }

  async save(file = this.cacheFile) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data));
    await rename(tmp, file);
    if (file === this.cacheFile) this.cacheMtime = (await stat(file)).mtimeMs;
  }
}
