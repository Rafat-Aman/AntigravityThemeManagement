// The panel's backend API, independent of transport. server.mjs exposes it
// over HTTP (Antigravity sidecar / standalone); the editor extension routes
// webview postMessage calls to the same handlers.

import { join } from 'node:path';

import { ThemeCatalog, summarize, sourceKey, CURATED_KEYS } from './theme-fetcher.mjs';
import { AppliedStore } from './applied-store.mjs';
import { LibraryStore } from './library-store.mjs';
import { updateSettingsFile, SettingsError } from './settings-writer.mjs';
import {
  buildColorCustomizations, buildSemanticCustomization, buildTokenRules, signatureOf, themeDistance,
} from './color-mapper.mjs';
import { inspectWorkspace, listWorkspaceCandidates, projectFolders } from './workspace-resolver.mjs';
import {
  cleanSource, describeLink, describeOpenVsx, parseDiscoverQuery, QueryError, searchOpenVsx,
} from './discovery.mjs';

const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{dataDir: string, seedFile?: string, log?: (msg: string) => void,
 *          extraRoutes?: Record<string, (body: object) => Promise<object>>}} opts
 */
export function createApi({ dataDir, seedFile, log = () => {}, extraRoutes = {} }) {
  const library = new LibraryStore(join(dataDir, 'library.json'));
  const catalog = new ThemeCatalog({ cacheFile: join(dataDir, 'themes-cache.json'), seedFile, log, library });
  const applied = new AppliedStore(join(dataDir, 'applied.json'));

  // Serialize settings writes so two clicks can't interleave edits.
  let writeChain = Promise.resolve();
  const serialized = (fn) => {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
  };

  async function requireWorkspace(uri) {
    const info = await inspectWorkspace(uri);
    if (!info.ok) throw new HttpError(400, info.error);
    return info;
  }

  function summarizeRecord(record) {
    if (!record) return null;
    const theme = catalog.get(record.themeId);
    return {
      workspacePath: record.workspacePath,
      themeId: record.themeId,
      themeName: record.themeName,
      family: record.family,
      scope: record.scope,
      appliedAt: record.appliedAt,
      colorCount: Object.keys(record.colors || {}).length,
      palette: theme?.palette || null,
    };
  }

  async function applyTheme({ workspaceUri, themeId, scope }) {
    const ws = await requireWorkspace(workspaceUri);
    const theme = catalog.get(String(themeId || ''));
    if (!theme) throw new HttpError(404, 'Theme not found in the catalog. Try refreshing.');
    const mode = scope === 'frame' ? 'frame' : 'full';
    const payload = {
      colors: buildColorCustomizations(theme, mode),
      tokenRules: mode === 'full' ? buildTokenRules(theme) : null,
      semantic: mode === 'full' ? buildSemanticCustomization(theme) : null,
      meta: { themeId: theme.id, themeName: theme.name, family: theme.family, kind: theme.kind, scope: mode, settingsFile: ws.settingsFile },
    };
    return serialized(async () => {
      await applied.reload();
      const prev = applied.get(ws.path);
      const result = await updateSettingsFile(ws.settingsFile, payload, prev, { root: ws.settingsRoot, label: ws.settingsLabel });
      await applied.set(ws.path, result.record);
      log(`Applied "${theme.name}" (${mode}) to ${ws.settingsFile}`);
      return {
        ok: true,
        file: result.file,
        changed: result.changed,
        colorCount: Object.keys(payload.colors).length,
        tokenRuleCount: payload.tokenRules?.length || 0,
        record: summarizeRecord({ workspacePath: ws.path, ...result.record }),
      };
    });
  }

  async function removeTheme({ workspaceUri }) {
    const ws = await requireWorkspace(workspaceUri);
    return serialized(async () => {
      await applied.reload();
      const prev = applied.get(ws.path);
      if (!prev) return { ok: true, changed: false };
      const result = await updateSettingsFile(ws.settingsFile, null, prev, { root: ws.settingsRoot, label: ws.settingsLabel });
      await applied.set(ws.path, null);
      log(`Removed theme "${prev.themeName}" from ${ws.settingsFile}`);
      return { ok: true, changed: result.changed, file: result.file, removed: summarizeRecord({ workspacePath: ws.path, ...prev }) };
    });
  }

  async function pickDistinct({ workspaceUri, themeIds, excludeId }) {
    const ws = workspaceUri ? await inspectWorkspace(workspaceUri) : { ok: false };
    const wsPath = ws.ok ? ws.path : null;
    await applied.reload();
    const ids = Array.isArray(themeIds) && themeIds.length ? themeIds : null;
    const pool = (ids ? ids.map((id) => catalog.get(id)) : catalog.data.themes).filter(Boolean);
    const current = wsPath ? applied.get(wsPath) : null;
    const exclude = new Set([current?.themeId, excludeId].filter(Boolean));
    const candidates = pool.filter((t) => !exclude.has(t.id));
    if (!candidates.length) throw new HttpError(404, 'No themes match the current filter.');

    // Compare against every theme already in use (other windows and this one).
    const references = applied.all().map((r) => catalog.get(r.themeId)).filter(Boolean);
    const usedFamilies = new Set(references.map((t) => t.family));
    const refSigs = references.map((t) => signatureOf(t.palette));

    const scored = candidates.map((t) => {
      const sig = signatureOf(t.palette);
      const minDistance = refSigs.length ? Math.min(...refSigs.map((r) => themeDistance(sig, r))) : 100;
      return { t, minDistance, score: minDistance + (usedFamilies.has(t.family) ? 0 : 6) };
    }).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.2)));
    const pick = top[Math.floor(Math.random() * top.length)];
    return {
      themeId: pick.t.id,
      themeName: pick.t.name,
      minDistance: Math.round(pick.minDistance),
      comparedWith: references.map((t) => t.name),
    };
  }

  /** Marks results that are already built in or in the user's library. */
  async function withStatus(results) {
    const keys = await library.keys();
    return results.map((r) => ({ ...r, status: CURATED_KEYS.has(r.key) ? 'builtin' : keys.has(r.key) ? 'added' : null }));
  }

  const routes = {
    'GET /api/health': async () => ({ ok: true, themes: catalog.size }),

    'GET /api/catalog': async () => {
      await catalog.syncFromDisk();
      return { status: catalog.status(), themes: catalog.summaries(await library.keys()) };
    },

    'GET /api/catalog/status': async () => {
      await catalog.syncFromDisk();
      return { status: catalog.status() };
    },

    'POST /api/catalog/refresh': async () => {
      catalog.refresh();
      return { status: catalog.status() };
    },

    'POST /api/workspaces': async (body) => {
      const candidates = await listWorkspaceCandidates({
        uris: Array.isArray(body.uris) ? body.uris.filter((u) => typeof u === 'string') : [],
        source: typeof body.source === 'string' ? body.source : 'panel',
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      });
      return { candidates, envProjectId: process.env.ANTIGRAVITY_PROJECT_ID || null };
    },

    'POST /api/project-folders': async (body) => ({ folders: await projectFolders(String(body.projectId || '')) }),

    'POST /api/workspace/inspect': async (body) => inspectWorkspace(String(body.uri || body.path || '')),

    'GET /api/applied': async () => {
      await applied.reload();
      return { records: applied.all().map(summarizeRecord) };
    },

    'POST /api/apply': applyTheme,
    'POST /api/remove': removeTheme,
    'POST /api/random': pickDistinct,

    // --- Discover: find themes online and add them to the library ---

    'POST /api/discover/search': async (body) => {
      const parsed = parseDiscoverQuery(body.query);
      const offset = Number.isFinite(body.offset) ? body.offset : 0;
      if (parsed.type === 'source') {
        if (parsed.source.type === 'openvsx') {
          const hit = await describeOpenVsx(parsed.source.id);
          if (hit) return { mode: 'direct', results: await withStatus([hit]), nextOffset: null };
          if (!parsed.fallbackText) throw new HttpError(404, `No Open VSX extension "${parsed.source.id}". Most VS Code themes are mirrored there; search by name instead.`);
          const res = await searchOpenVsx({ text: parsed.fallbackText, offset });
          return { mode: 'search', ...res, results: await withStatus(res.results) };
        }
        return { mode: 'direct', results: await withStatus([describeLink(parsed.source)]), nextOffset: null };
      }
      const res = await searchOpenVsx({ text: parsed.text, offset });
      return { mode: parsed.text ? 'search' : 'popular', ...res, results: await withStatus(res.results) };
    },

    'POST /api/discover/preview': async (body) => {
      const spec = cleanSource(body.source);
      const result = await catalog.preview(spec);
      const source = result.resolvedSource || spec;
      const key = sourceKey(source);
      const [{ status }] = await withStatus([{ key }]);
      return {
        key,
        source,
        status,
        meta: result.meta || null,
        total: result.total,
        truncated: !!result.truncated,
        errors: result.errors,
        themes: result.entries.map(summarize),
      };
    },

    'GET /api/library': async () => {
      const counts = catalog.countBySource();
      return { sources: (await library.list()).map((s) => ({ ...s, themes: counts.get(s.key) || 0 })) };
    },

    'POST /api/library/add': async (body) => {
      const spec = cleanSource(body.source);
      const include = Array.isArray(body.include) ? body.include.filter((x) => typeof x === 'string') : null;
      return catalog.addSource(spec, include);
    },

    'POST /api/library/remove': async (body) => {
      if (typeof body.key !== 'string') throw new HttpError(400, 'Missing key');
      return catalog.removeSource(body.key);
    },

    ...extraRoutes,
  };

  /** Loads state; refreshes the catalog in the background when missing or stale. */
  async function init({ autoRefresh = true } = {}) {
    await applied.load();
    const loaded = await catalog.load();
    const age = catalog.data.fetchedAt ? Date.now() - Date.parse(catalog.data.fetchedAt) : Infinity;
    if (autoRefresh && (!loaded || catalog.loadedFrom === 'seed' || age > STALE_AFTER_MS)) {
      log(loaded ? 'Theme cache is from the seed or stale; refreshing in the background' : 'No cached themes; fetching catalog');
      catalog.refresh();
    }
  }

  /** Dispatches one request. Never throws; returns { status, body }. */
  async function handle(method, path, body = {}) {
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      const known = Object.keys(routes).some((k) => k.endsWith(` ${path}`));
      return { status: known ? 405 : 404, body: { error: known ? 'Method Not Allowed' : 'Not found' } };
    }
    try {
      return { status: 200, body: await handler(body && typeof body === 'object' ? body : {}) };
    } catch (err) {
      let status = 500;
      if (err instanceof HttpError) status = err.status;
      else if (err instanceof SettingsError) status = 409;
      else if (err instanceof QueryError) status = 400;
      else if (err.status >= 400 && err.status < 500) status = err.status === 429 ? 503 : err.status;
      else if (/^(discover|library)$/.test(path.split('/')[2] || '')) status = 502; // upstream (network) failure
      if (status === 502) log(`Upstream error in ${method} ${path}: ${err.message}`);
      else if (status >= 500) log(`Error in ${method} ${path}: ${err.stack || err.message}`);
      return { status, body: { error: err.message } };
    }
  }

  return { routes, handle, init, catalog, applied, library, applyTheme, removeTheme, pickDistinct };
}
