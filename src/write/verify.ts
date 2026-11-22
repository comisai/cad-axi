// Every write is checked before success is reported (design §8.9). The
// output is read again by a fresh engine process and compared: with the
// specification for `create`, and entity by entity with the source for
// `edit` and `convert`. Any mismatch is `verify_failed`, with counts.

import { changes } from '../commands/compare.ts';
import { AxiError } from '../errors.ts';
import type { Drawing, Entity, P3 } from '../model/drawing.ts';
import type { Op, Spec, SpecEntity } from './schema.ts';

const TOL = 1e-6;

const close = (a: number, b: number) =>
  Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));
const p3 = (p: readonly number[] | undefined): P3 => [
  p?.[0] ?? 0,
  p?.[1] ?? 0,
  p?.[2] ?? 0,
];
const closeP = (
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
) => {
  const x = p3(a);
  const y = p3(b);
  return close(x[0], y[0]) && close(x[1], y[1]) && close(x[2], y[2]);
};
const rad = (deg: number) => (deg * Math.PI) / 180;
const angle = (a: number, b: number) => {
  const d = Math.abs(
    ((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
  );
  return d <= 1e-6;
};

/** MTEXT keeps a new line as \P. */
export const mtextValue = (v: string) => v.replace(/\r?\n/g, '\\P');

/** Whether an entity read back is the one a specification asked for. */
export function matches(s: SpecEntity, e: Entity): boolean {
  const layer = s.layer ?? '0';
  if (e.layer !== layer) return false;
  if (s.color !== undefined && e.color !== s.color) return false;
  switch (s.kind) {
    case 'line':
      return e.kind === 'LINE' && closeP(e.a, s.from) && closeP(e.b, s.to);
    case 'polyline': {
      if (e.kind !== 'LWPOLYLINE' || !e.pts || e.pts.length !== s.pts?.length)
        return false;
      if (!!e.closed !== !!s.closed) return false;
      return s.pts.every(
        (p, i) =>
          closeP(e.pts?.[i], p) &&
          close(e.bulges?.[i] ?? 0, s.bulges?.[i] ?? 0),
      );
    }
    case 'circle':
      return (
        e.kind === 'CIRCLE' &&
        closeP(e.c, s.center) &&
        close(e.r ?? 0, s.radius ?? 0)
      );
    case 'arc':
      return (
        e.kind === 'ARC' &&
        closeP(e.c, s.center) &&
        close(e.r ?? 0, s.radius ?? 0) &&
        angle(e.a0 ?? 0, rad(s.start ?? 0)) &&
        angle(e.a1 ?? 0, rad(s.end ?? 0))
      );
    case 'point':
      return e.kind === 'POINT' && closeP(e.at, s.at);
    case 'text':
      return (
        e.kind === 'TEXT' &&
        e.raw === s.value &&
        closeP(e.at, s.at) &&
        close(e.height ?? 0, s.height ?? 0) &&
        angle(e.rot ?? 0, rad(s.rotation ?? 0))
      );
    case 'mtext':
      return (
        e.kind === 'MTEXT' &&
        e.raw === mtextValue(s.value ?? '') &&
        closeP(e.at, s.at) &&
        close(e.height ?? 0, s.height ?? 0)
      );
    case 'attdef':
      return (
        e.kind === 'ATTDEF' &&
        e.tag === s.tag &&
        e.raw === s.value &&
        closeP(e.at, s.at)
      );
    case 'insert': {
      if (e.kind !== 'INSERT' || e.block !== s.block || !closeP(e.at, s.at))
        return false;
      const [sx, sy, sz] = [
        s.scale?.[0] ?? 1,
        s.scale?.[1] ?? 1,
        s.scale?.[2] ?? 1,
      ];
      if (
        !close(e.sx ?? 1, sx) ||
        !close(e.sy ?? 1, sy) ||
        !close(e.sz ?? 1, sz) ||
        !angle(e.rot ?? 0, rad(s.rotation ?? 0))
      )
        return false;
      for (const [tag, value] of Object.entries(s.attribs ?? {}))
        if (!e.attribs?.some((a) => a.tag === tag && a.raw === value))
          return false;
      return true;
    }
  }
}

function failed(message: string, fields: Record<string, number>): AxiError {
  return new AxiError(
    'verify_failed',
    `${message} The output was deleted.`,
    fields,
  );
}

/** Match each asked-for entity to one read back, once. */
function matchAll(
  asked: readonly SpecEntity[],
  got: readonly Entity[],
): number {
  const free = [...got];
  let missing = 0;
  for (const s of asked) {
    const i = free.findIndex((e) => matches(s, e));
    if (i < 0) missing++;
    else free.splice(i, 1);
  }
  return missing;
}

export function verifyCreate(
  spec: Spec,
  out: Drawing,
  model: string,
): { entities: number } {
  const layers = new Map(out.layers.map((l) => [l.name, l]));
  let badLayers = 0;
  for (const l of spec.layers) {
    const got = layers.get(l.name);
    if (
      !got ||
      (l.color !== undefined && got.color !== l.color) ||
      (l.frozen !== undefined && got.frozen !== l.frozen)
    )
      badLayers++;
  }
  const byOwner = (name: string) => out.byOwner.get(name) ?? [];
  let missing = 0;
  let extra = 0;
  for (const b of spec.blocks) {
    if (!out.blocks.has(b.name)) {
      missing += b.entities.length;
      continue;
    }
    const got = byOwner(b.name);
    missing += matchAll(b.entities, got);
    extra += Math.max(0, got.length - b.entities.length);
  }
  const bySpace = new Map<string, SpecEntity[]>();
  for (const e of spec.entities) {
    const space = e.space ?? 'Model';
    const list = bySpace.get(space) ?? [];
    list.push(e);
    bySpace.set(space, list);
  }
  for (const [space, list] of bySpace) {
    const block =
      space === 'Model'
        ? model
        : out.header.layouts.find((l) => l.name === space)?.block;
    const got = block
      ? byOwner(block).filter((e) => e.kind !== 'VIEWPORT')
      : [];
    missing += matchAll(list, got);
    extra += Math.max(0, got.length - list.length);
  }
  if (!bySpace.has('Model')) extra += byOwner(model).length;
  if (missing || extra || badLayers)
    throw failed(
      `The written drawing did not match the specification: ${missing} entities missing or different, ${extra} extra, ${badLayers} layers wrong.`,
      {
        missing,
        extra,
        layers: badLayers,
      },
    );
  return {
    entities:
      spec.entities.length +
      spec.blocks.reduce((s, b) => s + b.entities.length, 0),
  };
}

export interface EditCheck {
  kept: number;
  changed: number;
  deleted: number;
  added: number;
}

/** An entity's place: its start, centre or insert point. */
function anchor(e: Entity): P3 | null {
  if (e.a) return e.a;
  if (e.c) return e.c;
  if (e.at) return e.at;
  const p = e.pts?.[0];
  return p ? p3(p) : null;
}

export function verifyEdit(
  source: Drawing,
  out: Drawing,
  ops: readonly Op[],
  added: ReadonlyArray<{ op: number; h: string }>,
): EditCheck {
  const before = new Map(source.entities.map((e) => [e.h, e]));
  const after = new Map(out.entities.map((e) => [e.h, e]));
  const byHandle = new Map<string, Op[]>();
  for (const op of ops)
    if (op.h) {
      const list = byHandle.get(op.h) ?? [];
      list.push(op);
      byHandle.set(op.h, list);
    }
  const problems = { lost: 0, changed: 0, wrong: 0, census: 0 };
  let kept = 0;
  let changedOk = 0;
  let deleted = 0;
  for (const [h, a] of before) {
    const list = byHandle.get(h);
    const b = after.get(h);
    if (list?.some((o) => o.op === 'delete')) {
      if (b) problems.wrong++;
      else deleted++;
      continue;
    }
    if (!b) {
      problems.lost++;
      continue;
    }
    const parts = changes(a, b);
    if (!list) {
      if (parts.length) problems.changed++;
      else kept++;
      continue;
    }
    // What each operation may change, and its effect must be there.
    const allowed = new Set<string>();
    let ok = true;
    for (const op of list) {
      if (op.op === 'set_text') {
        allowed.add('text');
        if (
          b.raw !== (a.kind === 'MTEXT' ? mtextValue(op.value ?? '') : op.value)
        )
          ok = false;
      } else if (op.op === 'set_attribute') {
        allowed.add('attributes');
        if (!b.attribs?.some((x) => x.tag === op.tag && x.raw === op.value))
          ok = false;
      } else if (op.op === 'set_layer') {
        allowed.add('layer');
        if (b.layer !== op.layer) ok = false;
      } else if (op.op === 'move') {
        allowed.add('geometry');
        allowed.add('attributes');
        const pa = anchor(a);
        const pb = anchor(b);
        const by = p3(op.by);
        if (
          pa &&
          pb &&
          !closeP(pb, [pa[0] + by[0], pa[1] + by[1], pa[2] + by[2]])
        )
          ok = false;
      }
    }
    if (!ok || parts.some((p) => !allowed.has(p))) problems.wrong++;
    else changedOk++;
  }
  // Added entities, by the handles the engine reported.
  for (const { op, h } of added) {
    const o = ops[op];
    const e = after.get(h);
    if (!o || !e || before.has(h)) {
      problems.wrong++;
      continue;
    }
    const { op: name, ...rest } = o;
    if (
      !matches(
        { ...(rest as SpecEntity), kind: name.slice(4) as SpecEntity['kind'] },
        e,
      )
    )
      problems.wrong++;
  }
  const expectedAdds = ops.filter(
    (o) => o.op.startsWith('add_') && o.op !== 'add_layer',
  ).length;
  if (added.length !== expectedAdds)
    problems.wrong += Math.abs(expectedAdds - added.length);
  const extra = [...after.keys()].filter(
    (h) => !before.has(h) && !added.some((a) => a.h === h),
  ).length;
  problems.wrong += extra;
  // The census: no class, object type or layer may be lost.
  // Files before AC1018 do not record how many objects a class has, so for
  // them a class need only be present; the object census below counts.
  const counted = out.header.version >= 'AC1018';
  for (const c of source.classes) {
    const got = out.classes.find((x) => x.name === c.name);
    if (c.instances > 0 && (!got || (counted && got.instances < c.instances)))
      problems.census++;
  }
  for (const o of source.objects) {
    const got = out.objects.find((x) => x.name === o.name);
    if (!got || got.count < o.count) problems.census++;
  }
  const layers = new Map(out.layers.map((l) => [l.name, l]));
  for (const l of source.layers) {
    const got = layers.get(l.name);
    if (
      !got ||
      got.color !== l.color ||
      got.frozen !== l.frozen ||
      got.on !== l.on ||
      got.locked !== l.locked
    )
      problems.census++;
  }
  for (const [name, b] of source.blocks) {
    const got = out.blocks.get(name);
    if (!got) problems.census++;
    else if (!b.layout && got.entities !== b.entities) problems.census++;
  }
  if (problems.lost || problems.changed || problems.wrong || problems.census)
    throw failed(
      `The written drawing did not match: ${problems.lost} entities lost, ${problems.changed} changed that no operation named, ${problems.wrong} operations not carried out as asked, ${problems.census} tables, blocks, classes or object types lost.`,
      problems,
    );
  return { kept, changed: changedOk, deleted, added: added.length };
}
