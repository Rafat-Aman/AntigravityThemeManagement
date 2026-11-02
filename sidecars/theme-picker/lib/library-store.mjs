// The user's own theme sources (added from the Discover tab), stored as
// library.json in the data directory. Every operation re-reads the file, so
// several IDE windows (each with its own extension host) stay consistent.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class LibraryStore {
  constructor(file) {
    this.file = file;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(parsed?.sources) ? parsed.sources.filter((s) => s && typeof s.key === 'string') : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[wtm] could not read ${this.file}: ${err.message}`);
      return [];
    }
  }

  async #write(sources) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`);
    await rename(tmp, this.file);
  }

  async list() {
    return this.#read();
  }

  async keys() {
    return new Set((await this.#read()).map((s) => s.key));
  }

  /** Adds or replaces the record with the same key. */
  async add(record) {
    const sources = (await this.#read()).filter((s) => s.key !== record.key);
    sources.push(record);
    await this.#write(sources);
  }

  /** @returns {Promise<boolean>} whether a record was removed */
  async remove(key) {
    const sources = await this.#read();
    const next = sources.filter((s) => s.key !== key);
    if (next.length === sources.length) return false;
    await this.#write(next);
    return true;
  }
}
