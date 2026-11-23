// Geometry in world coordinates: entity records become primitives that
// survive any affine transform, so block inserts (moved, rotated, scaled,
// mirrored, nested) measure exactly.
//
// - seg: a straight piece from a to b;
// - conic: c + cos(t)·M + sin(t)·m for t from t0 to t1; a circle, an arc,
//   an ellipse or a polyline bulge. An affine map keeps it a conic;
// - poly: points of a flattened spline, approximate by a stated tolerance.

import type { Entity, P3 } from './drawing.ts';

export type Prim =
  | { t: 'seg'; a: P3; b: P3 }
  | { t: 'conic'; c: P3; M: P3; m: P3; t0: number; t1: number }
  | { t: 'poly'; pts: P3[] };

/** A 3x4 affine matrix, row by row: x' = m[0]x + m[1]y + m[2]z + m[3], and so on. */
export type Mat = readonly number[];

export const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export const add = (a: P3, b: P3): P3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: P3, b: P3): P3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: P3, b: P3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: P3, b: P3): P3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: P3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: P3): P3 => {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 1];
};
export const dist = (a: P3, b: P3): number => norm(sub(a, b));

export function apply(m: Mat, p: P3): P3 {
  return [
    (m[0] as number) * p[0] +
      (m[1] as number) * p[1] +
      (m[2] as number) * p[2] +
      (m[3] as number),
    (m[4] as number) * p[0] +
      (m[5] as number) * p[1] +
      (m[6] as number) * p[2] +
      (m[7] as number),
    (m[8] as number) * p[0] +
      (m[9] as number) * p[1] +
      (m[10] as number) * p[2] +
      (m[11] as number),
  ];
}

/** The linear part only, for vectors. */
export function applyVec(m: Mat, v: P3): P3 {
  return [
    (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
    (m[4] as number) * v[0] + (m[5] as number) * v[1] + (m[6] as number) * v[2],
    (m[8] as number) * v[0] +
      (m[9] as number) * v[1] +
      (m[10] as number) * v[2],
  ];
}

/** a then b: the matrix of b(a(p)). */
export function then(a: Mat, b: Mat): Mat {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++)
        s += (b[i * 4 + k] as number) * (a[k * 4 + j] as number);
      if (j === 3) s += b[i * 4 + 3] as number;
      r.push(s);
    }
  }
  return r;
}

export const translate = (t: P3): Mat => [
  1,
  0,
  0,
  t[0],
  0,
  1,
  0,
  t[1],
  0,
  0,
  1,
  t[2],
];
export const scaling = (sx: number, sy: number, sz: number): Mat => [
  sx,
  0,
  0,
  0,
  0,
  sy,
  0,
  0,
  0,
  0,
  sz,
  0,
];
export function rotationZ(angle: number): Mat {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

/**
 * The object coordinate system of a normal, by AutoCAD's arbitrary axis
 * rule: the matrix that takes OCS points to world points.
 */
export function ocs(n: P3 | undefined): Mat {
  if (!n || (n[0] === 0 && n[1] === 0 && n[2] === 1)) return IDENTITY;
  const z = unit(n);
  const limit = 1 / 64;
  const ax = unit(
    Math.abs(z[0]) < limit && Math.abs(z[1]) < limit
      ? cross([0, 1, 0], z)
      : cross([0, 0, 1], z),
  );
  const ay = unit(cross(z, ax));
  return [ax[0], ay[0], z[0], 0, ax[1], ay[1], z[1], 0, ax[2], ay[2], z[2], 0];
}

/** The world matrix of one block insert, at one column and row of an array. */
export function insertMatrix(e: Entity, base: P3, col = 0, row = 0): Mat {
  const at = e.at ?? [0, 0, 0];
  let m = translate([-base[0], -base[1], -base[2]]);
  m = then(m, scaling(e.sx ?? 1, e.sy ?? 1, e.sz ?? 1));
  m = then(m, translate([col * (e.cs ?? 0), row * (e.rs ?? 0), 0]));
  m = then(m, rotationZ(e.rot ?? 0));
  m = then(m, translate(at));
  return then(m, ocs(e.n));
}

export function transformPrim(p: Prim, m: Mat): Prim {
  switch (p.t) {
    case 'seg':
      return { t: 'seg', a: apply(m, p.a), b: apply(m, p.b) };
    case 'conic':
      return {
        t: 'conic',
        c: apply(m, p.c),
        M: applyVec(m, p.M),
        m: applyVec(m, p.m),
        t0: p.t0,
        t1: p.t1,
      };
    case 'poly':
      return { t: 'poly', pts: p.pts.map((q) => apply(m, q)) };
  }
}

const TAU = Math.PI * 2;

function arcPrim(center: P3, r: number, a0: number, a1: number, o: Mat): Prim {
  return transformPrim(
    { t: 'conic', c: center, M: [r, 0, 0], m: [0, r, 0], t0: a0, t1: a1 },
    o,
  );
}

/** A polyline piece from p to q with a bulge, in OCS. */
function bulgePrim(p: P3, q: P3, bulge: number, o: Mat): Prim {
  if (!bulge || (p[0] === q[0] && p[1] === q[1]))
    return { t: 'seg', a: apply(o, p), b: apply(o, q) };
  const theta = 4 * Math.atan(bulge);
  const s = (1 - bulge * bulge) / (4 * bulge);
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const c: P3 = [(p[0] + q[0]) / 2 - s * dy, (p[1] + q[1]) / 2 + s * dx, p[2]];
  const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
  const t0 = Math.atan2(p[1] - c[1], p[0] - c[0]);
  return transformPrim(
    { t: 'conic', c, M: [r, 0, 0], m: [0, r, 0], t0, t1: t0 + theta },
    o,
  );
}

function polylinePrims(e: Entity): Prim[] {
  const pts = e.pts ?? [];
  if (e.d3) {
    const ps = pts.map((q) => [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0] as P3);
    const out: Prim[] = [];
    for (let i = 0; i + 1 < ps.length; i++)
      out.push({ t: 'seg', a: ps[i] as P3, b: ps[i + 1] as P3 });
    if (e.closed && ps.length > 2)
      out.push({ t: 'seg', a: ps.at(-1) as P3, b: ps[0] as P3 });
    return out;
  }
  const o = ocs(e.n);
  const z = e.elev ?? 0;
  const ps = pts.map(
    (q) =>
      [q[0] ?? 0, q[1] ?? 0, q.length > 2 && !e.elev ? (q[2] ?? 0) : z] as P3,
  );
  const bulges = e.bulges ?? [];
  const out: Prim[] = [];
  const n = ps.length;
  const last = e.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p = ps[i] as P3;
    const q = ps[(i + 1) % n] as P3;
    if (i + 1 === n && p[0] === q[0] && p[1] === q[1]) continue;
    out.push(bulgePrim(p, q, bulges[i] ?? 0, o));
  }
  return out;
}

/** de Boor evaluation of a (possibly rational) B-spline. */
function splinePoint(
  degree: number,
  knots: number[],
  ctrl: P3[],
  weights: number[],
  t: number,
): P3 {
  const n = ctrl.length - 1;
  let k = degree;
  while (k < n && t >= (knots[k + 1] as number)) k++;
  const rational = weights.length === ctrl.length;
  const d: number[][] = [];
  for (let j = 0; j <= degree; j++) {
    const i = Math.min(Math.max(j + k - degree, 0), n);
    const w = rational ? (weights[i] as number) : 1;
    const c = ctrl[i] as P3;
    d.push([c[0] * w, c[1] * w, c[2] * w, w]);
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const lo = knots[i] as number;
      const hi = knots[i + 1 + degree - r] as number;
      const a = hi === lo ? 0 : (t - lo) / (hi - lo);
      const dj = d[j] as number[];
      const dp = d[j - 1] as number[];
      for (let q = 0; q < 4; q++)
        dj[q] = (1 - a) * (dp[q] as number) + a * (dj[q] as number);
    }
  }
  const p = d[degree] as number[];
  const w = (p[3] as number) || 1;
  return [(p[0] as number) / w, (p[1] as number) / w, (p[2] as number) / w];
}

/** Flatten a spline until no chord is farther than `tolerance` from the curve. */
export function flattenSpline(e: Entity, tolerance: number): P3[] {
  const ctrl = e.ctrl ?? [];
  const knots = e.knots ?? [];
  const degree = e.degree ?? 3;
  if (ctrl.length < 2 || knots.length !== ctrl.length + degree + 1)
    return (e.fit ?? []).slice();
  const weights = e.weights ?? [];
  const lo = knots[degree] as number;
  const hi = knots[ctrl.length] as number;
  const at = (t: number) => splinePoint(degree, knots, ctrl, weights, t);
  const out: P3[] = [at(lo)];
  // Start from one piece per knot span, so no span is skipped.
  const spans: number[] = [];
  for (let i = degree; i <= ctrl.length; i++) {
    const k = knots[i] as number;
    if (spans.length === 0 || k > (spans.at(-1) as number)) spans.push(k);
  }
  const split = (t0: number, p0: P3, t1: number, p1: P3, depth: number) => {
    const tm = (t0 + t1) / 2;
    const pm = at(tm);
    const mid: P3 = scale(add(p0, p1), 0.5);
    if (depth < 18 && (dist(pm, mid) > tolerance || depth < 2)) {
      split(t0, p0, tm, pm, depth + 1);
      split(tm, pm, t1, p1, depth + 1);
    } else out.push(p1);
  };
  for (let i = 0; i + 1 < spans.length; i++) {
    const t0 = spans[i] as number;
    const t1 = spans[i + 1] as number;
    split(t0, at(t0), t1, at(t1), 0);
  }
  if (hi === lo) return out;
  return out;
}

/**
 * The primitives of an entity in its owner's coordinates. Kinds without
 * length (text, points, hatches, unknown objects) give none.
 */
export function primsOf(e: Entity, tolerance = 1e-3): Prim[] {
  switch (e.kind) {
    case 'LINE':
      return e.a && e.b ? [{ t: 'seg', a: e.a, b: e.b }] : [];
    case 'ARC': {
      if (!e.c || e.r === undefined) return [];
      let a1 = e.a1 ?? 0;
      const a0 = e.a0 ?? 0;
      while (a1 <= a0) a1 += TAU;
      return [arcPrim(e.c, e.r, a0, a1, ocs(e.n))];
    }
    case 'CIRCLE':
      return e.c && e.r !== undefined
        ? [arcPrim(e.c, e.r, 0, TAU, ocs(e.n))]
        : [];
    case 'ELLIPSE': {
      if (!e.c || !e.major) return [];
      const n = unit(e.n ?? [0, 0, 1]);
      const minor = scale(cross(n, e.major), e.ratio ?? 1);
      let t1 = e.t1 ?? TAU;
      const t0 = e.t0 ?? 0;
      while (t1 <= t0) t1 += TAU;
      return [{ t: 'conic', c: e.c, M: e.major, m: minor, t0, t1 }];
    }
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return polylinePrims(e);
    case 'SPLINE': {
      const pts = flattenSpline(e, tolerance);
      return pts.length > 1 ? [{ t: 'poly', pts }] : [];
    }
    default:
      return [];
  }
}

export function conicPoint(p: Extract<Prim, { t: 'conic' }>, t: number): P3 {
  return add(p.c, add(scale(p.M, Math.cos(t)), scale(p.m, Math.sin(t))));
}

// Gauss-Legendre nodes and weights on [-1, 1], eight points.
const GL_X = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329,
  -0.1834346424956498, 0.1834346424956498, 0.525532409916329,
  0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362,
  0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

/** Length of a conic from t0 to t1: exact for circles, integrated otherwise. */
export function conicLength(
  p: Extract<Prim, { t: 'conic' }>,
  t0 = p.t0,
  t1 = p.t1,
  spatial = false,
): number {
  const a = spatial ? norm(p.M) : Math.hypot(p.M[0], p.M[1]);
  const b = spatial ? norm(p.m) : Math.hypot(p.m[0], p.m[1]);
  const axesDot = spatial ? dot(p.M, p.m) : p.M[0] * p.m[0] + p.M[1] * p.m[1];
  const span = Math.abs(t1 - t0);
  if (
    Math.abs(a - b) <= 1e-12 * Math.max(a, b) &&
    Math.abs(axesDot) <= 1e-12 * a * b
  )
    return a * span;
  // Split at the stationary points of speed. In projection one axis can
  // vanish, producing a reversal where the speed has a cusp.
  const phase = Math.atan2(2 * axesDot, a * a - b * b) / 2;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const step = Math.PI / 2;
  const stops = [lo];
  for (let i = 1; i <= Math.ceil(span / step) + 1; i++) {
    const t = phase + (Math.floor((lo - phase) / step) + i) * step;
    if (t >= hi) break;
    if (t > lo) stops.push(t);
  }
  stops.push(hi);
  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1] as number;
    const to = stops[i] as number;
    const pieces = Math.max(1, Math.ceil((to - from) / (Math.PI / 16)));
    total += integrateConic(p, from, to, pieces, spatial);
  }
  return total;
}

function integrateConic(
  p: Extract<Prim, { t: 'conic' }>,
  t0: number,
  t1: number,
  pieces: number,
  spatial: boolean,
): number {
  const h = (t1 - t0) / pieces;
  let total = 0;
  for (let i = 0; i < pieces; i++) {
    const mid = t0 + h * (i + 0.5);
    for (let k = 0; k < 8; k++) {
      const t = mid + (h / 2) * (GL_X[k] as number);
      const sin = Math.sin(t);
      const cos = Math.cos(t);
      const dx = p.m[0] * cos - p.M[0] * sin;
      const dy = p.m[1] * cos - p.M[1] * sin;
      const speed = spatial
        ? Math.hypot(dx, dy, p.m[2] * cos - p.M[2] * sin)
        : Math.hypot(dx, dy);
      total += (GL_W[k] as number) * speed * (Math.abs(h) / 2);
    }
  }
  return total;
}

function segmentLength(a: P3, b: P3, spatial: boolean): number {
  return spatial ? dist(a, b) : Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function primLength(p: Prim, spatial = false): number {
  switch (p.t) {
    case 'seg':
      return segmentLength(p.a, p.b, spatial);
    case 'conic':
      return conicLength(p, p.t0, p.t1, spatial);
    case 'poly': {
      let s = 0;
      for (let i = 0; i + 1 < p.pts.length; i++)
        s += segmentLength(p.pts[i] as P3, p.pts[i + 1] as P3, spatial);
      return s;
    }
  }
}

export function primEnds(p: Prim): [P3, P3] {
  switch (p.t) {
    case 'seg':
      return [p.a, p.b];
    case 'conic':
      return [conicPoint(p, p.t0), conicPoint(p, p.t1)];
    case 'poly':
      return [p.pts[0] as P3, p.pts.at(-1) as P3];
  }
}

/** The minimum and maximum coordinate on one axis, including conic extrema. */
export function primRange(p: Prim, axis: 0 | 1 | 2): [number, number] {
  if (p.t === 'seg')
    return [Math.min(p.a[axis], p.b[axis]), Math.max(p.a[axis], p.b[axis])];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  if (p.t === 'poly') {
    for (const pt of p.pts) {
      min = Math.min(min, pt[axis]);
      max = Math.max(max, pt[axis]);
    }
    return [min, max];
  }
  const a = p.M[axis];
  const b = p.m[axis];
  const c = p.c[axis];
  if (a === 0 && b === 0) return [c, c];
  const lo = Math.min(p.t0, p.t1);
  const hi = Math.max(p.t0, p.t1);
  const phase = Math.atan2(b, a);
  const radius = Math.hypot(a, b);
  const from = c + a * Math.cos(lo) + b * Math.sin(lo);
  const to = c + a * Math.cos(hi) + b * Math.sin(hi);
  min = Math.min(from, to);
  max = Math.max(from, to);
  if (phase + Math.ceil((lo - phase) / TAU) * TAU <= hi) max = c + radius;
  const trough = phase + Math.PI;
  if (trough + Math.ceil((lo - trough) / TAU) * TAU <= hi) min = c - radius;
  return [min, max];
}

/** Points along a primitive, for pictures and boxes. */
export function primPoints(p: Prim, perTurn = 72): P3[] {
  switch (p.t) {
    case 'seg':
      return [p.a, p.b];
    case 'conic': {
      const n = Math.max(2, Math.ceil((Math.abs(p.t1 - p.t0) / TAU) * perTurn));
      const out: P3[] = [];
      for (let i = 0; i <= n; i++)
        out.push(conicPoint(p, p.t0 + ((p.t1 - p.t0) * i) / n));
      return out;
    }
    case 'poly':
      return p.pts;
  }
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The part of a segment inside a box, in XY, as fractions of its length. */
function clipFraction(a: P3, b: P3, box: Box): number {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: Array<[number, number]> = [
    [-dx, a[0] - box.x0],
    [dx, box.x1 - a[0]],
    [-dy, a[1] - box.y0],
    [dy, box.y1 - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return 0;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return 0;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return 0;
        if (r < t1) t1 = r;
      }
    }
  }
  return Math.max(0, t1 - t0);
}

/** The length of a primitive inside a box (XY), or its whole length without one. */
export function lengthIn(p: Prim, box: Box | null, spatial = false): number {
  if (!box) return primLength(p, spatial);
  switch (p.t) {
    case 'seg':
      return segmentLength(p.a, p.b, spatial) * clipFraction(p.a, p.b, box);
    case 'poly': {
      let s = 0;
      for (let i = 0; i + 1 < p.pts.length; i++) {
        const a = p.pts[i] as P3;
        const b = p.pts[i + 1] as P3;
        s += segmentLength(a, b, spatial) * clipFraction(a, b, box);
      }
      return s;
    }
    case 'conic': {
      const n = Math.max(
        64,
        Math.ceil(Math.abs(p.t1 - p.t0) / (Math.PI / 720)),
      );
      const h = (p.t1 - p.t0) / n;
      let s = 0;
      for (let i = 0; i < n; i++) {
        const ta = p.t0 + h * i;
        const tb = ta + h;
        const f = clipFraction(conicPoint(p, ta), conicPoint(p, tb), box);
        if (f > 0) s += f * conicLength(p, ta, tb, spatial);
      }
      return s;
    }
  }
}

export function inBox(box: Box, x: number, y: number): boolean {
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}

/** Distance in XY from a point to a primitive. */
export function distanceTo(p: Prim, x: number, y: number): number {
  const pts = p.t === 'seg' ? [p.a, p.b] : primPoints(p, 360);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as P3;
    const b = pts[i + 1] as P3;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2
      ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2))
      : 0;
    const d = Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
    if (d < best) best = d;
  }
  return best;
}

/** The direction of a primitive nearest a point, as an angle in XY. */
export function directionNear(p: Prim, x: number, y: number): number {
  const pts = p.t === 'seg' ? [p.a, p.b] : primPoints(p, 360);
  let best = Number.POSITIVE_INFINITY;
  let angle = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as P3;
    const b = pts[i + 1] as P3;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const d = Math.hypot(mx - x, my - y);
    if (d < best) {
      best = d;
      angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return angle;
}
