// `layers`, `blocks`, `texts` and `query`: what a drawing holds, by name.

import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import type { Entity } from '../model/drawing.ts';
import { apply, lengthIn, ocs, primLength } from '../model/geometry.ts';
import { collectTexts, type TextItem } from '../model/texts.ts';
import { metres, unitsOf } from '../model/units.ts';
import { walk } from '../model/world.ts';
import { listOutput, type Row } from '../output/views.ts';
import { CURVES, piecesOf, worldPrims } from '../takeoff/lengths.ts';
import {
  at,
  layerState,
  list,
  load,
  pickLayer,
  positiveInt,
  regionOf,
  round,
  save,
  spaceOf,
  str,
} from './common.ts';

function fileArg(input: CommandInput): string {
  const file = input.positionals[0];
  if (!file) throw usage('Missing <file>.');
  return file;
}

/** A case-insensitive pattern from --match, bounded so it cannot run away. */
function matcher(input: CommandInput): RegExp | null {
  const m = str(input.values, 'match');
  if (m === undefined) return null;
  if ([...m].length > 200) throw usage('--match is limited to 200 characters.');
  try {
    return new RegExp(m, 'iu');
  } catch {
    throw usage('--match is not a valid regular expression.');
  }
}

export async function layers(input: CommandInput): Promise<string> {
  const { drawing: d } = await load(input, fileArg(input), true);
  const units = unitsOf(d.header.insunits, str(input.values, 'units'));
  const { owners, name: space } = spaceOf(d, input.values);
  const region = regionOf(input.values);
  const match = str(input.values, 'match')?.toLowerCase();
  const { pieces } = piecesOf(d, owners, region, { all: true });
  const length = new Map<string, number>();
  for (const p of pieces)
    length.set(p.item.layer, (length.get(p.item.layer) ?? 0) + p.length);
  const all = d.layers
    .filter((l) => match === undefined || l.name.toLowerCase().includes(match))
    .map((l) => {
      const raw = length.get(l.name) ?? 0;
      return {
        name: l.name,
        state: layerState(l),
        color: l.rgb ?? l.color,
        entities: l.entities,
        length:
          units.metres === null ? round(raw, 3) : metres(raw * units.metres),
        linetype: l.linetype,
      };
    })
    .sort(
      (a, b) =>
        b.length - a.length ||
        b.entities - a.entities ||
        a.name.localeCompare(b.name),
    );
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const shown = full ? all : all.slice(0, limit);
  const saved = save(input.io, str(input.values, 'save'), { layers: all });
  const unit =
    units.metres === null
      ? 'drawing units (the file states none)'
      : `metres, from ${units.name} (${units.basis === 'file' ? 'stated by the file' : 'given'})`;
  return listOutput({
    key: 'layers',
    summary: all.length
      ? `${shown.length} of ${all.length} layers`
      : `0 layers match; the drawing has ${d.layers.length}`,
    head: {
      space,
      lengths: unit,
      ...(region ? { region: str(input.values, 'region') } : {}),
      ...(saved ? { saved } : {}),
    },
    rows: shown,
    columns: full
      ? ['name', 'state', 'color', 'entities', 'length', 'linetype']
      : ['name', 'state', 'color', 'entities', 'length'],
    help: all.length
      ? [
          'Run `cad-axi measure <file> --layer <layer>` for lengths with what is in blocks shown apart',
          'Run `cad-axi texts <file> --layer <layer>` for the text on one layer',
        ]
      : ['Run `cad-axi layers <file>` without --match for every layer'],
    full,
    narrower: '--match or --limit',
  });
}

export async function blocks(input: CommandInput): Promise<string> {
  const { drawing: d } = await load(input, fileArg(input), true);
  const inserts = new Map<string, number>();
  for (const e of d.entities)
    if (e.kind === 'INSERT' && e.block)
      inserts.set(e.block, (inserts.get(e.block) ?? 0) + 1);
  const withAll = input.values.all === true;
  const match = str(input.values, 'match')?.toLowerCase();
  const rows = [...d.blocks.values()]
    .filter((b) => !b.layout && (withAll || !b.anonymous))
    .filter((b) => match === undefined || b.name.toLowerCase().includes(match))
    .map((b) => ({
      name: b.name,
      kind: b.external
        ? b.overlay
          ? 'xref overlay'
          : 'xref'
        : b.anonymous
          ? 'anonymous'
          : 'block',
      inserts: inserts.get(b.name) ?? 0,
      entities: b.entities,
      attributes: b.attributes.join(', ') || null,
    }))
    .sort((a, b) => b.inserts - a.inserts || a.name.localeCompare(b.name));
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const shown = full ? rows : rows.slice(0, limit);
  const saved = save(input.io, str(input.values, 'save'), { blocks: rows });
  return listOutput({
    key: 'blocks',
    summary: rows.length
      ? `${shown.length} of ${rows.length} blocks`
      : '0 blocks',
    head: saved ? { saved } : {},
    rows: shown,
    columns: ['name', 'kind', 'inserts', 'entities', 'attributes'],
    help: rows.length
      ? [
          'Run `cad-axi query <file> --block <name>` for where one block is inserted',
          'Run `cad-axi texts <file> --match <tag value>` for attribute values',
        ]
      : ['Run `cad-axi blocks <file> --all` to include anonymous blocks'],
    full,
    narrower: '--match or --limit',
  });
}

export async function texts(input: CommandInput): Promise<string> {
  const { drawing: d } = await load(input, fileArg(input), true);
  const { owners, name: space } = spaceOf(d, input.values, true);
  const region = regionOf(input.values);
  const wanted = new Set(
    list(input.values, 'layer').map((l) => pickLayer(d, l)),
  );
  const match = matcher(input);
  const items = collectTexts(d, owners).filter(
    (t) =>
      (!wanted.size || wanted.has(t.layer)) &&
      (!region ||
        (t.at[0] >= region.x0 &&
          t.at[0] <= region.x1 &&
          t.at[1] >= region.y0 &&
          t.at[1] <= region.y1)) &&
      (!match || match.test(t.text) || match.test(t.raw)) &&
      t.text !== '',
  );
  const full = input.values.full === true;
  const limit = positiveInt(input.values, 'limit', 20);
  const shown = full ? items : items.slice(0, limit);
  const styles = new Map(d.styles.map((s) => [s.name, s]));
  const row = (t: TextItem): Row => ({
    h: t.h,
    layer: t.layer,
    text: t.text,
    at: at(t.at),
    block: t.tag ? `${t.block ?? 'attribute'}: ${t.tag}` : t.block,
    ...(full
      ? {
          kind: t.kind,
          raw: t.raw,
          height: round(t.height, 3),
          style: t.style,
          font: styles.get(t.style)?.font ?? null,
          font_kind: styles.get(t.style)?.kind ?? null,
          backwards: t.backwards ? 'yes' : null,
          decoded: t.decoded,
        }
      : {}),
  });
  const saved = save(input.io, str(input.values, 'save'), {
    texts: items.map((t) => ({ ...t, at: t.at })),
  });
  const keyboard = items.filter((t) => t.decoded === 'keyboard').length;
  return listOutput({
    key: 'texts',
    summary: items.length
      ? `${shown.length} of ${items.length} texts`
      : '0 texts match',
    head: {
      space,
      ...(keyboard
        ? {
            note: `${keyboard} texts were typed on Latin keys for a Hebrew stroke font and are shown decoded; --full shows each as stored`,
          }
        : {}),
      ...(saved ? { saved } : {}),
    },
    rows: shown.map(row),
    columns: full
      ? [
          'h',
          'layer',
          'text',
          'at',
          'block',
          'kind',
          'raw',
          'height',
          'style',
          'font',
          'font_kind',
          'backwards',
          'decoded',
        ]
      : ['h', 'layer', 'text', 'at', 'block'],
    help: items.length
      ? [
          'Run `cad-axi texts <file> --match <regex>` to find one label',
          'Run `cad-axi texts <file> --full` for each text as stored, with its style and font',
        ]
      : [
          'Run `cad-axi texts <file> --space all` to include paper space layouts',
          'Run `cad-axi texts <file>` without filters for every text',
        ],
    full,
    narrower: '--layer, --match, --region or --limit',
  });
}

/** One place to show for an entity: its start, centre or insert point. */
function anchor(e: Entity): readonly number[] | undefined {
  if (e.a) return e.a;
  if (e.c) return e.c;
  if (e.at)
    return e.kind === 'TEXT' || e.kind === 'ATTDEF'
      ? apply(ocs(e.n), e.at)
      : e.at;
  const p = e.pts?.[0];
  if (p) return [p[0] ?? 0, p[1] ?? 0];
  return undefined;
}

function detail(e: Entity, length: number | null): string | null {
  if (length !== null && e.kind !== 'CIRCLE')
    return `length ${round(length, 3)}`;
  if (e.kind === 'CIRCLE' && e.r !== undefined)
    return `radius ${round(e.r, 3)}`;
  if (e.kind === 'INSERT')
    return `block ${e.block ?? ''}${e.attribs?.length ? `, ${e.attribs.length} attributes` : ''}`;
  if (e.raw !== undefined) return [...e.raw].slice(0, 40).join('');
  if (e.unknown || e.proxy)
    return 'not read: an object this engine does not model';
  return null;
}

export async function query(input: CommandInput): Promise<string> {
  const { drawing: d } = await load(input, fileArg(input), true);
  const { owners, name: space } = spaceOf(d, input.values, true);
  const region = regionOf(input.values);
  const types = new Set(list(input.values, 'type').map((t) => t.toUpperCase()));
  const wanted = new Set(
    list(input.values, 'layer').map((l) => pickLayer(d, l)),
  );
  const blocks = list(input.values, 'block');
  for (const b of blocks)
    if (!d.blocks.has(b))
      throw new AxiError(
        'unknown_block',
        'The drawing defines no block by that name. Run `cad-axi blocks <file>` for the names.',
      );
  const handles = new Set(
    list(input.values, 'handle').map((h) => h.toUpperCase()),
  );
  for (const h of handles)
    if (!/^[0-9A-F]{1,16}$/.test(h))
      throw usage('--handle takes a hexadecimal handle, as `query` prints it.');
  const rows: Row[] = [];
  for (const item of walk(d, owners)) {
    if (item.depth > 0) continue;
    const e = item.e;
    if (types.size && !types.has(e.kind)) continue;
    if (wanted.size && !wanted.has(e.layer)) continue;
    if (
      blocks.length &&
      !(e.kind === 'INSERT' && e.block && blocks.includes(e.block))
    )
      continue;
    if (handles.size && !handles.has(e.h)) continue;
    const prims = CURVES.has(e.kind) ? worldPrims(item) : [];
    const length = prims.length
      ? prims.reduce((s, p) => s + primLength(p), 0)
      : null;
    const p = anchor(e);
    if (region) {
      const inside =
        p &&
        p[0] !== undefined &&
        p[1] !== undefined &&
        p[0] >= region.x0 &&
        p[0] <= region.x1 &&
        p[1] >= region.y0 &&
        p[1] <= region.y1;
      const crosses = prims.some((q) => lengthIn(q, region) > 0);
      if (!inside && !crosses) continue;
    }
    rows.push({
      h: e.h,
      kind: e.kind,
      layer: e.layer,
      at: at(p),
      detail: detail(e, length),
    });
  }
  for (const h of handles)
    if (!rows.some((r) => r.h === h))
      throw new AxiError(
        'unknown_handle',
        'No entity of that space has that handle. Run `cad-axi query <file>` for handles.',
      );
  const full = input.values.full === true;
  const limit = positiveInt(input.values, 'limit', 20);
  const shown = full ? rows : rows.slice(0, limit);
  const saved = save(input.io, str(input.values, 'save'), { entities: rows });
  return listOutput({
    key: 'entities',
    summary: rows.length
      ? `${shown.length} of ${rows.length} entities`
      : '0 entities match',
    head: { space, ...(saved ? { saved } : {}) },
    rows: shown,
    columns: ['h', 'kind', 'layer', 'at', 'detail'],
    help: rows.length
      ? [
          'Run `cad-axi query <file> --handle <h>` for one entity',
          'Name handles from here in an `edit` operations file',
        ]
      : [
          'Run `cad-axi query <file>` without filters for every entity of the space',
          'Run `cad-axi info <file>` for the entity kinds it holds',
        ],
    full,
    narrower: '--type, --layer, --region or --limit',
  });
}
