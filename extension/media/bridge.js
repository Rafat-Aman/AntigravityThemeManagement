// Webview bridge for the editor extension. Loaded in place of Antigravity's
// sidecar /preload.js, it provides the same `window.sidecar` surface
// (fetch, conversationId, agent.*, ui.*) plus a native getWorkspaceUris(),
// so the panel code runs unchanged. API calls are sent to the extension host
// with postMessage instead of HTTP.
(function () {
  const vscode = acquireVsCodeApi();
  const pending = new Map();
  let seq = 0;

  const root = document.documentElement;
  root.dataset.host = 'vscode';
  root.dataset.location = (document.currentScript && document.currentScript.dataset.location) || 'sidebar';

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'response' && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(new Response(JSON.stringify(msg.body === undefined ? {} : msg.body), {
        status: msg.status || 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    } else if (msg.type === 'host-event' && msg.event) {
      window.dispatchEvent(new CustomEvent('wtm-host', { detail: msg.event }));
    }
  });

  function request(method, path, body) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The Window Themes extension did not respond.'));
      }, 120000);
      pending.set(id, { resolve, timer });
      vscode.postMessage({ type: 'request', id, method, path, body });
    });
  }

  /** fetch()-compatible: only same-origin API paths are supported. */
  function sidecarFetch(url, options) {
    const opts = options || {};
    const u = new URL(String(url), 'https://window-themes.invalid/');
    const method = String(opts.method || 'GET').toUpperCase();
    let body = Object.fromEntries(u.searchParams);
    if (typeof opts.body === 'string' && opts.body) {
      try {
        body = JSON.parse(opts.body);
      } catch {
        return Promise.reject(new Error('Request body must be JSON'));
      }
    }
    return request(method, u.pathname, body);
  }

  async function getWorkspaceUris() {
    const res = await sidecarFetch('/api/host/window');
    const data = await res.json();
    return Array.isArray(data.uris) ? data.uris : [];
  }
  getWorkspaceUris.source = 'window';

  const unavailable = () => Promise.reject(new Error('Not available in the editor extension'));
  window.sidecar = {
    host: 'vscode',
    conversationId: null,
    fetch: sidecarFetch,
    getWorkspaceUris,
    agent: { sendMessage: unavailable, startConversation: unavailable, getConversationMetadata: unavailable },
    ui: { toggleAuxPane() {}, toggleConversation() {} },
  };
})();
