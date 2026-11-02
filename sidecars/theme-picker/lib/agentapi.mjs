// Bridge to Antigravity's `agentapi` CLI, mirroring the official sidecar SDK
// so the platform's /preload.js (window.sidecar.agent.*) keeps working.

import { execFile } from 'node:child_process';

export function agentApiAvailable() {
  return !!(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN);
}

export function runAgentApi(args, { projectId } = {}) {
  const env = { ...process.env };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  // Prefer the language-server executable injected by the framework; it avoids
  // relying on the agentapi PATH shim.
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(file, execArgs, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch {
        reject(new Error(`agentapi returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

export const agentApi = {
  getConversationMetadata: (conversationId) => runAgentApi(['get-conversation-metadata', String(conversationId)]),
  sendMessage: (conversationId, message, { title, projectId } = {}) => {
    const args = ['send-message'];
    if (title) args.push('--title', String(title));
    args.push(String(conversationId), String(message));
    return runAgentApi(args, { projectId });
  },
  startConversation: (message, { model = 'flash', projectId } = {}) =>
    runAgentApi(['new-conversation', '--model', String(model || 'flash'), String(message)], { projectId }),
};
