// What every command shares: flags, opening a drawing through the engine,
// the area and space a command reads, layer names, and --save.

import {
  closeSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { runEngine } from '../bridge/engine.ts';
import type { CommandInput, Io, Values } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import {
  type Drawing,
  emptyDrawing,
  reduce,
  spaceBlocks,
  spaceNames,
} from '../model/drawing.ts';
import type { Box } from '../model/geometry.ts';

/** The default input cap, and the most --max-bytes allows. */
export const MAX_BYTES = 64 * 1024 * 1024;
export const MAX_BYTES_CAP = 256 * 1024 * 1024;

export const LIMIT_FLAG = {
  type: 'string',
  value: '<n>',
  summary: 'Rows to show, default 20',
} as const;
export const FULL_FLAG = {
  type: 'boolean',
  summary: 'Every row and field, without the size limit',
} as const;
export const SAVE_FLAG = {
  type: 'string',
  value: '<file.json>',
  summary: 'Also write every row, untruncated, to this JSON file',
} as const;
export const MAX_BYTES_FLAG = {
  type: 'string',
  value: '<n>',
  summary: `Read files up to this many bytes, default ${MAX_BYTES}, at most ${MAX_BYTES_CAP}`,
} as const;
export const SPACE_FLAG = {
  type: 'string',
  value: '<model|layout>',
  summary: 'Model space, the default, or a paper space layout by name',
} as const;
export const REGION_FLAG = {
  type: 'string',
  value: '<x0,y0,x1,y1>',
  summary: 'Only this box, in drawing units',
} as const;
export const UNITS_FLAG = {
  type: 'string',
  value: '<mm|cm|m|in|ft>',
  summary: 'The drawing unit, when the file states none',
} as const;
export const LAYER_FLAG = {
  type: 'string',
  multiple: true,
  value: '<layer>',
  summary: 'A layer by name',
} as const;
export const ALL_FLAG = {
  type: 'boolean',
  summary: 'Include layers that are off or frozen',
} as const;

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

export function list(values: Values, name: string): string[] {
  const v = values[name];
  if (Array.isArray(v)) return v;
  return typeof v === 'string' ? [v] : [];
}

export function positiveInt(
  values: Values,
  name: string,
  fallback: number,
  max = 100_000,
): number {
  const raw = str(values, name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1 || Number(raw) > max)
    throw usage(`--${name} must be a whole number from 1 to ${max}.`);
  return Number(raw);
}

export function positiveNumber(
  values: Values,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = str(values, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !(n > 0) || n > max)
    throw usage(`--${name} must be a number above 0, at most ${max}.`);
  return n;
}

export function parseBox(text: string, flag: string): Box {
  const parts = text.split(',').map((p) => p.trim());
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(p))
  )
    throw usage(`--${flag} takes four numbers, x0,y0,x1,y1, in drawing units.`);
  const [a, b, c, d] = parts.map(Number) as [number, number, number, number];
  if (![a, b, c, d].every(Number.isFinite))
    throw usage(`--${flag} takes four finite numbers, x0,y0,x1,y1.`);
  if (a === c || b === d) throw usage(`--${flag} must enclose some area.`);
  return {
    x0: Math.min(a, c),
    y0: Math.min(b, d),
    x1: Math.max(a, c),
    y1: Math.max(b, d),
  };
}

export function regionOf(values: Values): Box | null {
  const r = str(values, 'region');
  return r === undefined ? null : parseBox(r, 'region');
}

/** A path as the caller wrote it: relative to the working folder, `~` allowed. */
export function resolvePath(io: Io, file: string): string {
  const expanded =
    file === '~' || file.startsWith('~/') ? homedir() + file.slice(1) : file;
  return isAbsolute(expanded) ? expanded : resolve(io.cwd, expanded);
}

/** Epoch milliseconds after which work must stop, from COMIS_DEADLINE. */
export function deadlineOf(io: Io): number | undefined {
  const raw = io.env.COMIS_DEADLINE;
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{10,16}$/.test(raw))
    throw usage(
      'COMIS_DEADLINE must be a time in epoch milliseconds, a positive whole number.',
    );
  // Leave time to print the answer.
  return Number(raw) - 500;
}

export interface Opened {
  path: string;
  name: string;
  bytes: number;
}

/** Check a file the caller named, before the engine opens it. */
export function checkFile(io: Io, file: string, maxBytes: number): Opened {
  const path = resolvePath(io, file);
  const name = path.split(/[\\/]/).at(-1) ?? file;
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile())
      throw new AxiError('not_found', 'That path is not a file.');
    size = st.size;
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError(
      'not_found',
      'No file at that path. Check the path; run `cad-axi` to list the drawings in this folder.',
    );
  }
  if (size > maxBytes)
    throw new AxiError(
      'too_large',
      `The file is ${size} bytes; the limit is ${maxBytes}.${maxBytes < MAX_BYTES_CAP ? ` Pass --max-bytes up to ${MAX_BYTES_CAP} to read it.` : ''}`,
      { bytes: size, limit: maxBytes },
    );
  return { path, name, bytes: size };
}

/** The first bytes of a file: its version code, for a DWG. */
export function sniff(path: string): {
  format: 'dwg' | 'dxf' | null;
  version: string | null;
} {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    const head = buf.subarray(0, n).toString('latin1');
    if (/^AC\d{4}/.test(head))
      return { format: 'dwg', version: head.slice(0, 6) };
    if (
      /^(AutoCAD Binary DXF|\s*0\s*\r?\n\s*SECTION|\s*999\s*\r?\n)/.test(
        head.replace(/^﻿/, ''),
      )
    )
      return { format: 'dxf', version: null };
    return { format: null, version: null };
  } catch {
    return { format: null, version: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface Loaded extends Opened {
  drawing: Drawing;
}

/** Read a drawing through the engine, with optional geometry or unit evidence. */
export async function load(
  input: CommandInput,
  file: string,
  entities: boolean | 'units',
): Promise<Loaded> {
  const maxBytes = positiveInt(
    input.values,
    'max-bytes',
    MAX_BYTES,
    MAX_BYTES_CAP,
  );
  const opened = checkFile(input.io, file, maxBytes);
  const drawing = await readPath(input.io, opened.path, entities, maxBytes);
  if (
    entities === true &&
    drawing.end.entities > 0 &&
    drawing.entities.length === 0
  )
    throw new AxiError(
      'damaged',
      'The engine read no entities from a drawing that has some.',
    );
  return { ...opened, drawing };
}

export async function readPath(
  io: Io,
  path: string,
  entities: boolean | 'units',
  maxBytes = MAX_BYTES,
): Promise<Drawing> {
  const drawing = emptyDrawing();
  const args = ['read', path, '--max-bytes', String(maxBytes)];
  if (entities === true) args.push('--entities');
  if (entities === 'units') args.push('--unit-evidence');
  await runEngine(args, {
    deadline: deadlineOf(io),
    now: () => io.now().getTime(),
    onRecord: (r) => reduce(drawing, r),
  });
  return drawing;
}

/** The block records a command reads, from --space. */
export function spaceOf(
  d: Drawing,
  values: Values,
  allowAll = false,
): { owners: string[]; name: string } {
  const space = str(values, 'space') ?? 'model';
  if (space === 'all' && allowAll)
    return { owners: spaceBlocks(d, 'all'), name: 'all' };
  const owners = spaceBlocks(d, space);
  if (!owners.length) {
    const names = spaceNames(d).filter((n) => n !== 'Model');
    throw usage(
      `The drawing has no layout by that name. ${names.length ? `Layouts: Model, ${names.slice(0, 10).join(', ')}.` : 'It has only model space.'}${allowAll ? ' Or pass --space all.' : ''}`,
    );
  }
  const layout = d.header.layouts.find((l) => l.block === owners[0]);
  return {
    owners,
    name: space.toLowerCase() === 'model' ? 'Model' : (layout?.name ?? space),
  };
}

const SHOWN_NAME = /^[\p{L}\p{N} _.$+\-#()|\\/[\]{}~@&,'"]{1,80}$/u;

/** A layer by name: exactly, else without case when that is unambiguous. */
export function pickLayer(d: Drawing, wanted: string): string {
  const name = wanted.trim();
  if (!name) throw usage('A layer name is missing.');
  if (d.layers.some((l) => l.name === name)) return name;
  const matches = d.layers.filter(
    (l) => l.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 1) return (matches[0] as { name: string }).name;
  const lower = name.toLowerCase();
  const close = d.layers
    .map((l) => l.name)
    .filter((n) => n.toLowerCase().includes(lower))
    .slice(0, 5);
  const shown = SHOWN_NAME.test(name) ? `\`${name}\`` : 'that name';
  throw new AxiError(
    'unknown_layer',
    `The drawing has no layer named ${shown}.${close.length ? ` Layers that contain it: ${close.join(', ')}.` : ' Run `cad-axi layers <file>` for the names.'}`,
  );
}

/** `LAYER+LAYER`; a layer's own name may hold a `+`, so the longest match is taken first. */
export function pickLayers(d: Drawing, spec: string): string[] {
  const parts = spec.split('+');
  const out: string[] = [];
  for (let at = 0; at < parts.length; ) {
    let taken = 0;
    for (let end = parts.length; end > at + 1 && !taken; end--) {
      const joined = parts.slice(at, end).join('+');
      if (d.layers.some((l) => l.name === joined)) {
        out.push(joined);
        taken = end - at;
      }
    }
    if (!taken) {
      out.push(pickLayer(d, parts[at] as string));
      taken = 1;
    }
    at += taken;
  }
  return out;
}

/** Write the complete result as JSON for a program to read. */
export function save(
  io: Io,
  file: string | undefined,
  data: unknown,
): string | null {
  if (file === undefined) return null;
  const path = resolvePath(io, file);
  try {
    writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
  } catch (error) {
    throw new AxiError(
      'not_found',
      `The file given to --save cannot be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
    );
  }
  return path.split(/[\\/]/).at(-1) ?? file;
}

export const round = (value: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** A point for a row: "x,y" rounded to the drawing's precision. */
export const at = (
  p: readonly number[] | undefined,
  digits = 2,
): string | null =>
  p ? `${round(p[0] ?? 0, digits)},${round(p[1] ?? 0, digits)}` : null;

/** Layer state in one word or a few: on, off, frozen, locked. */
export function layerState(l: {
  on: boolean;
  frozen: boolean;
  locked: boolean;
}): string {
  const parts = [l.frozen ? 'frozen' : l.on ? 'on' : 'off'];
  if (l.frozen && !l.on) parts.push('off');
  if (l.locked) parts.push('locked');
  return parts.join(', ');
}

/** The path a caller would type: the bin's own name when it is on PATH. */
export function binPath(argv1: string | undefined): string {
  if (!argv1) return 'cad-axi';
  const home = homedir();
  return argv1.startsWith(`${home}/`) ? `~${argv1.slice(home.length)}` : argv1;
}
