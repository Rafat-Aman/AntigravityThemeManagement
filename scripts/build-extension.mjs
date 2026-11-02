#!/usr/bin/env node
// Bundles the editor extension (extension/src/extension.mjs + the shared
// sidecar libraries + jsonc-parser) into one CommonJS file, so the .vsix needs
// no node_modules.
//
//   node scripts/build-extension.mjs [--watch]

import { build, context } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  entryPoints: [join(root, 'extension', 'src', 'extension.mjs')],
  outfile: join(root, 'extension', 'dist', 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // jsonc-parser's "main" is a UMD build with dynamic require()s; use its ESM build.
  mainFields: ['module', 'main'],
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
