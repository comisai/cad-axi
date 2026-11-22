// Lengths of the curves in a space, inserts opened, each in world
// coordinates and cut to a region when one is given.

import type { Drawing, Entity, P3 } from '../model/drawing.ts';
import {
  type Box,
  lengthIn,
  type Prim,
  primsOf,
  transformPrim,
} from '../model/geometry.ts';
import { type WorldItem, walk } from '../model/world.ts';

export const CURVES = new Set([
  'LINE',
  'ARC',
  'CIRCLE',
  'ELLIPSE',
  'LWPOLYLINE',
  'POLYLINE',
  'SPLINE',
]);

export interface Piece {
  item: WorldItem;
  prims: Prim[];
  /** Drawing units, inside the region. */
  length: number;
  approximated: boolean;
}

export interface Pieces {
  pieces: Piece[];
  /** Length on layers that are off or frozen, left out unless asked. */
  hidden: { length: number; entities: number };
}

function splineTolerance(e: Entity): number {
  const pts = e.ctrl ?? e.fit ?? [];
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of pts as P3[]) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  return Number.isFinite(diag) && diag > 0 ? diag * 1e-6 : 1e-6;
}

export function worldPrims(item: WorldItem): Prim[] {
  const e = item.e;
  const local = primsOf(e, e.kind === 'SPLINE' ? splineTolerance(e) : 1e-3);
  return local.map((p) => transformPrim(p, item.m));
}

export function piecesOf(
  d: Drawing,
  owners: readonly string[],
  region: Box | null,
  options: { all: boolean; layers?: ReadonlySet<string> },
): Pieces {
  const out: Piece[] = [];
  const hidden = { length: 0, entities: 0 };
  for (const item of walk(d, owners)) {
    if (!CURVES.has(item.e.kind)) continue;
    if (options.layers && !options.layers.has(item.layer)) continue;
    const prims = worldPrims(item);
    let length = 0;
    for (const p of prims) length += lengthIn(p, region);
    if (region && length <= 0) continue;
    if (item.hidden && !options.all) {
      hidden.length += length;
      hidden.entities++;
      continue;
    }
    out.push({ item, prims, length, approximated: item.e.kind === 'SPLINE' });
  }
  return { pieces: out, hidden };
}
