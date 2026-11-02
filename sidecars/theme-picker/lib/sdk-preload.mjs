// Locates the platform's official `preload.js` (shipped with the `sidecar_sdk`
// package that Antigravity installs and registers via a Node `--import`
// loader). Falls back to a compatible shim when running outside Antigravity
// (e.g. `npm start` for local development).

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function candidateDirs() {
  const dirs = [];
  try {
    // Works when Antigravity's ESM resolver for 'sidecar_sdk' is registered.
    dirs.push(dirname(fileURLToPath(import.meta.resolve('sidecar_sdk'))));
  } catch { /* not running under the sidecar manager */ }

  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS || '').split(/\s+/)].join(' ');
  for (const m of flags.matchAll(/(file:\/\/[^\s'"]+|(?:\/|[A-Za-z]:\\)[^\s'"]+?\.m?js)/g)) {
    try {
      const p = m[1].startsWith('file:') ? fileURLToPath(m[1]) : m[1];
      if (isAbsolute(p)) dirs.push(dirname(p));
    } catch { /* ignore */ }
  }

  for (const p of (process.env.NODE_PATH || '').split(/[:;]/).filter(Boolean)) dirs.push(join(p, 'sidecar_sdk'));
  return dirs;
}

/** @returns {{file: string, official: boolean}} */
export function locatePreload(fallbackFile) {
  for (const dir of candidateDirs()) {
    const file = join(dir, 'preload.js');
    if (existsSync(file)) return { file, official: true };
  }
  return { file: fallbackFile, official: false };
}
