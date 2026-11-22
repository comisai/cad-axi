// Whether a drawing can be re-saved at all (design §8.8, step 1). An edit or
// a conversion proceeds only when every entity kind, class and object type
// in the file is on the verified list: kinds and types that the write matrix
// has shown survive a round trip through the engine. Everything else stops
// the write with `would_lose`, naming what would be lost. The lists grow
// only with evidence (test/write).

import type { Drawing } from '../model/drawing.ts';

// Measured on ACadSharp's sample drawings, made by AutoCAD in every version
// from R14 to 2018, each converted to 2018 and 2004 and compared entity by
// entity (docs/write-matrix.md). A kind is on the list only when it came
// through unchanged in every file AND the engine reads all of its content,
// so that the verify step would see a loss. Kinds that came through but
// whose content the engine does not read (3D solids, meshes, regions,
// dimensions, hatches, multileaders, tables) stay off: their survival is not
// proved. Splines and tables changed or were lost, and stay off.

/** Entity kinds the write matrix carries without loss. */
export const VERIFIED_KINDS: ReadonlySet<string> = new Set([
  'LINE',
  'ARC',
  'CIRCLE',
  'ELLIPSE',
  'LWPOLYLINE',
  'POINT',
  'TEXT',
  'MTEXT',
  'ATTDEF',
  'INSERT',
  'SOLID',
  '3DFACE',
  'VIEWPORT',
]);

/**
 * Classes whose objects the writer models itself: those it writes into every
 * new drawing. Visual styles and xrecords from AutoCAD's files were lost in
 * the matrix, and stay off.
 */
export const VERIFIED_CLASSES: ReadonlySet<string> = new Set([
  'ACDBDICTIONARYWDFLT',
  'ACDBPLACEHOLDER',
  'DICTIONARYVAR',
  'LAYOUT',
  'MATERIAL',
  'MLEADERSTYLE',
  'SCALE',
  'TABLESTYLE',
]);

/** Non-graphical object types the writer models itself. */
export const VERIFIED_OBJECTS: ReadonlySet<string> = new Set([
  'ACDBDICTIONARYWDFLT',
  'ACDBPLACEHOLDER',
  'DICTIONARY',
  'DICTIONARYVAR',
  'LAYOUT',
  'MATERIAL',
  'MLEADERSTYLE',
  'MLINESTYLE',
  'SCALE',
  'TABLESTYLE',
]);

export interface Loss {
  name: string;
  count: number;
  what: 'entity' | 'class' | 'object';
}

export interface Preflight {
  editable: boolean;
  reason: string;
  losses: Loss[];
}

/**
 * The DXF writer does not carry materials (measured: they are missing when
 * the DXF is read again), so a DXF copy of a drawing that has them is refused.
 */
export function preflight(
  d: Drawing,
  format: 'dwg' | 'dxf' = 'dwg',
): Preflight {
  const losses: Loss[] = [];
  if (format === 'dxf')
    for (const o of d.objects)
      if (o.name === 'MATERIAL' && o.count > 0)
        losses.push({
          name: 'MATERIAL (in DXF)',
          count: o.count,
          what: 'object',
        });
  for (const [kind, count] of d.kinds)
    if (!VERIFIED_KINDS.has(kind))
      losses.push({ name: kind, count, what: 'entity' });
  // An entity class is judged by its entities' kind above.
  for (const c of d.classes)
    if (c.instances > 0 && !c.entity && !VERIFIED_CLASSES.has(c.name))
      losses.push({ name: c.name, count: c.instances, what: 'class' });
  for (const o of d.objects)
    if (o.unknown || !VERIFIED_OBJECTS.has(o.name))
      losses.push({ name: o.name, count: o.count, what: 'object' });
  const seen = new Set<string>();
  const unique = losses.filter((l) => {
    const k = l.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (!unique.length)
    return {
      editable: true,
      reason: 'every entity kind and object type in it is on the verified list',
      losses: [],
    };
  const named = unique
    .slice(0, 4)
    .map((l) => `${l.name} (${l.count})`)
    .join(', ');
  return {
    editable: false,
    reason: `it holds ${unique.length} kind${unique.length === 1 ? '' : 's'} the writer is not verified to keep: ${named}${unique.length > 4 ? ', …' : ''}; draw changes as an overlay with \`create --like\``,
    losses: unique,
  };
}
