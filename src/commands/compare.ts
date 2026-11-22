// `render`, `diff` and `check`.

import { writeFileSync } from 'node:fs';
import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import type { Drawing, Entity } from '../model/drawing.ts';
import { ocs, primPoints, then } from '../model/geometry.ts';
import { collectTexts } from '../model/texts.ts';
import { walk } from '../model/world.ts';
import { listOutput, type Row, recordOutput } from '../output/views.ts';
import { aciColor, boxOf, placed, type Shape, svg } from '../picture/svg.ts';
import { CURVES, worldPrims } from '../takeoff/lengths.ts';
import {
  list,
  load,
  pickLayer,
  positiveInt,
  regionOf,
  resolvePath,
  save,
  spaceOf,
  str,
} from './common.ts';

const MAX_POINTS = 2_000_000;

function fileArg(input: CommandInput, i = 0, name = '<file>'): string {
  const file = input.positionals[i];
  if (!file) throw usage(`Missing ${name}.`);
  return file;
}

export async function renderCommand(input: CommandInput): Promise<string> {
  const out = str(input.values, 'out');
  if (!out) throw usage('--out <file.svg> is required: the picture to write.');
  if (!/\.svg$/i.test(out)) throw usage('--out must name an .svg file.');
  const { drawing: d } = await load(input, fileArg(input), true);
  const { owners, name: space } = spaceOf(d, input.values);
  const region = regionOf(input.values);
  const wanted = new Set(
    list(input.values, 'layer').map((l) => pickLayer(d, l)),
  );
  const all = input.values.all === true;
  const shapes: Shape[] = [];
  let points = 0;
  const push = (s: Shape) => {
    points += s.points.length;
    if (points > MAX_POINTS)
      throw new AxiError(
        'too_large',
        'The picture would hold more points than this tool draws. Draw one region or fewer layers.',
      );
    shapes.push(s);
  };
  for (const item of walk(d, owners, { dimensions: true })) {
    if (item.hidden && !all) continue;
    if (wanted.size && !wanted.has(item.layer)) continue;
    const e = item.e;
    const color = aciColor(item.color, e.rgb);
    if (CURVES.has(e.kind)) {
      for (const p of worldPrims(item))
        push({ points: primPoints(p, 72), closed: false, color });
    } else if (e.kind === 'HATCH') {
      const m = then(ocs(e.n), item.m);
      for (const loop of e.loops ?? [])
        push({ points: placed(loop, m, e.elev ?? 0), closed: true, color });
    } else if ((e.kind === 'SOLID' || e.kind === '3DFACE') && e.pts) {
      const m = e.kind === 'SOLID' ? then(ocs(e.n), item.m) : item.m;
      const [a, b, c, f] = placed(e.pts, m);
      if (a && b && c && f) push({ points: [a, b, f, c], closed: true, color });
    } else if (e.kind === 'POINT' && e.at) {
      push({ points: placed([e.at], item.m), closed: false, color });
    } else if (e.kind === 'LEADER' && e.pts) {
      push({ points: placed(e.pts, item.m), closed: false, color });
    }
  }
  const texts =
    input.values['no-text'] === true
      ? []
      : collectTexts(d, owners).filter(
          (t) => (all || !t.hidden) && (!wanted.size || wanted.has(t.layer)),
        );
  const box = region ?? boxOf(shapes, texts);
  if (!box)
    throw new AxiError('not_found', 'That space holds nothing to draw.');
  const width = positiveInt(input.values, 'width', 1600, 8000);
  const text = svg(shapes, texts, box, width);
  const path = resolvePath(input.io, out);
  try {
    writeFileSync(path, text, {
      flag: input.values.force === true ? 'w' : 'wx',
      mode: 0o644,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AxiError(
        'exists',
        'The --out file is already there. Name a new file, or pass --force to replace a picture.',
      );
    throw new AxiError(
      'not_found',
      `The --out file cannot be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
    );
  }
  return recordOutput(
    {
      written: path.split(/[\\/]/).at(-1) ?? out,
      space,
      shapes: shapes.length,
      texts: texts.length,
      box: `${box.x0},${box.y0} to ${box.x1},${box.y1}`,
      width,
    },
    false,
    '`cad-axi render`',
    [
      'Look at the picture with your image or SVG viewer',
      'Run `cad-axi render <file> --out x.svg --region x0,y0,x1,y1` to look closer',
    ],
  );
}

const TOL = 1e-9;

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter(
      (k) => (a as Record<string, unknown>)[k] !== undefined,
    );
    const kb = Object.keys(b as object).filter(
      (k) => (b as Record<string, unknown>)[k] !== undefined,
    );
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      same(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return a === b;
}

const STYLE_KEYS = new Set(['color', 'rgb', 'lt', 'lts', 'style', 'invisible']);
const TEXT_KEYS = new Set(['raw', 'text']);
const IGNORED = new Set(['h', 'owner', 'layer', 'kind']);

/** What changed between two versions of one entity, by part. */
export function changes(a: Entity, b: Entity): string[] {
  const parts = new Set<string>();
  if (a.kind !== b.kind) parts.add('kind');
  if (a.layer !== b.layer) parts.add('layer');
  if (a.owner !== b.owner) parts.add('space');
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    const va = (a as unknown as Record<string, unknown>)[k];
    const vb = (b as unknown as Record<string, unknown>)[k];
    if (k === 'attribs') {
      const strip = (list: unknown) =>
        Array.isArray(list)
          ? list.map((x) => ({ ...(x as object), h: undefined }))
          : list;
      if (!same(strip(va), strip(vb))) parts.add('attributes');
      continue;
    }
    if (same(va, vb)) continue;
    parts.add(
      TEXT_KEYS.has(k) ? 'text' : STYLE_KEYS.has(k) ? 'style' : 'geometry',
    );
  }
  return [...parts];
}

export interface Difference {
  added: Entity[];
  removed: Entity[];
  changed: Array<{ a: Entity; b: Entity; parts: string[] }>;
}

export function difference(a: Drawing, b: Drawing): Difference {
  const before = new Map(a.entities.map((e) => [e.h, e]));
  const after = new Map(b.entities.map((e) => [e.h, e]));
  const out: Difference = { added: [], removed: [], changed: [] };
  for (const [h, e] of before) {
    const f = after.get(h);
    if (!f) out.removed.push(e);
    else {
      const parts = changes(e, f);
      if (parts.length) out.changed.push({ a: e, b: f, parts });
    }
  }
  for (const [h, f] of after) if (!before.has(h)) out.added.push(f);
  return out;
}

export async function diff(input: CommandInput): Promise<string> {
  const a = await load(input, fileArg(input, 0, '<a>'), true);
  const b = await load(input, fileArg(input, 1, '<b>'), true);
  const dd = difference(a.drawing, b.drawing);
  const each = input.values.each === true;
  const full = input.values.full === true;
  const limit = positiveInt(input.values, 'limit', 20);
  let rows: Row[];
  let columns: string[];
  if (each) {
    rows = [
      ...dd.added.map((e) => ({
        h: e.h,
        kind: e.kind,
        layer: e.layer,
        change: 'added',
      })),
      ...dd.removed.map((e) => ({
        h: e.h,
        kind: e.kind,
        layer: e.layer,
        change: 'removed',
      })),
      ...dd.changed.map((c) => ({
        h: c.b.h,
        kind: c.b.kind,
        layer: c.b.layer,
        change: `changed: ${c.parts.join(', ')}`,
      })),
    ];
    columns = ['h', 'kind', 'layer', 'change'];
  } else {
    const by = new Map<
      string,
      { layer: string; added: number; removed: number; changed: number }
    >();
    const bump = (layer: string, k: 'added' | 'removed' | 'changed') => {
      const r = by.get(layer) ?? { layer, added: 0, removed: 0, changed: 0 };
      r[k]++;
      by.set(layer, r);
    };
    for (const e of dd.added) bump(e.layer, 'added');
    for (const e of dd.removed) bump(e.layer, 'removed');
    for (const c of dd.changed) bump(c.b.layer, 'changed');
    rows = [...by.values()].sort(
      (x, y) =>
        y.added + y.removed + y.changed - (x.added + x.removed + x.changed),
    );
    columns = ['layer', 'added', 'removed', 'changed'];
  }
  const shown = full ? rows : rows.slice(0, limit);
  const saved = save(input.io, str(input.values, 'save'), {
    added: dd.added.map((e) => e.h),
    removed: dd.removed.map((e) => e.h),
    changed: dd.changed.map((c) => ({ h: c.b.h, parts: c.parts })),
  });
  const total = dd.added.length + dd.removed.length + dd.changed.length;
  return listOutput({
    key: each ? 'entities' : 'layers',
    summary: total
      ? `${dd.added.length} added, ${dd.removed.length} removed, ${dd.changed.length} changed${each ? '' : ` on ${rows.length} layers`}`
      : 'no differences: every entity matches by handle, kind, layer, geometry and text',
    head: { a: a.name, b: b.name, ...(saved ? { saved } : {}) },
    rows: shown,
    columns,
    help: total
      ? [
          'Run `cad-axi diff <a> <b> --each` for each entity that differs',
          'Run `cad-axi query <file> --handle <h>` for one of them',
        ]
      : ['Run `cad-axi check <file>` to check one drawing on its own'],
    full,
    narrower: '--limit',
  });
}

export async function check(input: CommandInput): Promise<string> {
  const { name, drawing: d } = await load(input, fileArg(input), true);
  const checks: Row[] = [];
  const add = (check: string, ok: boolean, detail: string) =>
    checks.push({ check, result: ok ? 'pass' : 'fail', detail });
  const handles = new Map<string, number>();
  for (const e of d.entities) {
    handles.set(e.h, (handles.get(e.h) ?? 0) + 1);
    for (const a of e.attribs ?? [])
      handles.set(a.h, (handles.get(a.h) ?? 0) + 1);
  }
  const dupes = [...handles.values()].filter((n) => n > 1).length;
  add(
    'handles are unique',
    dupes === 0,
    dupes ? `${dupes} handles used twice` : `${handles.size} handles`,
  );
  const orphans = d.entities.filter((e) => !d.blocks.has(e.owner)).length;
  add(
    'every entity has an owner',
    orphans === 0,
    orphans ? `${orphans} entities with no owner block` : 'all owned',
  );
  const layerNames = new Set(d.layers.map((l) => l.name));
  const noLayer = d.entities.filter((e) => !layerNames.has(e.layer)).length;
  add(
    'every layer named exists',
    noLayer === 0,
    noLayer
      ? `${noLayer} entities on a missing layer`
      : `${d.layers.length} layers`,
  );
  const missing = d.entities.filter(
    (e) => e.kind === 'INSERT' && (!e.block || !d.blocks.has(e.block)),
  ).length;
  add(
    'every insert names a defined block',
    missing === 0,
    missing ? `${missing} inserts of missing blocks` : 'all defined',
  );
  const kindTotal = [...d.kinds.values()].reduce((s, n) => s + n, 0);
  add(
    'counts agree',
    kindTotal === d.end.entities && d.entities.length === d.end.entities,
    `${d.entities.length} entities read, ${d.end.entities} counted`,
  );
  // Blocks that insert themselves, directly or through others.
  const children = new Map<string, Set<string>>();
  for (const e of d.entities)
    if (e.kind === 'INSERT' && e.block) {
      const set = children.get(e.owner) ?? new Set<string>();
      set.add(e.block);
      children.set(e.owner, set);
    }
  let cycles = 0;
  const state = new Map<string, number>();
  const visit = (n: string, depth: number): void => {
    if (depth > 64) return;
    state.set(n, 1);
    for (const c of children.get(n) ?? []) {
      if (state.get(c) === 1) cycles++;
      else if (!state.has(c)) visit(c, depth + 1);
    }
    state.set(n, 2);
  };
  for (const n of children.keys()) if (!state.has(n)) visit(n, 0);
  add(
    'no block inserts itself',
    cycles === 0,
    cycles ? `${cycles} cycles` : 'none',
  );
  add(
    'the engine read it without errors',
    d.end.errors === 0,
    `${d.end.errors} errors, ${d.end.warnings} warnings while reading`,
  );
  const failed = checks.filter((c) => c.result === 'fail').length;
  return recordOutput(
    {
      file: name,
      result: failed
        ? `${failed} of ${checks.length} checks failed`
        : `all ${checks.length} checks pass`,
      checks,
    },
    input.values.full === true,
    '`cad-axi check <file>`',
    failed
      ? [
          'Open the drawing in its CAD program and run AUDIT',
          'Run `cad-axi info <file>` for what it holds',
        ]
      : ['Run `cad-axi info <file>` for what it holds'],
  );
}

export { ocs };
