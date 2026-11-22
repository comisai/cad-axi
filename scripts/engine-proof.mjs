#!/usr/bin/env node
// The engine proof (implementation plan M2, T4 to T9). It runs the built
// engine on made-up drawings and on ACadSharp's own sample drawings, and
// writes a JSON report and a Markdown summary.
//
//   node scripts/engine-proof.mjs --engine <path> --work <dir> --report <file.json>
//
// It exits 1 when a gate fails. Measurements that answer an open question
// (Q5, Q6, Q8) are recorded, not gated.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    engine: { type: 'string' },
    work: { type: 'string' },
    report: { type: 'string' },
    samples: { type: 'string' },
    quick: { type: 'boolean', default: false },
  },
});
const engine = resolve(values.engine);
const work = resolve(values.work);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'out'), { recursive: true });

const gates = [];
const report = {
  engine,
  platform: `${process.platform}-${process.arch}`,
  gates,
  measures: {},
};
const gate = (name, ok, detail) =>
  gates.push({ name, ok: Boolean(ok), detail });

// Runs the engine once and returns its records, exit status and time.
function run(args, env = {}, timeout = 600_000) {
  const t0 = performance.now();
  const r = spawnSync(engine, args, {
    env: { PATH: process.env.PATH, ...env },
    timeout,
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  });
  const ms = performance.now() - t0;
  const records = (r.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: 'garbage', line: l.slice(0, 80) };
      }
    });
  return {
    status: r.status,
    signal: r.signal,
    ms,
    records,
    stderr: (r.stderr || '').slice(0, 400),
  };
}
const last = (r) => r.records.at(-1) ?? {};
const writeSpec = (name, spec) => {
  const path = join(work, `${name}.json`);
  writeFileSync(path, JSON.stringify(spec));
  return path;
};
const sha = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

// T4: the binary runs, how big it is, how fast it starts.
const probe = run(['probe']);
const p = last(probe);
gate('probe runs', probe.status === 0 && p.type === 'probe', p);
report.measures.binary_bytes = statSync(engine).size;
report.measures.probe = p;
const starts = [];
for (let i = 0; i < 20; i++) starts.push(run(['probe']).ms);
starts.sort((a, b) => a - b);
report.measures.start_ms = {
  min: +starts[0].toFixed(1),
  median: +starts[10].toFixed(1),
  max: +starts[19].toFixed(1),
};

// T5 and T8: a known drawing at every version, as DWG and as DXF, read back.
// Hebrew is written as Unicode; pre-2007 files carry it in code page 1255.
const HEB_TEXT = '\u05e9\u05dc\u05d5\u05dd %%c110';
const HEB_MTEXT = '\u05e6\u05e0\u05e8\u05ea \u05d1\u05d9\u05d5\u05d1';
const known = (version) => ({
  version,
  codepage: 'ANSI_1255',
  units: 'mm',
  time: '2026-01-01T00:00:00Z',
  layers: [
    { name: 'SAN', color: 3 },
    { name: 'NOTES', color: 7 },
  ],
  entities: [
    { kind: 'line', layer: 'SAN', from: [0, 0], to: [1000, 0] },
    {
      kind: 'polyline',
      layer: 'SAN',
      pts: [
        [0, 0],
        [1000, 0],
        [1000, 500],
      ],
      bulges: [0, 0.4142, 0],
    },
    { kind: 'circle', layer: 'SAN', center: [500, 500], radius: 50 },
    {
      kind: 'text',
      layer: 'NOTES',
      at: [0, -200],
      height: 100,
      value: HEB_TEXT,
    },
    {
      kind: 'mtext',
      layer: 'NOTES',
      at: [0, -400],
      height: 100,
      value: HEB_MTEXT,
    },
  ],
});
const versions = [
  'AC1014',
  'AC1015',
  'AC1018',
  'AC1021',
  'AC1024',
  'AC1027',
  'AC1032',
];
report.measures.round_trips = [];
for (const v of versions) {
  for (const ext of ['dwg', 'dxf']) {
    const out = join(work, 'out', `known-${v}.${ext}`);
    const w = run([
      'write',
      '--spec',
      writeSpec(`known-${v}`, known(v)),
      '--out',
      out,
    ]);
    const row = {
      version: v,
      format: ext,
      write: last(w).type === 'end' ? 'ok' : last(w).code,
    };
    if (row.write === 'ok') {
      const r = run(['read', out, '--entities']);
      const ents = r.records.filter(
        (x) => x.type === 'entity' && x.owner === '*Model_Space',
      );
      const by = (k) => ents.filter((e) => e.kind === k);
      const text = by('TEXT')[0]?.raw;
      const mtext = by('MTEXT')[0]?.raw;
      const line = by('LINE')[0];
      const poly = by('LWPOLYLINE')[0];
      row.read = last(r).type === 'end' ? 'ok' : last(r).code;
      row.kinds = ['LINE', 'LWPOLYLINE', 'CIRCLE', 'TEXT', 'MTEXT'].every(
        (k) => by(k).length === 1,
      );
      row.geometry =
        JSON.stringify(line?.b) === '[1000,0,0]' &&
        JSON.stringify(poly?.bulges) === '[0,0.4142,0]';
      row.hebrew = text === HEB_TEXT && mtext === HEB_MTEXT;
      row.codepage = r.records.find((x) => x.type === 'header')?.codepage;
      row.ok = row.read === 'ok' && row.kinds && row.geometry && row.hebrew;
    }
    report.measures.round_trips.push(row);
  }
}
for (const row of report.measures.round_trips) {
  // AC1021 DWG writing is not in ACadSharp 3.8.35: it must refuse, not fail.
  // ACadSharp 3.8.35's R14 writer drops entities; cad-axi never offers R14
  // output, so this row is recorded, not gated.
  if (row.version === 'AC1014' && row.format === 'dwg') {
    report.measures.ac1014_dwg_write = row;
    continue;
  }
  if (row.version === 'AC1021' && row.format === 'dwg')
    gate('AC1021 DWG write refused cleanly', row.write === 'unsupported', row);
  else gate(`round trip ${row.version} ${row.format}`, row.ok, row);
}

// A character outside code page 1255 in a pre-2007 file: recorded, not gated.
{
  const out = join(work, 'out', 'outside-codepage.dwg');
  run([
    'write',
    '--spec',
    writeSpec('outside', {
      version: 'AC1015',
      codepage: 'ANSI_1255',
      units: 'mm',
      entities: [
        { kind: 'text', at: [0, 0], height: 1, value: '\u00d8110 \u05e9' },
      ],
    }),
    '--out',
    out,
  ]);
  const r = run(['read', out, '--entities']);
  report.measures.outside_codepage = {
    wrote: '\u00d8110 \u05e9',
    read: r.records.find((x) => x.kind === 'TEXT')?.raw,
  };
}

// T7 (Q5): two writes of one specification.
report.measures.repeatable = {};
for (const v of ['AC1015', 'AC1032']) {
  for (const ext of ['dwg', 'dxf']) {
    const a = join(work, 'out', `rep-a-${v}.${ext}`);
    const b = join(work, 'out', `rep-b-${v}.${ext}`);
    const spec = writeSpec(`rep-${v}`, known(v));
    run(['write', '--spec', spec, '--out', a]);
    run(['write', '--spec', spec, '--out', b]);
    const ba = readFileSync(a);
    const bb = readFileSync(b);
    const diffs = [];
    for (let i = 0; i < Math.min(ba.length, bb.length); i++)
      if (ba[i] !== bb[i]) diffs.push(i);
    report.measures.repeatable[`${v}.${ext}`] = {
      same: sha(a) === sha(b),
      bytes: [ba.length, bb.length],
      differing_bytes: diffs.length,
      first_offsets: diffs.slice(0, 6),
    };
  }
}

// T6: limits. The input cap, the time limit and the heap limit.
const stressSpec = (n) => ({
  version: 'AC1032',
  units: 'mm',
  stress: { lines: n },
});
const stress200k = join(work, 'out', 'stress-200k.dwg');
run([
  'write',
  '--spec',
  writeSpec('stress-200k', stressSpec(200_000)),
  '--out',
  stress200k,
]);
{
  const cap = run(['read', stress200k, '--max-bytes', '1000']);
  gate(
    'input cap refuses',
    cap.status === 1 && last(cap).code === 'too_large',
    last(cap),
  );
  const slow = run(['read', stress200k, '--time-limit-ms', '20']);
  gate(
    'time limit stops a read',
    slow.status === 1 && last(slow).code === 'timed_out' && slow.ms < 5000,
    { code: last(slow).code, ms: Math.round(slow.ms) },
  );
  const env = { DOTNET_GCHeapHardLimit: '3000000' };
  const limited = last(run(['probe'], env));
  const heap = run(['read', stress200k], env);
  report.measures.heap_limit = {
    probe_reports: limited.heap_limit,
    read: {
      status: heap.status,
      signal: heap.signal,
      last: last(heap),
      ms: Math.round(heap.ms),
    },
  };
  gate(
    'heap limit is read from the environment',
    limited.heap_limit > 0 && limited.heap_limit <= 0x3000000,
    limited,
  );
  gate(
    'heap limit ends in a closed error, not a kill',
    heap.signal === null &&
      heap.status === 1 &&
      last(heap).code === 'too_large',
    report.measures.heap_limit.read,
  );
}

// Q8: time and memory on large drawings.
report.measures.scale = [];
for (const n of values.quick ? [100_000] : [100_000, 300_000, 1_000_000]) {
  const out = join(work, 'out', `scale-${n}.dwg`);
  const w = run([
    'write',
    '--spec',
    writeSpec(`scale-${n}`, stressSpec(n)),
    '--out',
    out,
  ]);
  const r = run(['read', out]);
  report.measures.scale.push({
    lines: n,
    entities: last(r).entities,
    dwg_bytes: existsSync(out) ? statSync(out).size : null,
    write_ms: last(w).ms,
    write_peak_mb: last(w).peak_rss
      ? Math.round(last(w).peak_rss / 2 ** 20)
      : null,
    read_ms: last(r).ms,
    read_wall_ms: Math.round(r.ms),
    read_peak_mb: last(r).peak_rss
      ? Math.round(last(r).peak_rss / 2 ** 20)
      : null,
  });
  if (n !== 1_000_000) rmSync(out, { force: true });
}

// T5: ACadSharp's own sample drawings.
report.measures.samples = [];
if (values.samples) {
  for (const file of JSON.parse(
    readFileSync(join(values.samples, 'samples.json'), 'utf8'),
  ).files) {
    const path = join(values.samples, file.name);
    const r = run(['read', path]);
    const end = last(r);
    const row = {
      name: file.name,
      result: end.type === 'end' ? 'ok' : end.code,
      entities: end.entities,
      unknown: end.unknown,
      errors: end.errors,
      ms: end.ms,
      peak_mb: end.peak_rss ? Math.round(end.peak_rss / 2 ** 20) : null,
    };
    report.measures.samples.push(row);
    gate(
      `sample ${file.name} reads`,
      row.result === 'ok' && row.entities > 0,
      row,
    );
  }
}

// Every damaged file ends in a closed error within the limits (M2 gate).
const closed = new Set([
  'not_cad',
  'damaged',
  'unsupported',
  'too_large',
  'timed_out',
  'encrypted',
]);
report.measures.hostile = [];
{
  const base = readFileSync(join(work, 'out', 'known-AC1032.dwg'));
  const big = values.samples
    ? readFileSync(join(values.samples, 'sample_AC1032.dwg'))
    : base;
  let seed = 20261122;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const cases = [];
  for (const cut of [16, 128, 1024, base.length >> 1])
    cases.push([`truncated-${cut}`, base.subarray(0, cut)]);
  for (let k = 0; k < 12; k++) {
    const b = Buffer.from(k < 6 ? base : big);
    const flips = Math.max(
      1,
      Math.floor(b.length * (k % 3 === 0 ? 0.0005 : 0.01)),
    );
    for (let i = 0; i < flips; i++)
      b[128 + Math.floor(rand() * (b.length - 128))] ^=
        1 << Math.floor(rand() * 8);
    cases.push([`flipped-${k}`, b]);
  }
  cases.push([
    'magic-only',
    Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(4096)]),
  ]);
  cases.push([
    'magic-random',
    Buffer.concat([
      Buffer.from('AC1018'),
      Buffer.from(
        Array.from({ length: 65536 }, () => Math.floor(rand() * 256)),
      ),
    ]),
  ]);
  cases.push([
    'old-version',
    Buffer.concat([Buffer.from('AC1012'), Buffer.alloc(1024)]),
  ]);
  cases.push(['empty', Buffer.alloc(0)]);
  cases.push([
    'dxf-garbage',
    Buffer.from('  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n 10\nnot-a-number\n'),
  ]);
  for (const [name, bytes] of cases) {
    const path = join(work, `hostile-${name}.bin`);
    writeFileSync(path, bytes);
    const r = run(
      ['read', path, '--time-limit-ms', '10000'],
      { DOTNET_GCHeapHardLimit: '20000000' },
      30_000,
    );
    const end = last(r);
    const row = {
      name,
      status: r.status,
      signal: r.signal,
      code: end.code ?? end.type,
      ms: Math.round(r.ms),
    };
    report.measures.hostile.push(row);
    const fine =
      r.signal === null &&
      ((r.status === 1 && closed.has(end.code)) ||
        (r.status === 0 && end.type === 'end'));
    gate(`hostile ${name}`, fine, row);
  }
}

// Report.
writeFileSync(resolve(values.report), JSON.stringify(report, null, 2));
const failed = gates.filter((g) => !g.ok);
const m = report.measures;
const lines = [
  `## Engine proof on ${report.platform}`,
  '',
  `- Engine ${m.probe.engine}, ACadSharp ${m.probe.acadsharp}, protocol ${m.probe.protocol}, ${m.probe.platform}`,
  `- Binary ${(m.binary_bytes / 2 ** 20).toFixed(1)} MiB; start ${m.start_ms.median} ms median (${m.start_ms.min} to ${m.start_ms.max})`,
  `- Gates: ${gates.length - failed.length} of ${gates.length} pass`,
  ...failed.map(
    (g) => `  - FAIL ${g.name}: ${JSON.stringify(g.detail).slice(0, 300)}`,
  ),
  `- Repeatable writes: ${Object.entries(m.repeatable)
    .map(
      ([k, v]) =>
        `${k} ${v.same ? 'same' : `${v.differing_bytes} bytes differ`}`,
    )
    .join('; ')}`,
  `- AC1014 DWG write (recorded): ${JSON.stringify(m.ac1014_dwg_write)}`,
  `- Outside code page 1255 in AC1015: wrote ${JSON.stringify(m.outside_codepage.wrote)}, read ${JSON.stringify(m.outside_codepage.read)}`,
  `- Heap limit 48 MiB: probe reports ${m.heap_limit.probe_reports}; a 200k-line read ends ${JSON.stringify(m.heap_limit.read.last)} (signal ${m.heap_limit.read.signal})`,
  '',
  '| Lines | Entities | DWG MiB | Write ms | Write peak MiB | Read ms | Read peak MiB |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...m.scale.map(
    (s) =>
      `| ${s.lines} | ${s.entities} | ${(s.dwg_bytes / 2 ** 20).toFixed(1)} | ${s.write_ms} | ${s.write_peak_mb} | ${s.read_ms} | ${s.read_peak_mb} |`,
  ),
  '',
  ...(m.samples.length
    ? [
        '| Sample | Result | Entities | Unknown | Errors | ms | Peak MiB |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...m.samples.map(
          (s) =>
            `| ${s.name} | ${s.result} | ${s.entities} | ${s.unknown} | ${s.errors} | ${s.ms} | ${s.peak_mb} |`,
        ),
        '',
      ]
    : []),
];
console.log(lines.join('\n'));
process.exit(failed.length ? 1 : 0);
