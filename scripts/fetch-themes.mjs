#!/usr/bin/env node
// Downloads the theme catalog into sidecars/theme-picker/.cache/themes.json.
// The sidecar uses that file as a seed, so the picker works offline right
// after installation (it then keeps its own cache in the sidecar data dir).
//
//   node scripts/fetch-themes.mjs [output.json]

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ThemeCatalog } from '../sidecars/theme-picker/lib/theme-fetcher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'sidecars', 'theme-picker', '.cache', 'themes.json'));

const catalog = new ThemeCatalog({ cacheFile: out, log: (m) => console.log(m) });
await catalog.load();

const started = Date.now();
const promise = catalog.refresh();
const ticker = setInterval(() => {
  const s = catalog.status();
  process.stdout.write(`\r  ${s.done}/${s.total} sources…`);
}, 500);
await promise;
clearInterval(ticker);
process.stdout.write('\r');

const status = catalog.status();
for (const src of status.sources || []) {
  const mark = src.ok ? 'ok  ' : src.stale ? 'old ' : 'FAIL';
  console.log(`  ${mark} ${src.label.padEnd(28)} ${String(src.themes).padStart(2)} themes${src.error ? `  (${src.error})` : ''}`);
}
for (const e of status.errors) console.log(`  warn: ${e}`);
console.log(`\n${status.themeCount} themes cached to ${out} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(status.state === 'done' ? 0 : 1);
