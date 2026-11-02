#!/usr/bin/env node
// Window Theme Manager: Antigravity sidecar backend.
//
// Runs as a sidecar process (see sidecar.json). It follows the same contract
// as Antigravity's bundled `sidecar_sdk`:
//   * listens on ANTIGRAVITY_SIDECAR_WEB_PORT,
//   * serves the platform's /preload.js (which defines window.sidecar),
//   * requires the X-Sidecar-Token header (ANTIGRAVITY_SIDECAR_UI_TOKEN) on APIs,
//   * proxies /_sidecar/* calls to the `agentapi` CLI.
// It is implemented directly on node:http (instead of the SDK's SidecarApp)
// because the SDK only supports synchronous handlers and this sidecar needs
// async network + file I/O.
//
// Outside Antigravity, `npm start` runs it on http://localhost:4870 for development.

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi, HttpError } from './lib/api.mjs';
import { agentApi, agentApiAvailable } from './lib/agentapi.mjs';
import { locatePreload } from './lib/sdk-preload.mjs';

const SIDECAR_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(SIDECAR_DIR, 'public');
const IN_SIDECAR = !!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 4870);
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(SIDECAR_DIR, '.data');
// Inside Antigravity the token comes from the sidecar manager. Standalone, a
// persistent random token is used so other local web pages can't call the API.
let TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const SEED_FILE = join(SIDECAR_DIR, '.cache', 'themes.json'); // written by `npm run fetch-themes`

const log = (msg) => console.log(`${new Date().toISOString()} [wtm] ${msg}`);
const preload = locatePreload(join(PUBLIC_DIR, 'preload-fallback.js'));

const requireAgentApi = () => {
  if (!agentApiAvailable()) throw new HttpError(503, 'agentapi is only available inside Antigravity');
};

const api = createApi({
  dataDir: DATA_DIR,
  seedFile: SEED_FILE,
  log,
  extraRoutes: {
    'GET /api/health': async () => ({ ok: true, inSidecar: IN_SIDECAR, officialPreload: preload.official, themes: api.catalog.size }),
    // --- Same endpoints as Antigravity's sidecar SDK (used by /preload.js) ---
    'POST /_sidecar/get-conversation-metadata': async (body) => {
      requireAgentApi();
      return agentApi.getConversationMetadata(body.conversationId);
    },
    'POST /_sidecar/send-message': async (body) => {
      requireAgentApi();
      return agentApi.sendMessage(body.conversationId, body.message, { title: body.title, projectId: body.projectId });
    },
    'POST /_sidecar/new-conversation': async (body) => {
      requireAgentApi();
      return agentApi.startConversation(body.message, { model: body.model, projectId: body.projectId });
    },
  },
});

// ---------------------------------------------------------------------------
// HTTP helpers

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/workspace.js', 'workspace.js'],
  ['/styles.css', 'styles.css'],
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function standaloneToken() {
  const file = join(DATA_DIR, 'standalone-token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch { /* create below */ }
  const token = randomBytes(16).toString('hex');
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function tokenOk(req, url) {
  if (!TOKEN) return true; // only when WTM_INSECURE_NO_TOKEN=1
  const provided = String(req.headers['x-sidecar-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

// ---------------------------------------------------------------------------
// Server

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/preload.js') {
    return send(res, 200, await readFile(preload.file), MIME['.js']);
  }
  if (req.method === 'GET' && STATIC_FILES.has(path)) {
    const file = join(PUBLIC_DIR, STATIC_FILES.get(path));
    return send(res, 200, await readFile(file), MIME[extname(file)]);
  }
  if (req.method === 'GET' && path === '/favicon.ico') return send(res, 204, '');

  if (!path.startsWith('/api/') && !path.startsWith('/_sidecar/')) return send(res, 404, { error: 'Not found' });
  if (!tokenOk(req, url)) return send(res, 401, { error: 'unauthorized' });

  let body;
  try {
    body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
  } catch (err) {
    return send(res, err.status || 400, { error: err.message });
  }
  const result = await api.handle(req.method, path, body);
  return send(res, result.status, result.body);
}

async function main() {
  if (!IN_SIDECAR && !TOKEN && process.env.WTM_INSECURE_NO_TOKEN !== '1') TOKEN = await standaloneToken();
  await api.init();

  const onRequest = (req, res) => handle(req, res).catch((err) => {
    log(`Unhandled error: ${err.stack || err.message}`);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  });

  // Loopback only (both stacks, since "localhost" may resolve to ::1 first).
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const server = createServer(onRequest);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, host, resolve);
      });
      servers.push(server);
    } catch (err) {
      if (host === '127.0.0.1') throw err;
      log(`IPv6 loopback unavailable (${err.code}); continuing on 127.0.0.1 only`);
    }
  }
  log(`Listening on http://localhost:${PORT} (${IN_SIDECAR ? 'Antigravity sidecar' : 'standalone mode'}; `
    + `preload: ${preload.official ? `official ${preload.file}` : 'bundled fallback'}; data: ${DATA_DIR})`);
  if (!IN_SIDECAR) log(`Open the panel at: http://localhost:${PORT}/${TOKEN ? `?token=${TOKEN}` : ''}`);

  const shutdown = () => {
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
