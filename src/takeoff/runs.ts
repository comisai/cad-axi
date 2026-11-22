// Runs: pieces of one group joined end to end (design §8.4). Two pieces join
// where their ends lie within the gap. A run never crosses a junction: where
// three or more ends meet, each branch is its own run.

import type { P3 } from '../model/drawing.ts';
import { primEnds } from '../model/geometry.ts';
import type { Piece } from './lengths.ts';

export interface Run {
  /** 1-based, in the order runs are found. */
  id: number;
  group: string;
  pieces: Piece[];
  /** Drawing units. */
  length: number;
  /** The two free ends, or null for a closed loop. */
  ends: [P3, P3] | null;
  /** The part of the length that lies inside block inserts. */
  inBlocks: number;
}

interface Node {
  p: P3;
  edges: number[];
}

/** Ends of a piece: the start of its first primitive and the end of its last. */
function endsOf(piece: Piece): [P3, P3] | null {
  const first = piece.prims[0];
  const last = piece.prims.at(-1);
  if (!first || !last) return null;
  const a = primEnds(first)[0];
  const b = primEnds(last)[1];
  return [a, b];
}

export function findRuns(
  groups: ReadonlyArray<{ name: string; pieces: Piece[] }>,
  gap: number,
): Run[] {
  const runs: Run[] = [];
  for (const group of groups) {
    const nodes: Node[] = [];
    const grid = new Map<string, number[]>();
    const cell = Math.max(gap, 1e-9);
    const key = (x: number, y: number) =>
      `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const nodeAt = (p: P3): number => {
      const cx = Math.floor(p[0] / cell);
      const cy = Math.floor(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            const q = (nodes[i] as Node).p;
            if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= gap) return i;
          }
      nodes.push({ p, edges: [] });
      const k = key(p[0], p[1]);
      const list = grid.get(k);
      if (list) list.push(nodes.length - 1);
      else grid.set(k, [nodes.length - 1]);
      return nodes.length - 1;
    };
    const edges: Array<{ piece: Piece; a: number; b: number } | null> = [];
    const closed: Piece[] = [];
    for (const piece of group.pieces) {
      const ends = endsOf(piece);
      if (!ends) continue;
      const [a, b] = ends;
      if (
        Math.hypot(a[0] - b[0], a[1] - b[1]) <= gap &&
        piece.prims.length > 0 &&
        piece.length > gap * 2
      ) {
        closed.push(piece);
        continue;
      }
      const ia = nodeAt(a);
      const ib = nodeAt(b);
      edges.push({ piece, a: ia, b: ib });
      (nodes[ia] as Node).edges.push(edges.length - 1);
      if (ib !== ia) (nodes[ib] as Node).edges.push(edges.length - 1);
    }
    const used = new Set<number>();
    const make = (list: Piece[], ends: [P3, P3] | null) => {
      let length = 0;
      let inBlocks = 0;
      for (const p of list) {
        length += p.length;
        if (p.item.depth > 0) inBlocks += p.length;
      }
      runs.push({
        id: runs.length + 1,
        group: group.name,
        pieces: list,
        length,
        ends,
        inBlocks,
      });
    };
    const other = (e: { a: number; b: number }, n: number) =>
      e.a === n ? e.b : e.a;
    // Walk from every node that is not a pass-through: free ends and junctions.
    nodes.forEach((node, start) => {
      if (node.edges.length === 2) return;
      for (const first of node.edges) {
        if (used.has(first)) continue;
        const list: Piece[] = [];
        let edge = first;
        let at = start;
        for (;;) {
          used.add(edge);
          const e = edges[edge] as { piece: Piece; a: number; b: number };
          list.push(e.piece);
          at = other(e, at);
          const n = nodes[at] as Node;
          if (n.edges.length !== 2) break;
          const next = n.edges.find((x) => x !== edge && !used.has(x));
          if (next === undefined) break;
          edge = next;
        }
        make(list, [node.p, (nodes[at] as Node).p]);
      }
    });
    // What is left is loops of pass-through nodes.
    edges.forEach((e, i) => {
      if (!e || used.has(i)) return;
      const list: Piece[] = [];
      let edge = i;
      let at = e.a;
      for (;;) {
        used.add(edge);
        const cur = edges[edge] as { piece: Piece; a: number; b: number };
        list.push(cur.piece);
        at = other(cur, at);
        const next = (nodes[at] as Node).edges.find((x) => !used.has(x));
        if (next === undefined) break;
        edge = next;
      }
      make(list, null);
    });
    for (const piece of closed) make([piece], null);
  }
  return runs;
}
