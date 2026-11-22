#!/usr/bin/env node
// Puts both engines into the built package, under dist/engine/<platform>/
// with mode 0755, after `npm run build` has compiled the front end.
// Usage: node scripts/assemble-package.mjs <dir with linux-x64/ and linux-arm64/>
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const from = process.argv[2];
if (!from) throw new Error('usage: assemble-package.mjs <engine dir>');
if (!existsSync(join('dist', 'bin', 'cad-axi.js')))
  throw new Error('build the front end first: npm run build');
for (const rid of ['linux-x64', 'linux-arm64']) {
  const dir = join('dist', 'engine', rid);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'cad-axi-engine');
  copyFileSync(join(from, rid, 'cad-axi-engine'), target);
  chmodSync(target, 0o755);
}
console.log('assembled dist/engine/');
