// `layers`, `blocks`, `texts` and `query`: what a drawing holds, by name.

import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import {
  type Drawing,
  type Entity,
  layoutOf,
  type P3,
} from '../model/drawing.ts';
import {
  apply,
  type Box,
  lengthIn,
  ocs,
  primLength,
} from '../model/geometry.ts';
import { collectTexts, type TextItem } from '../model/texts.ts';
import { insertScale, viewportScale } from '../model/unit-evidence.ts';
import { metres, unitsOf } from '../model/units.ts';
import { walk } from '../model/world.ts';
import { listOutput, type Row } from '../output/views.ts';
import {
  CURVES,
  elevationFields,
  elevationOf,
  lengthMode,
  piecesOf,
  worldPrims,
} from '../takeoff/lengths.ts';
import {
  at,
  layerState,
  list,
  load,
  parseBox,
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
  const selectedLayers = d.layers.filter(
    (l) => match === undefined || l.name.toLowerCase().includes(match),
  );
  const spatial = input.values['3d'] === true;
  const { pieces, elevation } = piecesOf(d, owners, region, {
    all: true,
    spatial,
    ...(match === undefined
      ? {}
      : { layers: new Set(selectedLayers.map((l) => l.name)) }),
  });
  const length = new Map<string, number>();
  for (const p of pieces)
    length.set(p.item.layer, (length.get(p.item.layer) ?? 0) + p.length);
  const all = selectedLayers
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
  const geometry = {
    length_mode: lengthMode(spatial),
    ...elevationFields(elevation),
  };
  const saved = save(input.io, str(input.values, 'save'), {
    ...geometry,
    layers: all,
  });
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
      ...geometry,
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
      ...(b.external
        ? { file: b.xref_file ?? null, folder: b.xref_folder ?? null }
        : {}),
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
    columns: [
      'name',
      'kind',
      'inserts',
      'entities',
      'attributes',
      ...(full && shown.some((row) => 'file' in row) ? ['file', 'folder'] : []),
    ],
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
  const dos = items.filter((t) => t.decoded === 'dos-hebrew').length;
  const notes = [
    keyboard
      ? `${keyboard} texts were typed on Latin keys for a Hebrew stroke font and are shown decoded`
      : '',
    dos ? `${dos} texts were decoded as DOS Hebrew` : '',
  ].filter(Boolean);
  return listOutput({
    key: 'texts',
    summary: items.length
      ? `${shown.length} of ${items.length} texts`
      : '0 texts match',
    head: {
      space,
      ...(notes.length
        ? {
            note: `${notes.join('. ')}. Use --full to see the raw text and decoding rule.`,
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
    return e.kind === 'TEXT' || e.kind === 'ATTDEF' || e.kind === 'INSERT'
      ? apply(ocs(e.n), e.at)
      : e.at;
  const p = e.pts?.[0];
  if (p) return [p[0] ?? 0, p[1] ?? 0];
  return undefined;
}

function detail(
  d: Drawing,
  e: Entity,
  length: number | null,
  z: string,
  scale: P3 | undefined,
): string | null {
  if (length !== null && e.kind !== 'CIRCLE')
    return `length ${round(length, 3)}${z}`;
  if (e.kind === 'CIRCLE' && e.r !== undefined)
    return `radius ${round(e.r, 3)}${z}`;
  if (e.kind === 'INSERT') {
    const block = e.block ? d.blocks.get(e.block) : undefined;
    const units = unitsOf(block?.units ?? 0, undefined).name ?? 'not stated';
    return [
      ...(scale ? [`scale ${scale.join(',')}`] : []),
      `block ${e.block ?? ''}`,
      ...(block?.external ? [`reference units ${units}`] : []),
      ...(e.attribs?.length ? [`${e.attribs.length} attributes`] : []),
    ].join(', ');
  }
  if (e.kind === 'DIMENSION') {
    const m = e.measurement;
    return [
      m === undefined
        ? 'measurement unavailable'
        : e.measurement_kind === 'length'
          ? `drawn ${round(m, 6)}`
          : `measurement ${round(m, 6)}${e.measurement_kind === 'angle' ? ' rad' : ''}`,
      ...(e.dimension_factor === undefined
        ? []
        : [`display factor ${e.dimension_factor}`]),
      ...(e.dimension_suffix ? [`style suffix ${e.dimension_suffix}`] : []),
      `text ${e.text || '<>'}`,
    ].join(', ');
  }
  if (e.kind === 'VIEWPORT') {
    const ratio = viewportScale(e);
    const layout = layoutOf(d, e.owner);
    return [
      ...(layout ? [layout] : []),
      ...(e.w !== undefined && e.ht !== undefined
        ? [`paper ${e.w} × ${e.ht}`]
        : []),
      ...(e.view_height === undefined ? [] : [`view height ${e.view_height}`]),
      ...(ratio === undefined
        ? []
        : [`paper/model ${Number(ratio.toPrecision(8))}`]),
    ].join(', ');
  }
  if (e.raw !== undefined) return [...e.raw].slice(0, 40).join('');
  if (e.unknown || e.proxy)
    return 'not read: an object this engine does not model';
  return null;
}

function insideBox(p: readonly number[] | undefined, box: Box): boolean {
  const [x, y] = p ?? [];
  return (
    x !== undefined &&
    y !== undefined &&
    x >= box.x0 &&
    x <= box.x1 &&
    y >= box.y0 &&
    y <= box.y1
  );
}

// Count mode can return a row for every block and region pair, even for an empty drawing.
const MAX_BLOCK_COUNTS = 100_000;

export async function query(input: CommandInput): Promise<string> {
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const count = input.values.count === true;
  const blocks = new Set(list(input.values, 'block'));
  const regions = [...new Set(list(input.values, 'region'))].map((region) => ({
    region,
    box: parseBox(region, 'region'),
  }));
  if (count && !blocks.size)
    throw usage('--count needs at least one --block <name>.');
  if (count && blocks.size * Math.max(1, regions.length) > MAX_BLOCK_COUNTS)
    throw usage(
      `--count takes up to ${MAX_BLOCK_COUNTS} block and region pairs.`,
    );
  const types = new Set(list(input.values, 'type').map((t) => t.toUpperCase()));
  const layers = list(input.values, 'layer');
  if (layers.some((layer) => !layer.trim()))
    throw usage('A layer name is missing.');
  const handles = new Set(
    list(input.values, 'handle').map((h) => h.toUpperCase()),
  );
  for (const h of handles)
    if (!/^[0-9A-F]{1,16}$/.test(h))
      throw usage('--handle takes a hexadecimal handle, as `query` prints it.');
  const { drawing: d } = await load(input, fileArg(input), true);
  const { owners, name: space } = spaceOf(d, input.values, true);
  const wanted = new Set(layers.map((l) => pickLayer(d, l)));
  for (const b of blocks)
    if (!d.blocks.has(b))
      throw new AxiError(
        'unknown_block',
        'The drawing defines no block by that name. Run `cad-axi blocks <file>` for the names.',
      );
  const countRegions = count
    ? (regions.length ? regions : [{ region: null, box: null }]).map((r) => ({
        ...r,
        counts: new Map<string, number>(),
      }))
    : [];
  const missingHandles = new Set(handles);
  const rows: Array<Row & { scale?: P3 | undefined }> = [];
  const spatial = input.values['3d'] === true;
  for (const item of walk(d, owners, { inserts: false })) {
    const e = item.e;
    if (types.size && !types.has(e.kind)) continue;
    if (wanted.size && !wanted.has(e.layer)) continue;
    if (blocks.size && !(e.kind === 'INSERT' && e.block && blocks.has(e.block)))
      continue;
    if (handles.size && !handles.has(e.h)) continue;
    const p = anchor(e);
    if (count && e.block) {
      for (const { box, counts } of countRegions) {
        if (box && !insideBox(p, box)) continue;
        counts.set(e.block, (counts.get(e.block) ?? 0) + 1);
        missingHandles.delete(e.h);
      }
      continue;
    }
    const prims = CURVES.has(e.kind) ? worldPrims(item) : [];
    if (
      regions.length &&
      !regions.some(
        ({ box }) =>
          insideBox(p, box) || prims.some((q) => lengthIn(q, box, true) > 0),
      )
    )
      continue;
    const length = prims.length
      ? prims.reduce((s, p) => s + primLength(p, spatial), 0)
      : null;
    const z =
      length === null
        ? {}
        : elevationFields(
            elevationOf(
              prims,
              spatial ? prims.reduce((s, p) => s + primLength(p), 0) : length,
            ),
          );
    const scale = e.kind === 'INSERT' ? insertScale(e) : undefined;
    rows.push({
      h: e.h,
      kind: e.kind,
      layer: e.layer,
      at: at(p),
      detail: detail(
        d,
        e,
        length,
        z.z_span === undefined
          ? ''
          : `, Z span ${round(z.z_span, 3)}${z.z_dominant_entities ? ' (Z-dominant)' : ''}`,
        scale,
      ),
      ...(e.kind === 'INSERT' ? { block: e.block, scale } : {}),
    });
    missingHandles.delete(e.h);
  }
  if (missingHandles.size)
    throw new AxiError(
      'unknown_handle',
      'No entity of that space has that handle. Run `cad-axi query <file>` for handles.',
    );
  if (count) {
    const counts = countRegions.flatMap(({ region, counts }) =>
      [...blocks].map((block) => ({
        block,
        region,
        inserts: counts.get(block) ?? 0,
      })),
    );
    const shown = full ? counts : counts.slice(0, limit);
    const saved = save(input.io, str(input.values, 'save'), {
      block_counts: counts,
    });
    return listOutput({
      key: 'block_counts',
      summary: `${shown.length} of ${counts.length} block count rows`,
      head: { space, ...(saved ? { saved } : {}) },
      rows: shown,
      columns: ['block', 'region', 'inserts'],
      help: [
        'Run `cad-axi query <file> --block <name>` for individual inserts',
      ],
      full,
      narrower: '--block, --region or --limit',
    });
  }
  const shown = full ? rows : rows.slice(0, limit);
  const columns = ['h', 'kind', 'layer', 'at', 'detail'];
  const showInsertFields = full && shown.some((r) => r.kind === 'INSERT');
  if (showInsertFields) columns.push('block', 'scale');
  const length_mode = lengthMode(spatial);
  const saved = save(input.io, str(input.values, 'save'), {
    length_mode,
    entities: rows,
  });
  return listOutput({
    key: 'entities',
    summary: rows.length
      ? `${shown.length} of ${rows.length} entities`
      : '0 entities match',
    head: { space, length_mode, ...(saved ? { saved } : {}) },
    rows: showInsertFields
      ? shown.map((r) => (r.scale ? { ...r, scale: r.scale.join(',') } : r))
      : shown,
    columns,
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
