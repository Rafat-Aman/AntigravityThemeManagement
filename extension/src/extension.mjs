// Window Theme Manager as a regular editor extension (Antigravity IDE, VS Code
// and other VS Code-based editors).
//
// The panel UI is the same one the Antigravity sidecar serves
// (sidecars/theme-picker/public). Instead of HTTP, the webview talks to this
// extension host over postMessage (see media/bridge.js), and requests are
// handled by the same API module the sidecar server uses. Every IDE window has
// its own extension host, so "the current window" is known exactly.
//
// Bundled to extension/dist/extension.cjs by scripts/build-extension.mjs.

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../../sidecars/theme-picker/lib/api.mjs';

const VIEW_ID = 'windowThemes.picker';

/** @type {vscode.ExtensionContext} */
let ctx;
let output;
let apiPromise = null;
/** Live webviews (side bar view and editor panels) to notify about changes. */
const webviews = new Set();

const log = (msg) => output?.appendLine(`${new Date().toISOString()} ${msg}`);

// ---------------------------------------------------------------------------
// Backend

// Data written by the sidecar / standalone version (`npm start`), imported once.
const LEGACY_DATA_DIRS = [
  join(homedir(), '.gemini', 'config', 'plugins', 'window-theme-manager', 'sidecars', 'theme-picker', '.data'),
];
const LEGACY_SEEDS = [
  join(homedir(), '.gemini', 'config', 'plugins', 'window-theme-manager', 'sidecars', 'theme-picker', '.cache', 'themes.json'),
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function importLegacyData(dataDir) {
  for (const dir of LEGACY_DATA_DIRS) {
    for (const file of ['applied.json', 'library.json', 'themes-cache.json']) {
      const from = join(dir, file);
      const to = join(dataDir, file);
      if (!(await exists(to)) && (await exists(from))) {
        await copyFile(from, to);
        log(`Imported ${file} from ${dir}`);
      }
    }
  }
}

function getApi() {
  apiPromise ??= (async () => {
    const dataDir = ctx.globalStorageUri.fsPath; // shared by all windows
    await mkdir(dataDir, { recursive: true });
    await importLegacyData(dataDir).catch((err) => log(`Could not import earlier data: ${err.message}`));
    let seedFile;
    for (const seed of LEGACY_SEEDS) if (await exists(seed)) seedFile = seed;
    const api = createApi({
      dataDir,
      seedFile,
      log,
      extraRoutes: {
        'GET /api/host/window': async () => ({ uris: windowTargets(), name: vscode.workspace.name || null }),
      },
    });
    await api.init();
    // Tell open panels when a background catalog refresh finishes.
    watchRefresh(api);
    log(`Ready: ${api.catalog.size} themes, data in ${dataDir}`);
    return api;
  })();
  apiPromise.catch((err) => {
    log(`Startup failed: ${err.stack || err.message}`);
    apiPromise = null;
  });
  return apiPromise;
}

function watchRefresh(api) {
  const job = api.catalog.job;
  if (job.state === 'running') job.promise.then(() => broadcast({ type: 'catalog-changed' }));
}

/**
 * Where this window's colors live: the .code-workspace file of a multi-root
 * window, otherwise its folder(s). Only local and remote file systems the
 * extension host can write to directly are supported.
 */
function windowTargets() {
  const usable = (uri) => uri && (uri.scheme === 'file' || uri.scheme === 'vscode-remote');
  const wsFile = vscode.workspace.workspaceFile;
  if (wsFile) return usable(wsFile) ? [wsFile.fsPath] : []; // unsaved (untitled) workspaces can't hold settings
  return (vscode.workspace.workspaceFolders || []).filter((f) => usable(f.uri)).map((f) => f.uri.fsPath);
}

function broadcast(event) {
  for (const webview of webviews) webview.postMessage({ type: 'host-event', event }).then(undefined, () => {});
}

// ---------------------------------------------------------------------------
// Webview

async function renderHtml(webview, location) {
  const pub = vscode.Uri.joinPath(ctx.extensionUri, 'sidecars', 'theme-picker', 'public');
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'extension', 'media');
  const nonce = randomBytes(18).toString('base64');
  const src = (base, file) => webview.asWebviewUri(vscode.Uri.joinPath(base, file)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`, // extension icons from Open VSX
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  let html = await readFile(vscode.Uri.joinPath(pub, 'index.html').fsPath, 'utf8');
  const replacements = [
    ['<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`],
    ['href="/styles.css"', `href="${src(pub, 'styles.css')}"`],
    ['<script src="/preload.js"></script>', `<script nonce="${nonce}" data-location="${location}" src="${src(media, 'bridge.js')}"></script>`],
    ['<script src="/workspace.js"></script>', `<script nonce="${nonce}" src="${src(pub, 'workspace.js')}"></script>`],
    ['<script type="module" src="/app.js"></script>', `<script nonce="${nonce}" type="module" src="${src(pub, 'app.js')}"></script>`],
  ];
  for (const [from, to] of replacements) {
    if (!html.includes(from)) throw new Error(`index.html is missing ${from}`);
    html = html.replace(from, to);
  }
  return html;
}

async function attachWebview(webview, location) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(ctx.extensionUri, 'sidecars', 'theme-picker', 'public'),
      vscode.Uri.joinPath(ctx.extensionUri, 'extension', 'media'),
    ],
  };
  webviews.add(webview);
  const sub = webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'request') {
      let res;
      try {
        const api = await getApi();
        res = await api.handle(String(msg.method || 'GET'), String(msg.path || ''), msg.body);
        if (msg.path === '/api/catalog/refresh') watchRefresh(api);
        if (res.status === 200 && (msg.path === '/api/apply' || msg.path === '/api/remove')) {
          broadcast({ type: 'applied-changed' }); // other panels in this window
        }
      } catch (err) {
        res = { status: 500, body: { error: err.message } };
      }
      webview.postMessage({ type: 'response', id: msg.id, status: res.status, body: res.body });
    }
  });
  webview.html = await renderHtml(webview, location);
  return {
    dispose() {
      sub.dispose();
      webviews.delete(webview);
    },
  };
}

class PickerViewProvider {
  /** @param {vscode.WebviewView} view */
  async resolveWebviewView(view) {
    const handle = await attachWebview(view.webview, 'sidebar');
    view.onDidChangeVisibility(() => {
      if (view.visible) view.webview.postMessage({ type: 'host-event', event: { type: 'visible' } });
    });
    view.onDidDispose(() => handle.dispose());
  }
}

let panel = null;
async function openInEditor() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('windowThemes.editor', 'Window Themes', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'extension', 'media', 'activity.svg');
  const handle = await attachWebview(panel.webview, 'editor');
  panel.onDidChangeViewState(() => {
    if (panel?.visible) panel.webview.postMessage({ type: 'host-event', event: { type: 'visible' } });
  });
  panel.onDidDispose(() => {
    handle.dispose();
    panel = null;
  });
}

// ---------------------------------------------------------------------------
// Commands that work without opening the panel

async function currentTarget() {
  const targets = windowTargets();
  if (!targets.length) {
    vscode.window.showWarningMessage(vscode.workspace.workspaceFile
      ? 'Save this multi-root workspace first: window colors are stored in its .code-workspace file.'
      : 'Open a folder first: Window Themes stores colors in the folder\'s .vscode/settings.json.');
    return null;
  }
  return targets[0];
}

async function call(path, body) {
  const api = await getApi();
  const res = await api.handle('POST', path, body);
  if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
  return res.body;
}

async function randomizeCommand() {
  const target = await currentTarget();
  if (!target) return;
  try {
    const api = await getApi();
    await api.applied.reload();
    const previous = api.applied.get((await api.handle('POST', '/api/workspace/inspect', { path: target })).body.path);
    const pick = await call('/api/random', { workspaceUri: target });
    const res = await call('/api/apply', { workspaceUri: target, themeId: pick.themeId, scope: previous?.scope || 'full' });
    broadcast({ type: 'applied-changed' });
    const choice = await vscode.window.showInformationMessage(`Applied ${pick.themeName} to this window.`, 'Undo', 'Another one');
    if (choice === 'Undo') {
      if (previous && api.catalog.get(previous.themeId)) await call('/api/apply', { workspaceUri: target, themeId: previous.themeId, scope: previous.scope });
      else await call('/api/remove', { workspaceUri: target });
      broadcast({ type: 'applied-changed' });
    } else if (choice === 'Another one') {
      await randomizeCommand();
    }
    return res;
  } catch (err) {
    vscode.window.showErrorMessage(`Window Themes: ${err.message}`);
  }
}

async function removeCommand() {
  const target = await currentTarget();
  if (!target) return;
  try {
    const res = await call('/api/remove', { workspaceUri: target });
    broadcast({ type: 'applied-changed' });
    vscode.window.showInformationMessage(res.changed || res.removed
      ? 'Removed the window theme; previous colors restored.'
      : 'This window has no theme from Window Themes.');
  } catch (err) {
    vscode.window.showErrorMessage(`Window Themes: ${err.message}`);
  }
}

async function refreshCommand() {
  const api = await getApi();
  const job = api.catalog.refresh();
  broadcast({ type: 'catalog-changed' });
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Window Themes: updating the theme catalog' },
    () => job,
  );
  const s = api.catalog.status();
  broadcast({ type: 'catalog-changed' });
  if (s.state === 'done') vscode.window.showInformationMessage(`Theme catalog updated: ${s.themeCount} themes.`);
  else vscode.window.showErrorMessage(`Window Themes: ${s.errors[0] || 'refresh failed'}`);
}

async function discoverCommand() {
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  // The view may still be loading; ask twice.
  broadcast({ type: 'show-tab', tab: 'discover' });
  setTimeout(() => broadcast({ type: 'show-tab', tab: 'discover' }), 800);
}

// ---------------------------------------------------------------------------

export function activate(context) {
  ctx = context;
  output = vscode.window.createOutputChannel('Window Themes');
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, new PickerViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('windowThemes.openInEditor', openInEditor),
    vscode.commands.registerCommand('windowThemes.randomize', randomizeCommand),
    vscode.commands.registerCommand('windowThemes.remove', removeCommand),
    vscode.commands.registerCommand('windowThemes.refresh', refreshCommand),
    vscode.commands.registerCommand('windowThemes.discover', discoverCommand),
    vscode.workspace.onDidChangeWorkspaceFolders(() => broadcast({ type: 'workspace-changed' })),
  );
  log(`Activated in ${vscode.env.appName} ${vscode.version}`);
}

export function deactivate() {}
