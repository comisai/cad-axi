#!/usr/bin/env node
// Checks what npm would publish: the expected files and no others, the CLI
// and both engines executable, a bounded size. Comis installs the package
// with --ignore-scripts and normalises modes, so the modes must be right in
// the tarball itself.
import { execFileSync } from 'node:child_process';

const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
  }),
);
const files = new Map(pack.files.map((f) => [f.path, f]));
const required = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  'dist/bin/cad-axi.js',
  'dist/engine/linux-x64/cad-axi-engine',
  'dist/engine/linux-arm64/cad-axi-engine',
];
const executable = required.filter((p) => p.startsWith('dist/'));
const problems = [];
for (const p of required) if (!files.has(p)) problems.push(`missing ${p}`);
for (const p of files.keys())
  if (!required.includes(p) && !/^dist\/(?!engine\/)[a-z/-]+\.js$/.test(p))
    problems.push(`unexpected ${p}`);
for (const p of executable) {
  const mode = files.get(p)?.mode;
  if (mode !== undefined && (mode & 0o111) !== 0o111)
    problems.push(`not executable: ${p} (${mode.toString(8)})`);
}
const limit = 30 * 2 ** 20;
if (pack.size > limit)
  problems.push(`tarball ${pack.size} bytes, over ${limit}`);
console.log(
  `tarball ${(pack.size / 2 ** 20).toFixed(1)} MiB packed, ${(pack.unpackedSize / 2 ** 20).toFixed(1)} MiB unpacked, ${pack.files.length} files`,
);
for (const f of pack.files.filter((x) => executable.includes(x.path)))
  console.log(
    `  ${f.mode.toString(8)} ${String(f.size).padStart(10)} ${f.path}`,
  );
if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exit(1);
}
