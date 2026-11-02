// Figures out which workspace folder(s) the theme should be applied to.
//
// Antigravity's sidecar bridge does not expose workspace folders directly, so
// candidates are gathered from (in priority order):
//   1. URIs reported by the panel (conversation metadata, see public/workspace.js)
//   2. The Antigravity project the sidecar/conversation belongs to
//      (~/.gemini/config/projects/<id>.json → projectResources[].*.folderUri)
//   3. The IDE's own window state (last active + open windows)
//   4. Every other known Antigravity project

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GEMINI_CONFIG_DIR = process.env.WTM_GEMINI_CONFIG_DIR || join(homedir(), '.gemini', 'config');

/** Converts a file: URI (or absolute path) to a filesystem path; null for remote URIs. */
export function toFsPath(uriOrPath) {
  if (typeof uriOrPath !== 'string' || !uriOrPath.trim()) return null;
  const s = uriOrPath.trim();
  if (s.startsWith('file:')) {
    try {
      return fileURLToPath(s);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // vscode-remote://, etc.
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? resolve(s) : null;
}

export const toUri = (fsPath) => pathToFileURL(fsPath).href;

async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

const WORKSPACE_FILE_EXT = '.code-workspace';
export const isWorkspaceFile = (p) => typeof p === 'string' && p.toLowerCase().endsWith(WORKSPACE_FILE_EXT);
const displayName = (p) => (isWorkspaceFile(p) ? `${basename(p).slice(0, -WORKSPACE_FILE_EXT.length)} (workspace)` : basename(p) || p);
const targetExists = (p) => (isWorkspaceFile(p) ? isFile(p) : isDirectory(p));

function collectFolderUris(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectFolderUris(item, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'folderUri' && typeof v === 'string') out.push(v);
      else if (typeof v === 'object') collectFolderUris(v, out);
    }
  }
  return out;
}

/** Lists Antigravity projects with their folder URIs. */
export async function readProjects(configDir = GEMINI_CONFIG_DIR) {
  const dir = join(configDir, 'projects');
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const projects = await Promise.all(files.map(async (f) => {
    try {
      const json = JSON.parse(await readFile(join(dir, f), 'utf8'));
      return {
        id: json.id || f.replace(/\.json$/, ''),
        name: json.name || null,
        updatedAt: json.updatedAt || null,
        folders: [...new Set(collectFolderUris(json.projectResources))],
      };
    } catch {
      return null;
    }
  }));
  return projects.filter((p) => p && p.folders.length);
}

export async function projectFolders(projectId, configDir = GEMINI_CONFIG_DIR) {
  if (!projectId || /[\\/]/.test(projectId)) return [];
  try {
    const json = JSON.parse(await readFile(join(configDir, 'projects', `${projectId}.json`), 'utf8'));
    return [...new Set(collectFolderUris(json.projectResources))];
  } catch {
    return [];
  }
}

function ideStorageFiles() {
  const names = ['Antigravity IDE', 'Antigravity'];
  const home = homedir();
  let bases;
  if (platform() === 'darwin') bases = [join(home, 'Library', 'Application Support')];
  else if (platform() === 'win32') bases = [process.env.APPDATA || join(home, 'AppData', 'Roaming')];
  else bases = [process.env.XDG_CONFIG_HOME || join(home, '.config')];
  const files = [];
  for (const base of bases) for (const n of names) files.push(join(base, n, 'User', 'globalStorage', 'storage.json'));
  return files;
}

/** Reads the IDE's persisted window state: { lastActive, opened[] } (folder URIs). */
export async function readIdeWindows() {
  let best = null;
  for (const file of ideStorageFiles()) {
    try {
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const ws = JSON.parse(text).windowsState;
      if (!ws) continue;
      // Multi-root windows are recorded with the path of their .code-workspace file.
      const target = (w) => w?.folder || w?.workspaceIdentifier?.configURIPath || null;
      const entry = {
        mtimeMs: info.mtimeMs,
        lastActive: target(ws.lastActiveWindow),
        opened: (ws.openedWindows || []).map(target).filter(Boolean),
      };
      if (!best || entry.mtimeMs > best.mtimeMs) best = entry;
    } catch { /* not installed */ }
  }
  return best || { lastActive: null, opened: [] };
}

/**
 * Builds the de-duplicated, annotated workspace candidate list.
 * @param {{uris?: string[], source?: string, projectId?: string}} hints
 */
export async function listWorkspaceCandidates({ uris = [], source = 'panel', projectId } = {}) {
  const ordered = [];
  const add = (uri, src, extra = {}) => {
    const path = toFsPath(uri);
    if (!path) return;
    const existing = ordered.find((c) => c.path === path);
    if (existing) {
      if (!existing.sources.includes(src)) existing.sources.push(src);
      Object.assign(existing, { ...extra, ...existing });
      return;
    }
    ordered.push({ uri: toUri(path), path, name: displayName(path), sources: [src], ...extra });
  };

  for (const u of uris) add(u, source);

  const envProject = process.env.ANTIGRAVITY_PROJECT_ID;
  for (const id of [projectId, envProject].filter(Boolean)) {
    for (const u of await projectFolders(id)) add(u, 'project', { projectId: id });
  }

  const ide = await readIdeWindows();
  if (ide.lastActive) add(ide.lastActive, 'ide-last-active');
  for (const u of ide.opened) add(u, 'ide-open');

  for (const p of await readProjects()) {
    for (const u of p.folders) add(u, 'antigravity-project', { projectName: p.name });
  }

  const withExists = await Promise.all(ordered.map(async (c) => ({ ...c, exists: await targetExists(c.path) })));
  return withExists.filter((c) => c.exists || c.sources.includes(source));
}

/**
 * Validates a workspace URI/path supplied by the UI. A folder's colors go to
 * <folder>/.vscode/settings.json; a multi-root window's go to the "settings"
 * object of its .code-workspace file (folder-level settings cannot change
 * window colors in a multi-root window).
 */
export async function inspectWorkspace(uriOrPath) {
  const path = toFsPath(uriOrPath);
  if (!path) {
    return { ok: false, error: 'Only local folders (file:// URIs or absolute paths) are supported.' };
  }
  if (isWorkspaceFile(path)) {
    if (!(await isFile(path))) return { ok: false, error: `Workspace file not found: ${path}`, path };
    return {
      ok: true, kind: 'workspace-file', uri: toUri(path), path, name: displayName(path),
      settingsFile: path, settingsRoot: ['settings'], settingsLabel: basename(path), settingsExists: true,
    };
  }
  if (!(await isDirectory(path))) return { ok: false, error: `Folder not found: ${path}`, path };
  const settingsFile = join(path, '.vscode', 'settings.json');
  return {
    ok: true, kind: 'folder', uri: toUri(path), path, name: displayName(path),
    settingsFile, settingsRoot: [], settingsLabel: 'settings.json', settingsExists: await isFile(settingsFile),
  };
}
