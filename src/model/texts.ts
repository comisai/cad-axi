// Every text a space shows: TEXT, MTEXT and the attribute values of block
// inserts, with inserts opened, each placed in world coordinates and decoded
// beside its stored form.

import type { Attrib, Drawing, Entity, P3 } from './drawing.ts';
import { apply, applyVec, type Mat, norm, ocs, then } from './geometry.ts';
import { type Decoded, decodeText, keyboardStyles } from './text.ts';
import { walk } from './world.ts';

export interface TextItem {
  h: string;
  kind: 'TEXT' | 'MTEXT' | 'ATTRIB';
  layer: string;
  tag: string | null;
  /** The innermost block it lies in, or null. */
  block: string | null;
  raw: string;
  text: string;
  decoded: Decoded;
  at: P3;
  height: number;
  rotation: number;
  style: string;
  backwards: boolean;
  hidden: boolean;
  depth: number;
}

function place(
  m: Mat,
  local: Mat,
  at: P3,
  height: number,
  rotation: number,
): { at: P3; height: number; rotation: number } {
  const full = then(local, m);
  const p = apply(full, at);
  const dir = applyVec(full, [Math.cos(rotation), Math.sin(rotation), 0]);
  const up = applyVec(full, [-Math.sin(rotation), Math.cos(rotation), 0]);
  return {
    at: p,
    height: height * norm(up),
    rotation: Math.atan2(dir[1], dir[0]),
  };
}

export function collectTexts(
  d: Drawing,
  owners: readonly string[],
): TextItem[] {
  // Which styles write Hebrew on Latin keys, decided over the whole drawing.
  const samples: Array<{ style: string; raw: string }> = [];
  for (const e of d.entities) {
    if ((e.kind === 'TEXT' || e.kind === 'ATTDEF') && e.raw)
      samples.push({ style: e.style ?? '', raw: e.raw });
    for (const a of e.attribs ?? [])
      samples.push({ style: a.style, raw: a.raw });
  }
  const keyboard = keyboardStyles(d.styles, samples);
  const backwardsStyle = new Set(
    d.styles.filter((s) => s.backwards).map((s) => s.name),
  );
  const out: TextItem[] = [];
  const add = (
    e: Entity | Attrib,
    kind: TextItem['kind'],
    m: Mat,
    layer: string,
    block: string | null,
    hidden: boolean,
    depth: number,
  ) => {
    const raw = e.raw ?? '';
    const style = e.style ?? '';
    const view = decodeText(
      raw,
      kind === 'MTEXT',
      kind !== 'MTEXT' && keyboard.has(style),
    );
    // MTEXT is placed in world coordinates; TEXT and attributes in their OCS.
    const local = kind === 'MTEXT' ? ocs(undefined) : ocs(e.n);
    const placed = place(
      m,
      local,
      e.at ?? [0, 0, 0],
      e.height ?? 0,
      e.rot ?? 0,
    );
    out.push({
      h: e.h,
      kind,
      layer,
      tag: 'tag' in e && e.tag ? e.tag : null,
      block,
      raw,
      text: view.text,
      decoded: view.decoded,
      at: placed.at,
      height: placed.height,
      rotation: placed.rotation,
      style,
      backwards: e.backwards === true || backwardsStyle.has(style),
      hidden,
      depth,
    });
  };
  for (const item of walk(d, owners)) {
    const e = item.e;
    if (e.kind === 'TEXT' || e.kind === 'MTEXT')
      add(e, e.kind, item.m, item.layer, item.block, item.hidden, item.depth);
    else if (e.kind === 'INSERT')
      for (const a of e.attribs ?? []) {
        const layer = item.depth > 0 && a.layer === '0' ? item.layer : a.layer;
        add(
          a,
          'ATTRIB',
          item.m,
          layer,
          e.block ?? null,
          item.hidden,
          item.depth,
        );
      }
  }
  return out;
}
