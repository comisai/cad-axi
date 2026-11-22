// A space's entities in world coordinates, with block inserts opened: each
// entity inside a block is visited once per insert, through nested blocks to
// a depth of 16, with the layer, colour and linetype AutoCAD would draw it
// with (layer 0 and "by block" take the insert's).

import { AxiError } from '../errors.ts';
import type { Drawing, Entity, Layer } from './drawing.ts';
import { IDENTITY, insertMatrix, type Mat, then } from './geometry.ts';

export const MAX_DEPTH = 16;
/** Entities visited in one walk, inserts opened. */
export const MAX_VISITS = 5_000_000;

export interface WorldItem {
  e: Entity;
  /** Owner coordinates to world coordinates. */
  m: Mat;
  layer: string;
  linetype: string;
  color: number;
  /** 0 for an entity of the space itself. */
  depth: number;
  /** The handle of the space's insert this entity lies in, or null. */
  insert: string | null;
  /** The innermost block it lies in, or null. */
  block: string | null;
  /** On a layer that is off or frozen, or inside an insert on a frozen layer. */
  hidden: boolean;
}

export interface WalkOptions {
  /** Open the drawing blocks of dimensions too (for pictures). */
  dimensions?: boolean;
}

export function layerMap(d: Drawing): Map<string, Layer> {
  return new Map(d.layers.map((l) => [l.name, l]));
}

export function* walk(
  d: Drawing,
  owners: readonly string[],
  options: WalkOptions = {},
): Generator<WorldItem> {
  const layers = layerMap(d);
  let visits = 0;
  const off = (name: string) => {
    const l = layers.get(name);
    return l ? !l.on || l.frozen : false;
  };
  const frozen = (name: string) => layers.get(name)?.frozen === true;

  function* inside(
    list: readonly Entity[],
    m: Mat,
    parent: {
      layer: string;
      linetype: string;
      color: number;
      frozen: boolean;
    } | null,
    depth: number,
    insert: string | null,
    block: string | null,
    stack: Set<string>,
  ): Generator<WorldItem> {
    for (const e of list) {
      if (++visits > MAX_VISITS)
        throw new AxiError(
          'too_large',
          'The drawing opens into more entities than this tool reads at once, through its block inserts. Read one region or one layer.',
        );
      const layer = parent && e.layer === '0' ? parent.layer : e.layer;
      const layerInfo = layers.get(layer);
      const linetype =
        e.lt === 'ByBlock' && parent
          ? parent.linetype
          : e.lt === 'ByLayer' || e.lt === 'ByBlock'
            ? (layerInfo?.linetype ?? 'Continuous')
            : e.lt;
      const color =
        e.color === 0 && parent
          ? parent.color
          : e.color === 256
            ? (layerInfo?.color ?? 7)
            : e.color;
      const hidden = off(layer) || (parent?.frozen ?? false);
      yield { e, m, layer, linetype, color, depth, insert, block, hidden };
      const name =
        e.kind === 'INSERT'
          ? e.block
          : e.kind === 'DIMENSION' && options.dimensions
            ? e.block
            : undefined;
      if (!name) continue;
      const def = d.blocks.get(name);
      if (
        !def ||
        def.external ||
        def.layout ||
        depth >= MAX_DEPTH ||
        stack.has(name)
      )
        continue;
      const children = d.byOwner.get(name) ?? [];
      if (!children.length) continue;
      const next = new Set(stack).add(name);
      const own = {
        layer,
        linetype,
        color,
        frozen: (parent?.frozen ?? false) || frozen(layer),
      };
      const top = insert ?? e.h;
      if (e.kind === 'DIMENSION') {
        yield* inside(children, m, own, depth + 1, top, name, next);
        continue;
      }
      const cols = Math.max(1, e.cols ?? 1);
      const rows = Math.max(1, e.rows ?? 1);
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++)
          yield* inside(
            children,
            then(insertMatrix(e, def.base, c, r), m),
            own,
            depth + 1,
            top,
            name,
            next,
          );
    }
  }

  for (const owner of owners)
    yield* inside(
      d.byOwner.get(owner) ?? [],
      IDENTITY,
      null,
      0,
      null,
      null,
      new Set([owner]),
    );
}
