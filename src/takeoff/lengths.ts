// Lengths of the curves in a space, inserts opened, each in world
// coordinates and cut to a region when one is given.

import type { Drawing, Entity, P3 } from '../model/drawing.ts';
import {
  type Box,
  lengthIn,
  type Prim,
  primRange,
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
  elevation: Elevation;
}

export interface Elevation {
  min: number;
  max: number;
  dominant: number;
}

export const lengthMode = (spatial: boolean) =>
  spatial ? '3D (XYZ)' : 'plan (XY)';

export function elevationFields(elevation: Elevation) {
  const span = elevation.max - elevation.min;
  return Number.isFinite(span) && span > 0
    ? { z_span: span, z_dominant_entities: elevation.dominant }
    : {};
}

export function elevationOf(
  prims: readonly Prim[],
  planLength: number,
): Elevation {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of prims) {
    const [low, high] = primRange(p, 2);
    min = Math.min(min, low);
    max = Math.max(max, high);
  }
  return { min, max, dominant: max - min > 10 * planLength ? 1 : 0 };
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
  options: {
    all: boolean;
    layers?: ReadonlySet<string>;
    spatial?: boolean;
    includeOtherLayers?: boolean;
  },
): Pieces {
  const out: Piece[] = [];
  const hidden = { length: 0, entities: 0 };
  const elevation = {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    dominant: 0,
  };
  for (const item of walk(d, owners)) {
    if (!CURVES.has(item.e.kind)) continue;
    const selected = !options.layers || options.layers.has(item.layer);
    if (!selected && !options.includeOtherLayers) continue;
    const prims = worldPrims(item);
    let length = 0;
    for (const p of prims) length += lengthIn(p, region, options.spatial);
    if (
      region &&
      length <= 0 &&
      !prims.some((p) => lengthIn(p, region, true) > 0)
    )
      continue;
    if (item.hidden && !options.all) {
      if (selected) {
        hidden.length += length;
        hidden.entities++;
      }
      continue;
    }
    if (selected) {
      const planLength =
        region || options.spatial
          ? prims.reduce((s, p) => s + lengthIn(p, null), 0)
          : length;
      const z = elevationOf(prims, planLength);
      elevation.min = Math.min(elevation.min, z.min);
      elevation.max = Math.max(elevation.max, z.max);
      elevation.dominant += z.dominant;
    }
    if (region && length <= 0) continue;
    out.push({ item, prims, length, approximated: item.e.kind === 'SPLINE' });
  }
  return { pieces: out, hidden, elevation };
}
