#!/usr/bin/env node
// Downloads ACadSharp's MIT sample drawings at a pinned commit and checks
// each against its recorded SHA-256. Usage: node scripts/fetch-samples.mjs <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: fetch-samples.mjs <dir>');
const list = JSON.parse(readFileSync(new URL('../test/fixtures/third-party/acadsharp-samples.json', import.meta.url), 'utf8'));
mkdirSync(dir, { recursive: true });
for (const f of list.files) {
  const url = `https://raw.githubusercontent.com/DomCR/ACadSharp/${list.commit}/samples/${f.name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${f.name} ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== f.sha256) throw new Error(`hash mismatch: ${f.name}`);
  writeFileSync(join(dir, f.name), bytes);
}
writeFileSync(join(dir, 'samples.json'), JSON.stringify(list, null, 2));
console.log(`${list.files.length} samples checked`);
