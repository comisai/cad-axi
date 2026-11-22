#!/usr/bin/env node
// The live test (design §12): the built CLI on real drawings that a private
// plan names. Neither the drawings nor the plan enter the repository. It
// prints a summary of stages L1 to L7 and L9 per file, and writes a report
// to test/live/reports/, mode 0600, naming files by position and holding
// layer names and numbers, never drawings. L8 is the owner opening edited
// copies in their CAD program.
//
//   npm run build && npm run live -- --plan <plan.json> [--out <private dir>]
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { decode } from '@toon-format/toon';

const { values } = parseArgs({
  options: {
    plan: { type: 'string' },
    out: { type: 'string' },
    bin: { type: 'string' },
  },
});
if (!values.plan) throw new Error('usage: cad-live.mjs --plan <plan.json>');
const bin =
  values.bin ?? new URL('../../dist/bin/cad-axi.js', import.meta.url).pathname;
const plan = JSON.parse(readFileSync(values.plan, 'utf8'));
const out = values.out ?? mkdtempSync(join(tmpdir(), 'cad-live-'));
mkdirSync(out, { recursive: true });

const cli = (args, cwd) => {
  const start = Date.now();
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 300_000,
  });
  let doc = {};
  try {
    doc = decode(r.stdout);
  } catch {
    doc = { code: 'not_toon' };
  }
  return { code: r.status, doc, ms: Date.now() - start };
};
const rows = (doc, key) => (Array.isArray(doc[key]) ? doc[key] : []);

const report = { at: new Date().toISOString(), files: [] };
plan.files.forEach((file, index) => {
  const r = { file: index + 1, stages: {} };
  const where = dirname(file.path);
  const before = new Set(readdirSync(where));
  const unit = file.units ? ['--units', file.units] : [];
  const region = file.region ? ['--region', file.region] : [];
  const info = cli(['info', file.path, '--full'], out);
  r.stages.L1 =
    info.code === 0 && info.ms < 15_000
      ? 'pass'
      : `fail: ${info.doc.code ?? info.code} in ${info.ms} ms`;
  r.version = info.doc.version;
  r.ms = info.ms;
  r.editable = info.doc.editable;
  r.vertical = info.doc.vertical_products ? 'present' : null;
  r.stages.L2 = info.doc.units ? 'pass' : 'fail';
  r.units = info.doc.units;
  const layers = rows(
    cli(['layers', file.path, '--full', ...unit], out).doc,
    'layers',
  );
  const found = new Map(layers.map((l) => [l.name, l]));
  const missing = (file.layers ?? []).filter((l) => !found.get(l)?.entities);
  r.stages.L3 = missing.length
    ? `fail: ${missing.length} expected layers missing or empty`
    : 'pass';
  const texts = rows(
    cli(['texts', file.path, '--full', '--space', 'all'], out).doc,
    'texts',
  ).map((t) => String(t.text));
  const absent = (file.texts ?? []).filter(
    (t) => !texts.some((x) => x.includes(t)),
  );
  r.stages.L4 = absent.length
    ? `fail: ${absent.length} expected texts not found`
    : 'pass';
  r.groups = [];
  for (const g of file.groups ?? []) {
    const m = cli(
      [
        'measure',
        file.path,
        '--group',
        `${g.name}=${g.layers.join('+')}`,
        ...unit,
        ...region,
      ],
      out,
    );
    const got =
      rows(m.doc, 'groups').find((x) => x.group === g.name)?.length ?? null;
    const off =
      got === null || !g.reference_m
        ? null
        : Math.abs(got - g.reference_m) / g.reference_m;
    r.groups.push({
      name: g.name,
      measured_m: got,
      reference_m: g.reference_m,
      off: off === null ? null : Math.round(off * 1000) / 10,
    });
  }
  r.stages.L5 = r.groups.every((g) => g.off !== null && g.off <= 10)
    ? 'pass'
    : 'fail';
  const sizes = cli(
    [
      'measure',
      file.path,
      '--by',
      'size',
      ...(file.layers ?? []).flatMap((l) => ['--layer', l]),
      ...unit,
      ...region,
    ],
    out,
  );
  r.sizes = rows(sizes.doc, 'sizes');
  r.stages.L6 =
    sizes.code === 0
      ? 'check by hand: sizes listed'
      : `fail: ${sizes.doc.code}`;
  r.edits = [];
  (file.edits ?? []).forEach((e, i) => {
    const target = join(out, `file-${index + 1}-edit-${i + 1}.dwg`);
    const w = cli(['edit', file.path, '--ops', e.ops, '--out', target], out);
    r.edits.push({
      result: w.code === 0 ? 'written' : w.doc.code,
      kept: w.doc.entities_kept ?? null,
      changed: w.doc.entities_changed ?? null,
    });
  });
  r.stages.L7 = r.edits.every(
    (e) => e.result === 'written' || e.result === 'would_lose',
  )
    ? 'pass'
    : 'fail';
  const after = readdirSync(where).filter((f) => !before.has(f));
  r.stages.L9 = after.length
    ? `fail: ${after.length} files appeared beside the drawing`
    : 'pass';
  report.files.push(r);
  console.log(
    `file ${index + 1}: ${Object.entries(r.stages)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
});
const dir = new URL('./reports/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const path = join(dir, `${report.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`report: ${path}`);
console.log(`edited copies: ${out}`);
