// The home view, `info` and `version`.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runEngine } from '../bridge/engine.ts';
import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import { type Drawing, layoutOf, RELEASES } from '../model/drawing.ts';
import { unitEvidence } from '../model/unit-evidence.ts';
import { unitsOf } from '../model/units.ts';
import { render } from '../output/toon.ts';
import {
  countLine,
  type Row,
  recordOutput,
  tableRow,
} from '../output/views.ts';
import { VERSION } from '../version.ts';
import { preflight } from '../write/preflight.ts';
import {
  binPath,
  deadlineOf,
  load,
  MAX_BYTES,
  readPath,
  sniff,
  str,
} from './common.ts';

export const DESCRIPTION =
  'Read, create and edit CAD drawings in DWG and DXF files: layers, blocks, text, lengths, runs and sizes';

const SHOWN = 20;
/** The home view reads files in full until this much time has passed. */
const HOME_BUDGET_MS = 15_000;

const CAD = /\.(dwg|dxf)$/i;

export const release = (version: string): string =>
  RELEASES[version] ?? 'unknown release';

/** Classes that vertical products (Architecture, MEP, Civil 3D, Plant 3D) write. */
export function verticalClasses(
  d: Drawing,
): Array<{ name: string; count: number }> {
  return d.classes
    .filter(
      (c) =>
        c.instances > 0 &&
        (/^AEC|^AECB|^AECC|^ACPP|^ACPL/i.test(c.name) ||
          /\bAEC\b|MEP|Civil|Plant/i.test(c.app)),
    )
    .map((c) => ({ name: c.name, count: c.instances }));
}

export async function home(input: CommandInput): Promise<string> {
  const dir = input.io.cwd;
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && CAD.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    names = [];
  }
  const start = input.io.now().getTime();
  const rows: Row[] = [];
  for (const file of names.slice(0, SHOWN)) {
    const path = join(dir, file);
    const head = sniff(path);
    const version = head.version
      ? `${head.version} (${release(head.version)})`
      : head.format === 'dxf'
        ? 'DXF'
        : null;
    if (!head.format) {
      rows.push({ file, version: 'not a DWG or DXF file' });
      continue;
    }
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) {
      rows.push({ file, version, units: 'too large to read here' });
      continue;
    }
    if (input.io.now().getTime() - start > HOME_BUDGET_MS) {
      rows.push({ file, version, units: 'not read: run info' });
      continue;
    }
    try {
      const d = await readPath(input.io, path, false);
      const u = unitsOf(d.header.insunits, undefined);
      rows.push({
        file,
        version: `${d.header.version} (${release(d.header.version)})`,
        units: u.name ?? 'not stated',
        entities: d.end.entities,
        editable: preflight(d).editable ? 'yes' : 'no',
      });
    } catch (error) {
      rows.push({
        file,
        version,
        units:
          error instanceof AxiError
            ? `not readable: ${error.code}`
            : 'not readable',
      });
    }
  }
  const home = homedir();
  const folder =
    dir === home || dir.startsWith(`${home}/`)
      ? `~${dir.slice(home.length)}`
      : dir;
  const doc: Row = {
    bin: binPath(process.argv[1]),
    description: DESCRIPTION,
    folder,
    summary: names.length
      ? `${countLine(rows.length, names.length, 'drawing')} in this folder`
      : 'no DWG or DXF files in this folder',
  };
  if (rows.length)
    doc.drawings = rows.map((r) =>
      tableRow(r, ['file', 'version', 'units', 'entities', 'editable'], 120),
    );
  return render(
    doc,
    rows.length
      ? [
          'Run `cad-axi info <file>` for what one drawing holds: units, layouts, layers, blocks and what cannot be read',
          'Run `cad-axi layers <file>` for its layers with the length drawn on each',
        ]
      : [
          'Run `cad-axi info <path/to/file.dwg>` to read a drawing in another folder',
        ],
  );
}

export async function info(input: CommandInput): Promise<string> {
  const file = input.positionals[0];
  if (!file) throw usage('Missing <file>.');
  const { name, bytes, drawing: d } = await load(input, file, 'units');
  const units = unitsOf(d.header.insunits, str(input.values, 'units'));
  const declared = unitsOf(d.header.insunits, undefined);
  const layouts = d.header.layouts.map((l) => {
    const block = d.blocks.get(l.block);
    return `${l.name} (${block?.entities ?? 0})`;
  });
  const kinds = [...d.kinds.entries()].sort((a, b) => b[1] - a[1]);
  const xrefs = [...d.blocks.values()].filter((b) => b.external);
  const blocks = [...d.blocks.values()].filter(
    (b) => !b.layout && !b.anonymous && !b.external,
  );
  const frozen = d.layers.filter((l) => l.frozen).length;
  const off = d.layers.filter((l) => !l.on && !l.frozen).length;
  const vertical = verticalClasses(d);
  const pf = preflight(d);
  const pre2007 = d.header.version < 'AC1021';
  const doc: Row = {
    file: name,
    format: d.header.format.toUpperCase(),
    version: d.header.version,
    release: release(d.header.version),
    bytes,
    units: units.name ?? 'not stated',
    declared_units: declared.name ?? 'not stated',
    units_basis:
      units.basis === 'file'
        ? 'stated by the file'
        : units.basis === 'given'
          ? 'given with --units'
          : 'unknown: pass --units to measure',
    unit_header: {
      insunits: d.header.insunits,
      measurement_code: d.header.measurement,
      measurement:
        d.header.measurement === 1
          ? 'metric'
          : d.header.measurement === 0
            ? 'imperial'
            : 'unknown',
    },
    unit_evidence: unitEvidence(d, input.values.full === true),
    ...(pre2007 ? { codepage: d.header.codepage } : {}),
    extents:
      d.header.extmin &&
      d.header.extmax &&
      Math.abs(d.header.extmin[0]) < 1e19 &&
      (d.header.extmin[0] !== d.header.extmax[0] ||
        d.header.extmin[1] !== d.header.extmax[1])
        ? `${d.header.extmin[0]},${d.header.extmin[1]} to ${d.header.extmax[0]},${d.header.extmax[1]}`
        : null,
    layouts: layouts.join(', '),
    entities: d.end.entities,
    kinds: kinds
      .slice(0, input.values.full === true ? kinds.length : 12)
      .map(([kind, count]) => ({ kind, count })),
    layers: `${d.layers.length}${frozen ? `, ${frozen} frozen` : ''}${off ? `, ${off} off` : ''}`,
    blocks: blocks.length,
    texts: (d.kinds.get('TEXT') ?? 0) + (d.kinds.get('MTEXT') ?? 0),
    external_references: xrefs.length
      ? `${xrefs.length}: ${xrefs
          .map((x) => x.name)
          .slice(0, 8)
          .join(', ')} (listed, never opened)`
      : null,
    images: d.externals.filter((x) => x.kind === 'image').length || null,
    pdf_underlays: d.externals.filter((x) => x.kind === 'pdf').length || null,
    ole_objects: d.kinds.get('OLE2FRAME') ?? null,
    opaque:
      d.end.unknown || d.end.proxies || d.end.unknown_objects
        ? `${d.end.unknown} unknown entities, ${d.end.proxies} proxy entities, ${d.end.unknown_objects} unknown objects: present but not read`
        : null,
    vertical_products: vertical.length
      ? `${vertical.reduce((s, v) => s + v.count, 0)} objects of ${vertical.length} classes from AutoCAD Architecture, MEP or similar (${vertical
          .slice(0, 4)
          .map((v) => v.name)
          .join(
            ', ',
          )}); no open engine reads them: ask for a copy saved with "Export to AutoCAD"`
      : null,
    editable: pf.editable ? 'yes' : 'no',
    editable_reason: pf.reason,
    read_warnings: d.end.errors + d.end.warnings || null,
  };
  const help = [
    'Run `cad-axi layers <file>` for layers with entity counts and lengths',
    'Run `cad-axi texts <file>` for the text on the drawing',
  ];
  if (units.metres === null)
    help.push('Run `cad-axi measure <file> --units mm` once you know the unit');
  else help.push('Run `cad-axi measure <file>` for lengths by layer');
  return recordOutput(
    doc,
    input.values.full === true,
    '`cad-axi info <file>`',
    help,
  );
}

export async function version(input: CommandInput): Promise<string> {
  const r = await runEngine(['probe'], {
    deadline: deadlineOf(input.io),
    now: () => input.io.now().getTime(),
  });
  const p = r.last;
  if (p.type !== 'probe')
    throw new AxiError(
      'engine_failed',
      'The engine did not report its version.',
    );
  return render({
    package: VERSION,
    engine: String(p.engine),
    acadsharp: String(p.acadsharp),
    protocol: Number(p.protocol),
    platform: String(p.platform),
  });
}

export { layoutOf };
