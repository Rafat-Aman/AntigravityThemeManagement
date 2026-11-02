// Fallback served at /preload.js only when Antigravity's own sidecar SDK
// preload cannot be found (e.g. running `npm start` outside Antigravity).
// Implements the same `window.sidecar` surface the platform preload provides.
(function () {
  if (window.sidecar) return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const conversationId = params.get('conversationId');

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'theme-change') {
      const vars = (event.data.payload && event.data.payload.cssVariables) || {};
      for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
    }
  });

  function secureFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Sidecar-Token', token);
    return fetch(url, { ...options, headers });
  }

  async function post(path, body) {
    const res = await secureFetch(path, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  window.sidecar = {
    conversationId,
    fetch: secureFetch,
    agent: {
      sendMessage: (message, convId) => post('/_sidecar/send-message', { conversationId: convId || conversationId, message }),
      startConversation: (message) => post('/_sidecar/new-conversation', { message }),
      getConversationMetadata: (id) => post('/_sidecar/get-conversation-metadata', { conversationId: id }),
    },
    ui: {
      toggleAuxPane: (request) => window.parent.postMessage({ type: 'toggle-aux-pane', payload: request }, '*'),
      toggleConversation: (id) => window.parent.postMessage({ type: 'toggle-conversation', payload: { conversationId: id } }, '*'),
    },
  };
})();
