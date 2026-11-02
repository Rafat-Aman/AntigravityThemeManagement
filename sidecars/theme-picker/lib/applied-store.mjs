// Remembers which theme was applied to which workspace, plus the exact values
// written, so they can be undone precisely. Stored in the data dir so the
// user's settings.json stays free of bookkeeping keys.
//
// Several processes can share the file (one extension host per IDE window), so
// callers reload() before reading and set() re-reads before writing.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AppliedStore {
  constructor(file) {
    this.file = file;
    this.records = {};
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') {
        this.records = parsed.records;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[wtm] could not read ${this.file}: ${err.message}`);
    }
  }

  reload() {
    return this.load();
  }

  get(workspacePath) {
    return this.records[workspacePath] || null;
  }

  all() {
    return Object.entries(this.records).map(([workspacePath, r]) => ({ workspacePath, ...r }));
  }

  async set(workspacePath, record) {
    await this.load(); // pick up records written by other windows
    if (record) this.records[workspacePath] = record;
    else delete this.records[workspacePath];
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, records: this.records }, null, 1));
    await rename(tmp, this.file);
  }
}
