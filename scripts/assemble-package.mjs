#!/usr/bin/env node
// Assembles the package for the engine proof (implementation plan T9): the
// two engines under dist/engine/<platform>/ with mode 0755, and a stub CLI
// that runs the engine's probe. The real CLI replaces the stub in M3.
// Usage: node scripts/assemble-package.mjs <dir with linux-x64/ and linux-arm64/>
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const from = process.argv[2];
if (!from) throw new Error('usage: assemble-package.mjs <engine dir>');
rmSync('dist', { recursive: true, force: true });
for (const rid of ['linux-x64', 'linux-arm64']) {
  const dir = join('dist', 'engine', rid);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'cad-axi-engine');
  copyFileSync(join(from, rid, 'cad-axi-engine'), target);
  chmodSync(target, 0o755);
}
mkdirSync(join('dist', 'bin'), { recursive: true });
const stub = `#!/usr/bin/env node
// Engine-proof stub: runs the bundled engine's probe. The real CLI replaces it.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rid = { 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' }[\`\${process.platform}-\${process.arch}\`];
if (!rid) {
  process.stdout.write('message: There is no engine for this platform.\\ncode: unsupported_platform\\n');
  process.exit(1);
}
const engine = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', rid, 'cad-axi-engine');
const r = spawnSync(engine, ['probe'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;
writeFileSync(join('dist', 'bin', 'cad-axi.js'), stub, { mode: 0o755 });
console.log('assembled dist/');
