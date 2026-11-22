// The closed languages of writing (design §8.7 and §8.8): a specification
// for `create`, and a list of operations for `edit`. Both are validated in
// full before the engine sees them. Neither can add an external reference,
// image, OLE object, field, data link or path: the grammar has no word for
// them, and text that looks like a field is refused.

import { readFileSync, statSync } from 'node:fs';
import { AxiError } from '../errors.ts';

export const LIMITS = {
  specBytes: 8 * 1024 * 1024,
  entities: 100_000,
  ops: 1000,
  layers: 1000,
  blocks: 200,
  linetypes: 100,
  styles: 100,
  points: 10_000,
  text: 2000,
  coordinate: 1e9,
};

export type Xy = [number, number] | [number, number, number];

export interface SpecEntity {
  kind:
    | 'line'
    | 'polyline'
    | 'circle'
    | 'arc'
    | 'text'
    | 'mtext'
    | 'point'
    | 'insert'
    | 'attdef';
  layer?: string;
  color?: number;
  linetype?: string;
  style?: string;
  from?: Xy;
  to?: Xy;
  pts?: Array<[number, number]>;
  bulges?: number[];
  closed?: boolean;
  center?: Xy;
  radius?: number;
  start?: number;
  end?: number;
  at?: Xy;
  height?: number;
  value?: string;
  rotation?: number;
  width?: number;
  block?: string;
  scale?: [number, number] | [number, number, number];
  attribs?: Record<string, string>;
  tag?: string;
  prompt?: string;
  space?: string;
}

export interface Spec {
  units?: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'none';
  codepage?: string;
  time?: string;
  linetypes: Array<{ name: string; description?: string; pattern: number[] }>;
  layers: Array<{
    name: string;
    color?: number;
    linetype?: string;
    off?: boolean;
    frozen?: boolean;
    locked?: boolean;
  }>;
  styles: Array<{
    name: string;
    font: string;
    bigfont?: string;
    height?: number;
    width?: number;
  }>;
  blocks: Array<{ name: string; base?: Xy; entities: SpecEntity[] }>;
  entities: SpecEntity[];
}

export interface Op extends Partial<SpecEntity> {
  op: string;
  h?: string;
  by?: Xy;
  name?: string;
}

/** A field failed validation: the message names the field, never its value. */
export function invalid(field: string, why: string): AxiError {
  return new AxiError('invalid_spec', `${field} ${why}`, { field });
}

export function readJson(path: string, what: string): unknown {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new AxiError('not_found', `No ${what} file at that path.`);
  }
  if (size > LIMITS.specBytes)
    throw invalid(what, `is ${size} bytes; the limit is ${LIMITS.specBytes}.`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AxiError('invalid_spec', `The ${what} file is not valid JSON.`, {
      field: what,
    });
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const NAME_BAD = /[<>/\\":;?*|=`\u0000-\u001f\u007f]/;

export function checkName(
  value: unknown,
  field: string,
  kind = 'name',
): string {
  if (typeof value !== 'string' || !value.length || [...value].length > 255)
    throw invalid(field, `must be a ${kind} of 1 to 255 characters.`);
  if (NAME_BAD.test(value) || value !== value.trim())
    throw invalid(
      field,
      `holds a character a CAD ${kind} cannot: < > / \\ " : ; ? * | = \` or a control character, or space at its ends.`,
    );
  return value;
}

function num(value: unknown, field: string, limit = LIMITS.coordinate): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > limit
  )
    throw invalid(field, `must be a finite number within ±${limit}.`);
  return value;
}

function positive(value: unknown, field: string): number {
  const n = num(value, field);
  if (!(n > 0)) throw invalid(field, 'must be above 0.');
  return n;
}

function point(value: unknown, field: string): Xy {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3))
    throw invalid(field, 'must be [x, y] or [x, y, z].');
  return value.map((v, i) => num(v, `${field}[${i}]`)) as Xy;
}

function text(value: unknown, field: string, mtext: boolean): string {
  if (typeof value !== 'string') throw invalid(field, 'must be a string.');
  if ([...value].length > LIMITS.text)
    throw invalid(field, `is longer than ${LIMITS.text} characters.`);
  if (/%<\\/.test(value))
    throw invalid(
      field,
      'looks like a CAD field (%<\\...>%); fields are not written.',
    );
  if (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) ||
    (!mtext && /[\n\t]/.test(value))
  )
    throw invalid(field, 'holds a control character.');
  if (/\p{Cs}/u.test(value))
    throw invalid(field, 'holds an unpaired surrogate.');
  return value;
}

function only(
  o: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  for (const k of Object.keys(o))
    if (!keys.includes(k))
      throw invalid(
        `${field}.${/^[A-Za-z_]{1,30}$/.test(k) ? k : '?'}`,
        'is not a field of this grammar.',
      );
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(field, 'must be an object.');
  return value as Record<string, unknown>;
}

function arr(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(field, 'must be a list.');
  if (value.length > max) throw invalid(field, `holds more than ${max} items.`);
  return value;
}

export interface Names {
  layers: Set<string>;
  linetypes: Set<string>;
  styles: Set<string>;
  /** Block name to its attribute tags. */
  blocks: Map<string, Set<string>>;
  spaces: Set<string>;
}

const COMMON = ['kind', 'layer', 'color', 'linetype', 'space'];
const FIELDS: Record<SpecEntity['kind'], string[]> = {
  line: ['from', 'to'],
  polyline: ['pts', 'bulges', 'closed'],
  circle: ['center', 'radius'],
  arc: ['center', 'radius', 'start', 'end'],
  text: ['at', 'height', 'value', 'rotation', 'style'],
  mtext: ['at', 'height', 'value', 'width', 'style'],
  point: ['at'],
  insert: ['block', 'at', 'scale', 'rotation', 'attribs'],
  attdef: ['tag', 'prompt', 'value', 'at', 'height', 'style'],
};

export function checkEntity(
  raw: unknown,
  field: string,
  names: Names,
  inBlock: boolean,
  extra: readonly string[] = [],
): SpecEntity {
  const o = obj(raw, field);
  const kind = o.kind;
  if (
    typeof kind !== 'string' ||
    !(kind in FIELDS) ||
    (kind === 'attdef' && !inBlock)
  )
    throw invalid(
      `${field}.kind`,
      `must be one of ${Object.keys(FIELDS)
        .filter((k) => inBlock || k !== 'attdef')
        .join(', ')}.`,
    );
  const k = kind as SpecEntity['kind'];
  only(o, [...COMMON, ...(FIELDS[k] as string[]), ...extra], field);
  const e: SpecEntity = { kind: k };
  if (o.layer !== undefined) {
    const layer = checkName(o.layer, `${field}.layer`, 'layer name');
    if (!names.layers.has(layer))
      throw new AxiError(
        'unknown_layer',
        `${field}.layer names a layer the drawing does not hold; add it under layers, or with add_layer first.`,
        { field: `${field}.layer` },
      );
    e.layer = layer;
  }
  if (o.color !== undefined) {
    const c = num(o.color, `${field}.color`, 256);
    if (!Number.isInteger(c) || c < 1)
      throw invalid(
        `${field}.color`,
        'must be a colour number from 1 to 255, or 256 for the layer colour.',
      );
    e.color = c;
  }
  if (o.linetype !== undefined) {
    const lt = checkName(o.linetype, `${field}.linetype`, 'linetype name');
    if (!names.linetypes.has(lt))
      throw invalid(
        `${field}.linetype`,
        'names a linetype the drawing does not define.',
      );
    e.linetype = lt;
  }
  if (o.space !== undefined) {
    if (inBlock)
      throw invalid(`${field}.space`, 'is not allowed inside a block.');
    const s = checkName(o.space, `${field}.space`, 'layout name');
    if (!names.spaces.has(s))
      throw invalid(
        `${field}.space`,
        'names a layout the drawing does not hold.',
      );
    e.space = s;
  }
  if ('style' in o && o.style !== undefined) {
    const s = checkName(o.style, `${field}.style`, 'style name');
    if (!names.styles.has(s))
      throw invalid(
        `${field}.style`,
        'names a text style the drawing does not define.',
      );
    e.style = s;
  }
  switch (k) {
    case 'line':
      e.from = point(o.from, `${field}.from`);
      e.to = point(o.to, `${field}.to`);
      break;
    case 'polyline': {
      const pts = arr(o.pts, `${field}.pts`, LIMITS.points);
      if (pts.length < 2)
        throw invalid(`${field}.pts`, 'needs at least two points.');
      e.pts = pts.map((p, i) => {
        const q = point(p, `${field}.pts[${i}]`);
        return [q[0], q[1]];
      });
      if (o.bulges !== undefined) {
        const b = arr(o.bulges, `${field}.bulges`, LIMITS.points);
        if (b.length !== pts.length)
          throw invalid(`${field}.bulges`, 'needs one bulge per point.');
        e.bulges = b.map((v, i) => num(v, `${field}.bulges[${i}]`, 1e6));
      }
      if (o.closed !== undefined) {
        if (typeof o.closed !== 'boolean')
          throw invalid(`${field}.closed`, 'must be true or false.');
        e.closed = o.closed;
      }
      break;
    }
    case 'circle':
      e.center = point(o.center, `${field}.center`);
      e.radius = positive(o.radius, `${field}.radius`);
      break;
    case 'arc':
      e.center = point(o.center, `${field}.center`);
      e.radius = positive(o.radius, `${field}.radius`);
      e.start = num(o.start, `${field}.start`, 1e6);
      e.end = num(o.end, `${field}.end`, 1e6);
      break;
    case 'point':
      e.at = point(o.at, `${field}.at`);
      break;
    case 'text':
    case 'mtext':
    case 'attdef':
      e.at = point(o.at, `${field}.at`);
      e.height = positive(o.height, `${field}.height`);
      e.value = text(o.value ?? '', `${field}.value`, k === 'mtext');
      if (k === 'text' && o.rotation !== undefined)
        e.rotation = num(o.rotation, `${field}.rotation`, 1e6);
      if (k === 'mtext' && o.width !== undefined)
        e.width = num(o.width, `${field}.width`);
      if (k === 'attdef') {
        e.tag = checkName(o.tag, `${field}.tag`, 'attribute tag');
        if (/\s/.test(e.tag))
          throw invalid(`${field}.tag`, 'may not hold spaces.');
        e.prompt = text(o.prompt ?? '', `${field}.prompt`, false);
      }
      break;
    case 'insert': {
      const block = checkName(o.block, `${field}.block`, 'block name');
      const tags = names.blocks.get(block);
      if (!tags)
        throw new AxiError(
          'unknown_block',
          `${field}.block names a block the drawing does not define.`,
          { field: `${field}.block` },
        );
      e.block = block;
      e.at = point(o.at, `${field}.at`);
      if (o.rotation !== undefined)
        e.rotation = num(o.rotation, `${field}.rotation`, 1e6);
      if (o.scale !== undefined) {
        const s = arr(o.scale, `${field}.scale`, 3);
        if (s.length < 2)
          throw invalid(`${field}.scale`, 'must be [sx, sy] or [sx, sy, sz].');
        e.scale = s.map((v, i) => {
          const n = num(v, `${field}.scale[${i}]`, 1e6);
          if (n === 0) throw invalid(`${field}.scale[${i}]`, 'may not be 0.');
          return n;
        }) as [number, number];
      }
      if (o.attribs !== undefined) {
        const a = obj(o.attribs, `${field}.attribs`);
        const out: Record<string, string> = {};
        for (const [tag, value] of Object.entries(a)) {
          if (!tags.has(tag))
            throw invalid(
              `${field}.attribs`,
              'names a tag the block does not define.',
            );
          out[tag] = text(value, `${field}.attribs`, false);
        }
        e.attribs = out;
      }
      break;
    }
  }
  return e;
}

const FONT = /^[\p{L}\p{N} _.()-]{1,64}\.(ttf|otf|ttc|shx)$/iu;

export function checkSpec(raw: unknown, base: Names): Spec {
  const o = obj(raw, 'spec');
  only(
    o,
    [
      'units',
      'codepage',
      'time',
      'linetypes',
      'layers',
      'styles',
      'blocks',
      'entities',
    ],
    'spec',
  );
  const spec: Spec = {
    linetypes: [],
    layers: [],
    styles: [],
    blocks: [],
    entities: [],
  };
  if (o.units !== undefined) {
    if (!['mm', 'cm', 'm', 'in', 'ft', 'none'].includes(o.units as string))
      throw invalid('spec.units', 'must be mm, cm, m, in, ft or none.');
    spec.units = o.units as NonNullable<Spec['units']>;
  }
  if (o.codepage !== undefined) {
    if (
      typeof o.codepage !== 'string' ||
      !/^ANSI_(874|932|936|949|950|125[0-8])$/.test(o.codepage)
    )
      throw invalid(
        'spec.codepage',
        'must be a Windows code page such as ANSI_1252 or ANSI_1255.',
      );
    spec.codepage = o.codepage;
  }
  if (o.time !== undefined) {
    if (
      typeof o.time !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(o.time) ||
      Number.isNaN(Date.parse(o.time))
    )
      throw invalid(
        'spec.time',
        'must be a UTC time such as 2026-01-01T00:00:00Z.',
      );
    spec.time = o.time;
  }
  const names: Names = {
    layers: new Set(base.layers),
    linetypes: new Set(base.linetypes),
    styles: new Set(base.styles),
    blocks: new Map(base.blocks),
    spaces: new Set(base.spaces),
  };
  arr(o.linetypes, 'spec.linetypes', LIMITS.linetypes).forEach((v, i) => {
    const f = `spec.linetypes[${i}]`;
    const l = obj(v, f);
    only(l, ['name', 'description', 'pattern'], f);
    const name = checkName(l.name, `${f}.name`, 'linetype name');
    const pattern = arr(l.pattern, `${f}.pattern`, 12).map((x, j) =>
      num(x, `${f}.pattern[${j}]`, 1e6),
    );
    const description =
      l.description === undefined
        ? ''
        : text(l.description, `${f}.description`, false);
    if (names.linetypes.has(name)) return;
    names.linetypes.add(name);
    spec.linetypes.push({ name, description, pattern });
  });
  arr(o.layers, 'spec.layers', LIMITS.layers).forEach((v, i) => {
    const f = `spec.layers[${i}]`;
    const l = obj(v, f);
    only(l, ['name', 'color', 'linetype', 'off', 'frozen', 'locked'], f);
    const name = checkName(l.name, `${f}.name`, 'layer name');
    const layer: Spec['layers'][number] = { name };
    if (l.color !== undefined) {
      const c = num(l.color, `${f}.color`, 255);
      if (!Number.isInteger(c) || c < 1)
        throw invalid(`${f}.color`, 'must be a colour number from 1 to 255.');
      layer.color = c;
    }
    if (l.linetype !== undefined) {
      const lt = checkName(l.linetype, `${f}.linetype`, 'linetype name');
      if (!names.linetypes.has(lt))
        throw invalid(
          `${f}.linetype`,
          'names a linetype the drawing does not define.',
        );
      layer.linetype = lt;
    }
    for (const flag of ['off', 'frozen', 'locked'] as const)
      if (l[flag] !== undefined) {
        if (typeof l[flag] !== 'boolean')
          throw invalid(`${f}.${flag}`, 'must be true or false.');
        layer[flag] = l[flag] as boolean;
      }
    if (names.layers.has(name)) return;
    names.layers.add(name);
    spec.layers.push(layer);
  });
  arr(o.styles, 'spec.styles', LIMITS.styles).forEach((v, i) => {
    const f = `spec.styles[${i}]`;
    const s = obj(v, f);
    only(s, ['name', 'font', 'bigfont', 'height', 'width'], f);
    const name = checkName(s.name, `${f}.name`, 'style name');
    if (typeof s.font !== 'string' || !FONT.test(s.font))
      throw invalid(
        `${f}.font`,
        'must be a font file name such as arial.ttf or romans.shx, with no folder.',
      );
    const style: Spec['styles'][number] = { name, font: s.font };
    if (s.bigfont !== undefined) {
      if (
        typeof s.bigfont !== 'string' ||
        !/^[\p{L}\p{N} _.()-]{1,64}\.shx$/iu.test(s.bigfont)
      )
        throw invalid(
          `${f}.bigfont`,
          'must be an SHX file name, with no folder.',
        );
      style.bigfont = s.bigfont;
    }
    if (s.height !== undefined) style.height = num(s.height, `${f}.height`);
    if (s.width !== undefined) style.width = positive(s.width, `${f}.width`);
    if (names.styles.has(name)) return;
    names.styles.add(name);
    spec.styles.push(style);
  });
  const blocks = arr(o.blocks, 'spec.blocks', LIMITS.blocks);
  let count = 0;
  blocks.forEach((v, i) => {
    const f = `spec.blocks[${i}]`;
    const b = obj(v, f);
    only(b, ['name', 'base', 'entities'], f);
    const name = checkName(b.name, `${f}.name`, 'block name');
    if (name.startsWith('*'))
      throw invalid(
        `${f}.name`,
        'may not start with *, which marks layouts and anonymous blocks.',
      );
    if (names.blocks.has(name))
      throw invalid(`${f}.name`, 'names a block that is already defined.');
    const entities = arr(b.entities, `${f}.entities`, LIMITS.entities).map(
      (e, j) => checkEntity(e, `${f}.entities[${j}]`, names, true),
    );
    count += entities.length;
    const tags = new Set(
      entities.filter((e) => e.kind === 'attdef').map((e) => e.tag as string),
    );
    names.blocks.set(name, tags);
    spec.blocks.push({
      name,
      ...(b.base === undefined ? {} : { base: point(b.base, `${f}.base`) }),
      entities,
    });
  });
  spec.entities = arr(o.entities, 'spec.entities', LIMITS.entities).map(
    (e, j) => checkEntity(e, `spec.entities[${j}]`, names, false),
  );
  count += spec.entities.length;
  if (count > LIMITS.entities)
    throw invalid('spec', `holds more than ${LIMITS.entities} entities.`);
  return spec;
}

const OPS = [
  'set_text',
  'set_attribute',
  'move',
  'delete',
  'set_layer',
  'add_layer',
  'add_line',
  'add_polyline',
  'add_circle',
  'add_arc',
  'add_text',
  'add_mtext',
  'add_point',
  'add_insert',
];

/** Handles an edit may name: entities of model space and paper space layouts. */
export interface Targets {
  kinds: Map<string, string>;
  /** Insert handle to its attribute tags. */
  tags: Map<string, Set<string>>;
}

export function checkOps(raw: unknown, base: Names, targets: Targets): Op[] {
  const o = obj(raw, 'ops');
  only(o, ['ops'], 'ops');
  const list = arr(o.ops, 'ops.ops', LIMITS.ops);
  const names: Names = { ...base, layers: new Set(base.layers) };
  const touched = new Set<string>();
  return list.map((v, i) => {
    const f = `ops[${i}]`;
    const x = obj(v, f);
    const op = x.op;
    if (typeof op !== 'string' || !OPS.includes(op))
      throw invalid(`${f}.op`, `must be one of ${OPS.join(', ')}.`);
    const handle = () => {
      const h = x.h;
      if (typeof h !== 'string' || !/^[0-9A-Fa-f]{1,16}$/.test(h))
        throw invalid(
          `${f}.h`,
          'must be a hexadecimal handle from `cad-axi query`.',
        );
      const upper = h.toUpperCase();
      if (!targets.kinds.has(upper))
        throw new AxiError(
          'unknown_handle',
          `${f}.h names no entity of model space or a layout. Take handles from \`cad-axi query\`.`,
          { field: `${f}.h` },
        );
      if (touched.has(upper) && op !== 'set_attribute')
        throw invalid(
          `${f}.h`,
          'names an entity an earlier operation already changed or deleted.',
        );
      return upper;
    };
    switch (op) {
      case 'set_text': {
        only(x, ['op', 'h', 'value'], f);
        const h = handle();
        const kind = targets.kinds.get(h);
        if (kind !== 'TEXT' && kind !== 'MTEXT')
          throw invalid(`${f}.h`, 'names an entity that is not TEXT or MTEXT.');
        touched.add(h);
        return { op, h, value: text(x.value, `${f}.value`, kind === 'MTEXT') };
      }
      case 'set_attribute': {
        only(x, ['op', 'h', 'tag', 'value'], f);
        const h = handle();
        const tags = targets.tags.get(h);
        if (!tags)
          throw invalid(
            `${f}.h`,
            'names an entity that is not a block insert with attributes.',
          );
        if (typeof x.tag !== 'string' || !tags.has(x.tag))
          throw invalid(`${f}.tag`, 'names a tag the insert does not carry.');
        return { op, h, tag: x.tag, value: text(x.value, `${f}.value`, false) };
      }
      case 'move': {
        only(x, ['op', 'h', 'by'], f);
        const h = handle();
        touched.add(h);
        return { op, h, by: point(x.by, `${f}.by`) };
      }
      case 'delete': {
        only(x, ['op', 'h'], f);
        const h = handle();
        if (targets.kinds.get(h) === 'VIEWPORT')
          throw invalid(
            `${f}.h`,
            'names a layout viewport, which is not deleted.',
          );
        touched.add(h);
        return { op, h };
      }
      case 'set_layer': {
        only(x, ['op', 'h', 'layer'], f);
        const h = handle();
        const layer = checkName(x.layer, `${f}.layer`, 'layer name');
        if (!names.layers.has(layer))
          throw new AxiError(
            'unknown_layer',
            `${f}.layer names a layer the drawing does not hold.`,
            { field: `${f}.layer` },
          );
        touched.add(h);
        return { op, h, layer };
      }
      case 'add_layer': {
        only(x, ['op', 'name', 'color', 'linetype'], f);
        const name = checkName(x.name, `${f}.name`, 'layer name');
        if (names.layers.has(name))
          throw invalid(
            `${f}.name`,
            'names a layer the drawing already holds.',
          );
        const out: Op = { op, name };
        if (x.color !== undefined) {
          const c = num(x.color, `${f}.color`, 255);
          if (!Number.isInteger(c) || c < 1)
            throw invalid(
              `${f}.color`,
              'must be a colour number from 1 to 255.',
            );
          out.color = c;
        }
        if (x.linetype !== undefined) {
          const lt = checkName(x.linetype, `${f}.linetype`, 'linetype name');
          if (!names.linetypes.has(lt))
            throw invalid(
              `${f}.linetype`,
              'names a linetype the drawing does not define.',
            );
          out.linetype = lt;
        }
        names.layers.add(name);
        return out;
      }
      default: {
        const kind = op.slice(4);
        const { op: _op, ...rest } = x;
        const e = checkEntity({ ...rest, kind }, f, names, false);
        const { kind: _kind, ...fields } = e;
        return { op, ...fields };
      }
    }
  });
}

/**
 * Whether every text of a specification survives a code page. Before AC1021
 * every string passes through the drawing's code page.
 */
export function outsideCodepage(
  values: readonly string[],
  codepage: string,
): boolean {
  const label = /^ANSI_(\d+)$/i.exec(codepage)?.[1];
  if (!label) return values.some((v) => /[^\x20-\x7e\n]/.test(v));
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(`windows-${label}`);
  } catch {
    return values.some((v) => /[^\x20-\x7e\n]/.test(v));
  }
  const page = new Set<string>();
  for (let b = 0x80; b <= 0xff; b++) page.add(decoder.decode(Uint8Array.of(b)));
  return values.some((v) => [...v].some((ch) => ch > '\x7e' && !page.has(ch)));
}
