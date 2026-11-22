#!/usr/bin/env node
// Independent checks for the engine proof (design §12, implementation plan
// T8 and T25): LibreDWG reads what the engine wrote, both count ACadSharp's
// sample drawings, and the engine reads Hebrew that ezdxf and LibreDWG wrote.
//
//   node scripts/oracles/cross-check.mjs --engine <path> --libredwg <bin dir>
//     --written <dir with known-*.dwg> --samples <dir> --hebrew-dxf <file>
//     --python <python with ezdxf> --work <dir> --report <file.json>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: v } = parseArgs({
  options: {
    engine: { type: 'string' }, libredwg: { type: 'string' }, written: { type: 'string' },
    samples: { type: 'string' }, 'hebrew-dxf': { type: 'string' }, python: { type: 'string' }, work: { type: 'string' }, report: { type: 'string' },
  },
});
const work = resolve(v.work);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const gates = [];
const report = { gates, rows: {} };
const gate = (name, ok, detail) => gates.push({ name, ok: Boolean(ok), detail });
const HEB_TEXT = 'שלום %%c110';
const HEB_MTEXT = 'צנרת ביוב';

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 300_000 });
const engineRead = (file) => {
  const r = sh(resolve(v.engine), ['read', file, '--entities']);
  const recs = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ents = recs.filter((x) => x.type === 'entity');
  return { status: r.status, end: recs.at(-1), ents };
};
// LibreDWG's JSON: entities are the OBJECTS with an "entity" key.
const libredwgRead = (file) => {
  const out = join(work, `${file.split('/').pop()}.json`);
  const r = sh(join(v.libredwg, 'dwgread'), ['-O', 'JSON', '-o', out, file]);
  let doc = null;
  try { doc = JSON.parse(readFileSync(out, 'utf8')); } catch { /* read failed */ }
  const objs = doc?.OBJECTS ?? [];
  const ents = objs.filter((o) => typeof o.entity === 'string');
  return { status: r.status, stderr: r.stderr.slice(-300), ents };
};
const count = (ents, key) => ents.reduce((m, e) => ((m[e[key]] = (m[e[key]] ?? 0) + 1), m), {});
const text = (ents, kind, key) => ents.find((e) => e[key] === kind);

// 1. LibreDWG reads every DWG the engine wrote.
for (const ver of ['AC1014', 'AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032']) {
  const file = join(v.written, `known-${ver}.dwg`);
  const l = libredwgRead(file);
  const c = count(l.ents, 'entity');
  const t = text(l.ents, 'TEXT', 'entity');
  const m = text(l.ents, 'MTEXT', 'entity');
  const row = {
    status: l.status,
    kinds: c,
    text: t?.text_value ?? null,
    mtext: m?.text ?? null,
    stderr: l.ents.length ? undefined : l.stderr,
  };
  row.ok = ['LINE', 'LWPOLYLINE', 'CIRCLE', 'TEXT', 'MTEXT'].every((k) => c[k] === 1)
    && row.text === HEB_TEXT && row.mtext === HEB_MTEXT;
  report.rows[`libredwg reads engine ${ver}`] = row;
  if (ver === 'AC1014') continue; // recorded: cad-axi never offers R14 output
  gate(`LibreDWG reads the engine's ${ver} DWG`, row.ok, row);
}

// 2. Both count ACadSharp's sample drawings.
const samples = JSON.parse(readFileSync(join(v.samples, 'samples.json'), 'utf8')).files.filter((f) => f.name.endsWith('.dwg'));
for (const f of samples) {
  const file = join(v.samples, f.name);
  const e = engineRead(file);
  const l = libredwgRead(file);
  const ce = count(e.ents, 'kind');
  const cl = count(l.ents, 'entity');
  const kinds = [...new Set([...Object.keys(ce), ...Object.keys(cl)])].sort();
  const diff = Object.fromEntries(kinds.filter((k) => (ce[k] ?? 0) !== (cl[k] ?? 0)).map((k) => [k, [ce[k] ?? 0, cl[k] ?? 0]]));
  const common = ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'TEXT', 'MTEXT', 'INSERT', 'POINT', 'ELLIPSE', 'SPLINE'];
  const commonOk = common.every((k) => (ce[k] ?? 0) === (cl[k] ?? 0));
  report.rows[`sample ${f.name}`] = { engine: e.ents.length, libredwg: l.ents.length, differ: diff, common_agree: commonOk };
  gate(`engine and LibreDWG agree on simple entities in ${f.name}`, commonOk, diff);
}

// 3. Hebrew written by ezdxf (DXF) and by LibreDWG (DWG from that DXF).
{
  const dxf = resolve(v['hebrew-dxf']);
  const e = engineRead(dxf);
  const t = e.ents.find((x) => x.kind === 'TEXT')?.raw;
  const m = e.ents.find((x) => x.kind === 'MTEXT')?.raw;
  report.rows['engine reads ezdxf R2000 DXF'] = { text: t, mtext: m };
  gate('engine reads Hebrew from an ezdxf R2000 DXF in code page 1255', t === HEB_TEXT && m === HEB_MTEXT, { text: t, mtext: m });

  // ezdxf reads the engine's own DXF output, pre-2007 and current.
  for (const ver of ['AC1015', 'AC1032']) {
    const r = sh(v.python, [join(import.meta.dirname, 'read_dxf.py'), join(v.written, `known-${ver}.dxf`)]);
    let got = null;
    try { got = JSON.parse(r.stdout); } catch { got = { error: r.stderr.slice(-300) }; }
    report.rows[`ezdxf reads engine ${ver} DXF`] = got;
    const ok = ['LINE', 'LWPOLYLINE', 'CIRCLE', 'TEXT', 'MTEXT'].every((k) => got?.kinds?.[k] === 1)
      && got.text?.[0] === HEB_TEXT && got.mtext?.[0] === HEB_MTEXT && got.audit_errors === 0;
    gate(`ezdxf reads the engine's ${ver} DXF`, ok, got);
  }

  // LibreDWG 0.14 as a DWG producer: recorded, not gated. ACadSharp cannot
  // read its R2000 or R2004 output, which LibreDWG itself reads back; AutoCAD
  // also asks to recover LibreDWG-written files (design §4.1).
  const dwg = join(work, 'hebrew-libredwg-r2000.dwg');
  const conv = sh(join(v.libredwg, 'dxf2dwg'), ['-y', '--as', 'r2000', '-o', dwg, dxf]);
  const e2 = engineRead(dwg);
  const t2 = e2.ents.find((x) => x.kind === 'TEXT')?.raw;
  const m2 = e2.ents.find((x) => x.kind === 'MTEXT')?.raw;
  const self = sh(join(v.libredwg, 'dwgread'), ['-O', 'JSON', '-o', join(work, 'self.json'), dwg]);
  report.rows['engine reads LibreDWG R2000 DWG'] = { convert_status: conv.status, libredwg_self_read: self.status, engine: e2.end, text: t2, mtext: m2 };
}

writeFileSync(resolve(v.report), JSON.stringify(report, null, 2));
const failed = gates.filter((g) => !g.ok);
console.log([
  '## Independent checks',
  '',
  `- Gates: ${gates.length - failed.length} of ${gates.length} pass`,
  ...failed.map((g) => `  - FAIL ${g.name}: ${JSON.stringify(g.detail).slice(0, 400)}`),
  `- R14 (recorded): ${JSON.stringify(report.rows['libredwg reads engine AC1014']).slice(0, 300)}`,
  `- LibreDWG-written R2000 DWG (recorded): ${JSON.stringify(report.rows['engine reads LibreDWG R2000 DWG'])}`,
  ...Object.entries(report.rows).filter(([k]) => k.startsWith('sample ')).map(([k, r]) => `- ${k}: engine ${r.engine}, LibreDWG ${r.libredwg}, differ ${JSON.stringify(r.differ)}`),
].join('\n'));
process.exit(failed.length ? 1 : 0);
