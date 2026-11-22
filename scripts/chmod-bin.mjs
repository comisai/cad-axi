import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/bin/cad-axi.js', import.meta.url), 0o755);
