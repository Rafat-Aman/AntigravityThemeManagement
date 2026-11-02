// "Discover" tab backend: finds color themes online.
//
// * Text queries search the Open VSX registry (the extension gallery
//   Antigravity itself uses). Its "Themes" category also contains icon themes,
//   so each hit's package.json is checked for contributed *color* themes.
// * Links are resolved directly: Open VSX / VS Marketplace extension pages,
//   GitHub repositories (package.json with contributes.themes), and raw theme
//   .json files (GitHub blob/raw, gists, any https URL).

import { OPENVSX_REGISTRY } from './catalog-sources.mjs';
import { fetchJson, OPENVSX_ID, sourceKey } from './theme-fetcher.mjs';

const PAGE_SIZE = 36; // many hits are icon themes and get filtered out
const inspectCache = new Map(); // "ns.name@version" -> promise of { themeCount, kinds }

class QueryError extends Error {}
export { QueryError };

const GH_NAME = /^[\w.-]+$/;

/**
 * Classifies what the user typed.
 * @returns {{type: 'text', text: string} | {type: 'source', source: object, fallbackText?: string}}
 */
export function parseDiscoverQuery(input) {
  const q = String(input ?? '').trim();
  if (!q) return { type: 'text', text: '' };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) {
    let url;
    try {
      url = new URL(q);
    } catch {
      throw new QueryError('That link is not a valid URL.');
    }
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:') throw new QueryError('Only https:// links are supported.');
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (host === 'open-vsx.org' || host === 'www.open-vsx.org') {
      const i = parts[0] === 'extension' || parts[0] === 'api' ? 1 : -1;
      if (i > 0 && parts.length >= 3) return openVsx(`${parts[i]}.${parts[i + 1]}`);
      throw new QueryError('Link to an extension page, like https://open-vsx.org/extension/publisher/name.');
    }
    if (host === 'marketplace.visualstudio.com') {
      const item = url.searchParams.get('itemName');
      if (item && OPENVSX_ID.test(item)) return openVsx(item); // most themes are mirrored on Open VSX
      throw new QueryError('Link to an extension page (…/items?itemName=publisher.name).');
    }
    if (host === 'github.com' || host === 'www.github.com') {
      const [owner, repo, kind, ref, ...rest] = parts;
      if (!owner || !repo || !GH_NAME.test(owner) || !GH_NAME.test(repo)) throw new QueryError('Link to a GitHub repository or theme file.');
      const repoName = repo.replace(/\.git$/, '');
      if ((kind === 'blob' || kind === 'raw') && ref && rest.length) {
        const path = rest.join('/');
        if (/(^|\/)package\.json$/i.test(path)) return githubRepo(owner, repoName, ref, path.replace(/\/?package\.json$/i, ''));
        return themeUrl(`https://raw.githubusercontent.com/${owner}/${repoName}/${ref}/${path}`);
      }
      if (kind === 'tree' && ref) return githubRepo(owner, repoName, ref, rest.join('/'));
      return githubRepo(owner, repoName, 'HEAD', '');
    }
    if (host === 'raw.githubusercontent.com') {
      const [owner, repo, ref, ...rest] = parts;
      const path = rest.join('/');
      if (owner && repo && ref && /(^|\/)package\.json$/i.test(path)) {
        return githubRepo(owner, repo, ref, path.replace(/\/?package\.json$/i, ''));
      }
      return themeUrl(url.href);
    }
    return themeUrl(url.href);
  }

  if (!/\s/.test(q) && OPENVSX_ID.test(q)) return { ...openVsx(q), fallbackText: q };
  return { type: 'text', text: q };
}

const openVsx = (id) => ({ type: 'source', source: { type: 'openvsx', id } });

function githubRepo(owner, repo, ref, path) {
  return { type: 'source', source: { type: 'github-repo', repo: `${owner}/${repo}`, ref: ref || 'HEAD', path: path.replace(/^\/+|\/+$/g, '') } };
}

function themeUrl(href) {
  return { type: 'source', source: { type: 'url', url: href } };
}

/** Validates a source spec coming from the panel (never trust its shape). */
export function cleanSource(raw) {
  if (!raw || typeof raw !== 'object') throw new QueryError('Missing theme source.');
  if (raw.type === 'openvsx' && typeof raw.id === 'string' && OPENVSX_ID.test(raw.id)) {
    return { type: 'openvsx', id: raw.id };
  }
  if (raw.type === 'github-repo' && typeof raw.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(raw.repo)) {
    const ref = typeof raw.ref === 'string' && /^[\w./-]{1,100}$/.test(raw.ref) && !raw.ref.includes('..') ? raw.ref : 'HEAD';
    const path = typeof raw.path === 'string' && /^[\w./ -]{0,200}$/.test(raw.path) && !raw.path.includes('..') ? raw.path : '';
    return { type: 'github-repo', repo: raw.repo, ref, path };
  }
  if (raw.type === 'url' && typeof raw.url === 'string') {
    let url;
    try {
      url = new URL(raw.url);
    } catch { /* invalid */ }
    if (url?.protocol === 'https:' && !url.username && !url.password) return { type: 'url', url: url.href };
  }
  throw new QueryError('Unsupported theme source.');
}

/** Counts the color themes an Open VSX extension contributes (cached). */
function inspectExtension(namespace, name, version) {
  const key = `${namespace}.${name}@${version}`.toLowerCase();
  if (!inspectCache.has(key)) {
    const url = `${OPENVSX_REGISTRY}/vscode/unpkg/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/extension/package.json`;
    const promise = fetchJson(url).then((pkg) => {
      const themes = Array.isArray(pkg?.contributes?.themes) ? pkg.contributes.themes : [];
      const kinds = { dark: 0, light: 0, hc: 0 };
      for (const t of themes) {
        if (t?.uiTheme === 'vs') kinds.light++;
        else if (t?.uiTheme === 'hc-black' || t?.uiTheme === 'hc-light') kinds.hc++;
        else kinds.dark++;
      }
      return { themeCount: themes.length, kinds };
    });
    promise.catch(() => inspectCache.delete(key));
    inspectCache.set(key, promise);
    if (inspectCache.size > 500) inspectCache.delete(inspectCache.keys().next().value);
  }
  return inspectCache.get(key);
}

function toResult(e, info) {
  const id = `${e.namespace}.${e.name}`;
  return {
    key: sourceKey({ type: 'openvsx', id }),
    source: { type: 'openvsx', id },
    title: e.displayName || e.name,
    publisher: e.namespace,
    description: e.description || '',
    version: e.version,
    downloads: e.downloadCount ?? null,
    rating: e.averageRating ?? null,
    verified: !!e.verified,
    iconUrl: e.files?.icon || null,
    page: `${OPENVSX_REGISTRY}/extension/${e.namespace}/${e.name}`,
    themeCount: info.themeCount,
    kinds: info.kinds,
  };
}

/** Searches Open VSX for extensions that contribute color themes. */
export async function searchOpenVsx({ text = '', offset = 0, size = PAGE_SIZE } = {}) {
  const params = new URLSearchParams({
    category: 'Themes',
    size: String(size),
    offset: String(Math.max(0, offset | 0)),
    sortBy: text ? 'relevance' : 'downloadCount',
    sortOrder: 'desc',
  });
  if (text) params.set('query', text);
  const data = await fetchJson(`${OPENVSX_REGISTRY}/api/-/search?${params}`);
  const hits = Array.isArray(data.extensions) ? data.extensions : [];
  const results = await Promise.all(hits.map(async (e) => {
    if (e.deprecated || !e.namespace || !e.name || !e.version) return null;
    const info = await inspectExtension(e.namespace, e.name, e.version).catch(() => null);
    return info?.themeCount ? toResult(e, info) : null;
  }));
  const next = offset + hits.length;
  return {
    results: results.filter(Boolean),
    total: data.totalSize ?? null,
    nextOffset: hits.length && next < (data.totalSize ?? 0) ? next : null,
  };
}

/** Looks up one Open VSX extension by id; null if it does not exist. */
export async function describeOpenVsx(id) {
  const [namespace, ...rest] = id.split('.');
  let meta;
  try {
    meta = await fetchJson(`${OPENVSX_REGISTRY}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(rest.join('.'))}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  if (!meta?.namespace || meta.error) return null;
  const info = await inspectExtension(meta.namespace, meta.name, meta.version).catch(() => ({ themeCount: 0, kinds: { dark: 0, light: 0, hc: 0 } }));
  return toResult(meta, info);
}

/** A result card for a pasted link that can only be described after preview. */
export function describeLink(source) {
  if (source.type === 'github-repo') {
    return {
      key: sourceKey(source), source, title: source.path ? `${source.repo}/${source.path}` : source.repo,
      publisher: source.repo.split('/')[0], description: 'GitHub repository', page: `https://github.com/${source.repo}`,
      themeCount: null, direct: true,
    };
  }
  const url = new URL(source.url);
  return {
    key: sourceKey(source), source, title: decodeURIComponent(url.pathname.split('/').pop() || url.hostname),
    publisher: url.hostname, description: source.url, page: source.url, themeCount: 1, direct: true,
  };
}
