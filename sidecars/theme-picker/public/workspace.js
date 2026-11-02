// Adds `window.sidecar.getWorkspaceUris()`.
//
// Antigravity's sidecar preload (as of IDE 1.107 / language server 2.5) exposes
// conversationId, fetch, agent.* and ui.*, but no workspace accessor. This
// polyfill derives the workspace for the window hosting this panel:
//   1. metadata of the active conversation (workspaceUris / workspaces[])
//   2. folders of the conversation's Antigravity project
//   3. the IDE's last active window (via the sidecar backend)
// If a future Antigravity build ships a native getWorkspaceUris, it is used as-is.
(function () {
  const sc = window.sidecar;
  if (!sc) {
    console.error('[window-theme-manager] window.sidecar is missing; is /preload.js loaded?');
    return;
  }
  if (typeof sc.getWorkspaceUris === 'function') {
    sc.getWorkspaceUris.source = sc.getWorkspaceUris.source || 'native';
    return;
  }

  function readMetadata(data) {
    const r = (data && (data.response || data)) || {};
    const event = r.conversationMetadata || r.conversation_metadata || {};
    const meta = event.metadata || {};
    const uris = [].concat(meta.workspaceUris || meta.workspace_uris || []);
    for (const w of meta.workspaces || []) {
      const u = w.workspaceFolderAbsoluteUri || w.workspace_folder_absolute_uri;
      if (u) uris.push(u);
    }
    return { uris: [...new Set(uris.filter(Boolean))], projectId: meta.projectId || meta.project_id || '' };
  }

  async function postJson(path, body) {
    const res = await sc.fetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  async function getWorkspaceUris() {
    let projectId = '';
    if (sc.conversationId && sc.agent && sc.agent.getConversationMetadata) {
      try {
        const meta = readMetadata(await sc.agent.getConversationMetadata(sc.conversationId));
        projectId = meta.projectId;
        if (meta.uris.length) {
          getWorkspaceUris.source = 'conversation';
          getWorkspaceUris.projectId = projectId;
          return meta.uris;
        }
      } catch (err) {
        console.warn('[window-theme-manager] conversation metadata unavailable:', err.message || err);
      }
    }
    getWorkspaceUris.projectId = projectId;
    if (projectId) {
      const { folders } = await postJson('/api/project-folders', { projectId });
      if (folders.length) {
        getWorkspaceUris.source = 'project';
        return folders;
      }
    }
    const { candidates } = await postJson('/api/workspaces', {});
    const ide = candidates.find((c) => c.sources.includes('ide-last-active')) || candidates.find((c) => c.sources.includes('project'));
    getWorkspaceUris.source = ide ? (ide.sources.includes('project') ? 'project' : 'ide-last-active') : 'none';
    return ide ? [ide.uri] : [];
  }

  getWorkspaceUris.polyfill = true;
  sc.getWorkspaceUris = getWorkspaceUris;
})();
