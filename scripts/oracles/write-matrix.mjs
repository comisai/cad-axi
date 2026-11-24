#!/usr/bin/env node
// The write matrix with independent readers (design §12, implementation plan
// T42): the built CLI writes the sample at every version it offers, as DWG
// and as DXF, through `create`, `convert` and `edit`. LibreDWG's dwgread
// reads every DWG and ezdxf every DXF; each must find every entity kind the
// engine wrote, with the same counts. LibreDWG and ezdxf run in CI only.
//
//   node scripts/oracles/write-matrix.mjs --cli <dist/bin/cad-axi.js>
//     --libredwg <bin dir> --python <python with ezdxf> --work <dir>
//     --report <file.json>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decode } from '@toon-format/toon';
import { blockQueryDxf, overlaySpec } from '../../test/fixtures/block-query.ts';
import {
  minimalEditDxf,
  resizeLineOps,
  structuredEditDxf,
} from '../../test/fixtures/edit-guard.ts';

const { values: v } = parseArgs({
  options: {
    cli: { type: 'string' },
    libredwg: { type: 'string' },
    python: { type: 'string' },
    work: { type: 'string' },
    report: { type: 'string' },
  },
});
const work = resolve(v.work);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const gates = [];
const gate = (name, ok, detail) =>
  gates.push({ name, ok: Boolean(ok), detail });
const sh = (cmd, args, cwd = work) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    timeout: 300_000,
  });
const cli = (...args) => sh(process.execPath, [resolve(v.cli), ...args]);
const here = new URL('.', import.meta.url).pathname;

// Every kind the grammar writes, in a model space and a block.
const spec = {
  units: 'mm',
  codepage: 'ANSI_1255',
  time: '2026-01-01T00:00:00Z',
  layers: [
    { name: 'SAN', color: 3 },
    { name: 'NOTES', color: 7 },
  ],
  blocks: [
    {
      name: 'TAG',
      entities: [
        { kind: 'circle', center: [0, 0], radius: 100 },
        {
          kind: 'attdef',
          tag: 'NO',
          prompt: 'No',
          value: '',
          at: [150, 0],
          height: 50,
        },
      ],
    },
  ],
  entities: [
    { kind: 'line', layer: 'SAN', from: [0, 0], to: [1000, 0] },
    {
      kind: 'polyline',
      layer: 'SAN',
      pts: [
        [1000, 0],
        [2000, 1000],
        [2000, 2000],
      ],
      bulges: [0.41421356, 0, 0],
    },
    { kind: 'circle', layer: 'SAN', center: [500, 500], radius: 50 },
    {
      kind: 'arc',
      layer: 'SAN',
      center: [0, 0],
      radius: 300,
      start: 0,
      end: 90,
    },
    { kind: 'point', layer: 'SAN', at: [10, 10] },
    {
      kind: 'text',
      layer: 'NOTES',
      at: [0, -200],
      height: 100,
      value: 'שלום 110',
    },
    {
      kind: 'mtext',
      layer: 'NOTES',
      at: [0, -400],
      height: 100,
      value: 'צנרת\nnext line',
    },
    {
      kind: 'insert',
      layer: 'SAN',
      block: 'TAG',
      at: [3000, 0],
      rotation: 30,
      attribs: { NO: '7' },
    },
  ],
};
writeFileSync(join(work, 'spec.json'), JSON.stringify(spec));
// The sample drawing, drawn by the test DXF writer.
const sample = sh(process.execPath, [
  '-e',
  `import(${JSON.stringify(join(here, '../../test/fixtures/sample.ts'))}).then((m) => require('node:fs').writeFileSync('sample.dxf', m.sampleDxf()))`,
]);
gate(
  'the sample drawing is written',
  sample.status === 0,
  sample.stderr.slice(-300),
);

const IGNORED = new Set([
  'ATTRIB',
  'SEQEND',
  'BLOCK',
  'ENDBLK',
  'VERTEX_2D',
  'VERTEX_3D',
  'VERTEX',
]);
const engineKinds = (file) => {
  const r = cli('info', file, '--full');
  const kinds = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^ {2}([A-Z0-9_]+),(\d+)$/.exec(line);
    if (m) kinds[m[1]] = Number(m[2]);
  }
  return { status: r.status, kinds, out: r.stdout.slice(0, 400) };
};
const libredwgKinds = (file) => {
  const out = `${file}.json`;
  const r = sh(join(v.libredwg, 'dwgread'), ['-O', 'JSON', '-o', out, file]);
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(join(work, out), 'utf8'));
  } catch {
    // The read failed; reported below.
  }
  const kinds = {};
  for (const o of doc?.OBJECTS ?? [])
    if (typeof o.entity === 'string' && !IGNORED.has(o.entity))
      kinds[o.entity] = (kinds[o.entity] ?? 0) + 1;
  return { status: r.status, kinds, err: r.stderr.slice(-200) };
};
const ezdxfKinds = (file) => {
  const r = sh(v.python, [join(here, 'read_dxf.py'), join(work, file)]);
  try {
    const doc = JSON.parse(r.stdout);
    return {
      status: r.status,
      kinds: doc.all_kinds ?? doc.kinds,
      audit: doc.audit_errors,
      layers: doc.layers,
    };
  } catch {
    return { status: r.status, kinds: {}, err: r.stderr.slice(-200) };
  }
};
const same = (a, b) => {
  const keys = new Set(
    [...Object.keys(a), ...Object.keys(b)].filter((k) => !IGNORED.has(k)),
  );
  const diff = {};
  for (const k of keys)
    if ((a[k] ?? 0) !== (b[k] ?? 0)) diff[k] = [a[k] ?? 0, b[k] ?? 0];
  return diff;
};

const rows = [];
for (const as of ['2018', '2013', '2010', '2004', '2000']) {
  for (const format of ['dwg', 'dxf']) {
    for (const [how, args] of [
      ['create', ['create', '--spec', 'spec.json']],
      ['convert', ['convert', 'sample.dxf']],
    ]) {
      const out = `${how}-${as}.${format}`;
      const w = cli(...args, '--out', out, '--as', as);
      const row = { how, as, format, write: w.status };
      if (w.status !== 0) {
        row.error = w.stdout.slice(0, 300);
        rows.push(row);
        gate(`${how} ${as} ${format}: written and checked`, false, row);
        continue;
      }
      const mine = engineKinds(out);
      const theirs = format === 'dwg' ? libredwgKinds(out) : ezdxfKinds(out);
      row.engine = mine.kinds;
      row.other = theirs.kinds;
      row.diff = same(mine.kinds, theirs.kinds);
      rows.push(row);
      gate(
        `${how} ${as} ${format}: ${format === 'dwg' ? 'LibreDWG' : 'ezdxf'} reads every entity`,
        Object.keys(row.diff).length === 0 &&
          Object.keys(mine.kinds).length > 0,
        row,
      );
    }
  }
}

for (const [name, fixture, kinds] of [
  ['minimal', minimalEditDxf(250), { LINE: 1 }],
  ['structured', structuredEditDxf(), { LINE: 1, CIRCLE: 1, POINT: 1 }],
]) {
  const file = `${name}.dxf`;
  const ops = `${name}.json`;
  writeFileSync(join(work, file), fixture);
  const query = cli('query', file, '--type', 'LINE');
  const handle = query.status === 0 && decode(query.stdout).entities?.[0]?.h;
  if (typeof handle !== 'string') {
    gate(`edit ${name}: the source line has a handle`, false, query.stdout);
    continue;
  }
  writeFileSync(join(work, ops), JSON.stringify(resizeLineOps(handle)));
  for (const format of ['dwg', 'dxf']) {
    const out = `edit-${name}.${format}`;
    const write = cli('edit', file, '--ops', ops, '--out', out);
    const read =
      write.status === 0
        ? format === 'dwg'
          ? libredwgKinds(out)
          : ezdxfKinds(out)
        : { status: write.status, err: write.stdout };
    gate(
      `edit ${name} as ${format}: ${format === 'dwg' ? 'LibreDWG' : 'ezdxf'} reads every entity`,
      read.status === 0 && Object.keys(same(kinds, read.kinds)).length === 0,
      read,
    );
  }
}

writeFileSync(join(work, 'xref-host.dxf'), blockQueryDxf());
writeFileSync(join(work, 'overlay.json'), JSON.stringify(overlaySpec));
const overlay = cli(
  'create',
  '--like',
  'xref-host.dxf',
  '--spec',
  'overlay.json',
  '--out',
  'overlay.dxf',
);
const layerNames = ezdxfKinds('overlay.dxf').layers;
const reportedLayers =
  overlay.status === 0 ? decode(overlay.stdout).layers : null;
gate(
  'create --like: the reported layer count agrees with ezdxf',
  reportedLayers === layerNames?.length &&
    ['0', 'SYMBOLS', 'MARK'].every((name) => layerNames.includes(name)),
  { write: overlay.status, reportedLayers, layerNames },
);

writeFileSync(
  resolve(v.report),
  `${JSON.stringify({ gates, rows }, null, 1)}\n`,
);
const failed = gates.filter((g) => !g.ok);
console.log(
  `## Write matrix: ${gates.length - failed.length} of ${gates.length} gates pass\n`,
);
for (const g of gates) console.log(`- ${g.ok ? 'pass' : 'FAIL'} ${g.name}`);
if (failed.length) {
  for (const g of failed)
    console.log(`\n${g.name}\n${JSON.stringify(g.detail).slice(0, 800)}`);
  process.exit(1);
}
