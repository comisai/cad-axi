// A bounding volume hierarchy over primitives, including very long curves
// that would occupy many cells in a uniform grid.

import { type Box, type Prim, primRange } from '../model/geometry.ts';
import type { Run } from './runs.ts';

interface Entry extends Box {
  run: number;
  order: number;
  prim: Prim;
}

type Node = Box & ({ entries: Entry[] } | { left: Node; right: Node });

function build(entries: Entry[]): Node {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    x0 = Math.min(x0, e.x0);
    y0 = Math.min(y0, e.y0);
    x1 = Math.max(x1, e.x1);
    y1 = Math.max(y1, e.y1);
  }
  const box = { x0, y0, x1, y1 };
  if (entries.length <= 12) return { ...box, entries };
  const byX = x1 - x0 >= y1 - y0;
  entries.sort((a, b) =>
    byX
      ? a.x0 / 2 + a.x1 / 2 - (b.x0 / 2 + b.x1 / 2)
      : a.y0 / 2 + a.y1 / 2 - (b.y0 / 2 + b.y1 / 2),
  );
  const mid = entries.length >>> 1;
  return {
    ...box,
    left: build(entries.slice(0, mid)),
    right: build(entries.slice(mid)),
  };
}

function intersects(a: Box, b: Box): boolean {
  return !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
}

/** Visit primitives whose boxes overlap the label's reach in XY. */
export function indexRuns(
  runs: readonly Run[],
): (box: Box, visit: (entry: Entry) => void) => void {
  const entries: Entry[] = [];
  runs.forEach((run, i) => {
    let order = 0;
    for (const piece of run.pieces)
      for (const prim of piece.prims) {
        const [x0, x1] = primRange(prim, 0);
        const [y0, y1] = primRange(prim, 1);
        // Leave room for rounding in the conic evaluation and query bounds.
        const pad =
          8 *
          Number.EPSILON *
          Math.max(1, Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1));
        entries.push({
          x0: x0 - pad,
          x1: x1 + pad,
          y0: y0 - pad,
          y1: y1 + pad,
          run: i,
          order: order++,
          prim,
        });
      }
  });
  const root = build(entries);
  const search = (node: Node, box: Box, visit: (entry: Entry) => void) => {
    if (!intersects(node, box)) return;
    if ('entries' in node) {
      for (const entry of node.entries)
        if (intersects(entry, box)) visit(entry);
    } else {
      search(node.left, box, visit);
      search(node.right, box, visit);
    }
  };
  return (box, visit) => search(root, box, visit);
}
