// `create`, `edit` and `convert`: every write goes to a new file, through a
// private temporary file beside it, and is read again and compared before it
// is moved into place without replacing anything (design §8.7 to §8.9).

import {
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { runEngine } from '../bridge/engine.ts';
import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import type { Drawing } from '../model/drawing.ts';
import { INSUNITS } from '../model/units.ts';
import { recordOutput } from '../output/views.ts';
import { preflight } from '../write/preflight.ts';
import {
  checkOps,
  checkSpec,
  type Names,
  type Op,
  outsideCodepage,
  readJson,
  type Spec,
  type Targets,
} from '../write/schema.ts';
import { mtextValue, verifyCreate, verifyEdit } from '../write/verify.ts';
import { deadlineOf, load, readPath, resolvePath, str } from './common.ts';
import { verticalClasses } from './info.ts';

/** The Comis file limit for a file sent back to the owner. */
export const OUTPUT_LIMIT = 20_000_000;

const VERSIONS: Record<string, string> = {
  '2018': 'AC1032',
  '2013': 'AC1027',
  '2010': 'AC1024',
  '2007': 'AC1021',
  '2004': 'AC1018',
  '2000': 'AC1015',
};

interface Target {
  path: string;
  name: string;
  format: 'dwg' | 'dxf';
  version: string;
}

function target(input: CommandInput): Target {
  const out = str(input.values, 'out');
  if (!out)
    throw usage(
      '--out <new file> is required: writes always go to a new file.',
    );
  const m = /\.(dwg|dxf)$/i.exec(out);
  if (!m)
    throw usage('--out must end in .dwg or .dxf; the name chooses the format.');
  const path = resolvePath(input.io, out);
  if (existsSync(path))
    throw new AxiError(
      'exists',
      'The --out file is already there. cad-axi never replaces a file; name a new one.',
    );
  if (!existsSync(dirname(path)))
    throw new AxiError('not_found', 'The folder for --out does not exist.');
  const format = (m[1] as string).toLowerCase() as 'dwg' | 'dxf';
  const as = str(input.values, 'as') ?? '2018';
  const version = VERSIONS[as];
  if (!version) throw usage('--as takes 2018, 2013, 2010, 2007, 2004 or 2000.');
  if (version === 'AC1021' && format === 'dwg')
    throw new AxiError(
      'unsupported',
      'The engine does not write 2007 DWG files yet. Use --as 2010 or later, or 2004.',
    );
  return { path, name: path.split(/[\\/]/).at(-1) ?? out, format, version };
}

/** Write through a private folder beside --out, check, then link into place. */
async function writeChecked<T>(
  input: CommandInput,
  t: Target,
  write: (tmp: string) => Promise<{
    added: Array<{ op: number; h: string }>;
    sha256: string;
    bytes: number;
  }>,
  check: (written: Drawing, added: Array<{ op: number; h: string }>) => T,
): Promise<{ result: T; sha256: string; bytes: number; written: Drawing }> {
  const dir = mkdtempSync(join(dirname(t.path), '.cad-axi-'));
  const tmp = join(dir, `out.${t.format}`);
  try {
    const w = await write(tmp);
    if (w.bytes > OUTPUT_LIMIT)
      throw new AxiError(
        'output_too_large',
        `The written drawing is ${w.bytes} bytes; files sent back are limited to ${OUTPUT_LIMIT}.`,
        {
          bytes: w.bytes,
          limit: OUTPUT_LIMIT,
        },
      );
    // A fresh engine process reads the output again.
    const written = await readPath(input.io, tmp, true, 256 * 1024 * 1024);
    const result = check(written, w.added);
    try {
      linkSync(tmp, t.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AxiError(
          'exists',
          'The --out file appeared while writing. cad-axi never replaces a file; name a new one.',
        );
      throw new AxiError(
        'not_found',
        `The --out file cannot be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
      );
    }
    return { result, sha256: w.sha256, bytes: w.bytes, written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function engineWrite(input: CommandInput, args: string[]) {
  const r = await runEngine(args, {
    deadline: deadlineOf(input.io),
    now: () => input.io.now().getTime(),
  });
  const end = r.last;
  if (end.type !== 'end')
    throw new AxiError('engine_failed', 'The engine did not finish the write.');
  return {
    added: (Array.isArray(end.added) ? end.added : []) as Array<{
      op: number;
      h: string;
    }>,
    sha256: String(end.sha256),
    bytes: Number(end.bytes),
  };
}

function namesOf(d: Drawing | null): Names {
  if (!d)
    return {
      layers: new Set(['0']),
      linetypes: new Set(['ByLayer', 'ByBlock', 'Continuous']),
      styles: new Set(['Standard']),
      blocks: new Map(),
      // A new drawing has model space and one layout.
      spaces: new Set(['Model', 'Layout1']),
    };
  return {
    layers: new Set(d.layers.map((l) => l.name)),
    linetypes: new Set(d.linetypes.map((l) => l.name)),
    styles: new Set(d.styles.map((s) => s.name)),
    blocks: new Map(
      [...d.blocks.values()]
        .filter((b) => !b.layout && !b.external && !b.anonymous)
        .map((b) => [b.name, new Set(b.attributes)]),
    ),
    spaces: new Set(d.header.layouts.map((l) => l.name)),
  };
}

const UNIT_NAMES: Record<number, Spec['units']> = {
  0: 'none',
  1: 'in',
  2: 'ft',
  4: 'mm',
  5: 'cm',
  6: 'm',
};

function texts(spec: Spec): string[] {
  const all = [...spec.entities, ...spec.blocks.flatMap((b) => b.entities)];
  return all.flatMap((e) => [e.value ?? '', ...Object.values(e.attribs ?? {})]);
}

function warnings(version: string, extra: string[] = []): string[] {
  const out = [...extra];
  if (version !== 'AC1032')
    out.push(
      'AutoCAD is reported to ask to recover files this engine writes in versions older than 2018; open and AUDIT the copy',
    );
  return out;
}

const DRAFT =
  'This is a draft: open it in your CAD program and run AUDIT before relying on it';

export async function create(input: CommandInput): Promise<string> {
  const specPath = str(input.values, 'spec');
  if (!specPath)
    throw usage('--spec <file.json> is required: the drawing to create.');
  const t = target(input);
  const like = str(input.values, 'like');
  const source = like ? (await load(input, like, false)).drawing : null;
  const spec = checkSpec(
    readJson(resolvePath(input.io, specPath), 'spec'),
    namesOf(source),
  );
  const notes: string[] = [];
  // The overlay: the source's units, layers, linetypes and styles, so the new
  // drawing lies in the source's coordinates.
  const full: Spec & { version: string } = {
    version: t.version,
    linetypes: [],
    layers: [],
    styles: [],
    blocks: spec.blocks,
    entities: spec.entities.map((e) =>
      e.kind === 'mtext' ? { ...e, value: mtextValue(e.value ?? '') } : e,
    ),
    ...(spec.time ? { time: spec.time } : {}),
  };
  full.blocks = spec.blocks.map((b) => ({
    ...b,
    entities: b.entities.map((e) =>
      e.kind === 'mtext' ? { ...e, value: mtextValue(e.value ?? '') } : e,
    ),
  }));
  if (source) {
    const u = UNIT_NAMES[source.header.insunits];
    if (spec.units && u && spec.units !== u)
      throw new AxiError(
        'invalid_spec',
        "spec.units differs from the --like drawing; leave it out to use the drawing's units.",
        { field: 'spec.units' },
      );
    if (!u)
      notes.push(
        `the --like drawing's units (${INSUNITS[source.header.insunits]?.[0] ?? `code ${source.header.insunits}`}) are not one cad-axi writes; the copy states none`,
      );
    full.units = u ?? 'none';
    full.codepage = source.header.codepage;
    full.linetypes = source.linetypes
      .filter((l) => !['ByLayer', 'ByBlock', 'Continuous'].includes(l.name))
      .map((l) => ({
        name: l.name,
        description: l.description,
        pattern: l.pattern,
      }));
    full.styles = source.styles
      .filter(
        (s) => s.name !== 'Standard' && /\.(ttf|otf|ttc|shx)$/i.test(s.font),
      )
      .map((s) => ({
        name: s.name,
        font: s.font,
        ...(s.bigfont ? { bigfont: s.bigfont } : {}),
        ...(s.height ? { height: s.height } : {}),
        ...(s.width ? { width: s.width } : {}),
      }));
    full.layers = source.layers
      .filter((l) => l.name !== '0')
      .map((l) => ({
        name: l.name,
        color: Math.min(255, Math.max(1, l.color)),
        ...(full.linetypes.some((x) => x.name === l.linetype)
          ? { linetype: l.linetype }
          : {}),
        ...(l.frozen ? { frozen: true } : {}),
        ...(!l.on ? { off: true } : {}),
        ...(l.locked ? { locked: true } : {}),
      }));
    full.linetypes.push(...spec.linetypes);
    full.styles.push(...spec.styles);
    full.layers.push(...spec.layers);
  } else {
    full.units = spec.units ?? 'mm';
    if (spec.codepage) full.codepage = spec.codepage;
    full.linetypes = spec.linetypes;
    full.styles = spec.styles;
    full.layers = spec.layers;
  }
  if (
    t.version < 'AC1021' &&
    outsideCodepage(texts(spec), full.codepage ?? 'ANSI_1252')
  )
    throw new AxiError(
      'invalid_spec',
      `Some text holds characters that the ${full.codepage ?? 'ANSI_1252'} code page of an ${t.version} file cannot carry; they would be lost. Write 2010 or later, or set spec.codepage.`,
      { field: 'spec.entities' },
    );
  const dir = mkdtempSync(join(dirname(t.path), '.cad-axi-spec-'));
  const specFile = join(dir, 'spec.json');
  try {
    writeFileSync(specFile, JSON.stringify(full), { mode: 0o600 });
    const { result, sha256, bytes, written } = await writeChecked(
      input,
      t,
      (tmp) => engineWrite(input, ['write', '--spec', specFile, '--out', tmp]),
      (written) =>
        verifyCreate(
          {
            ...spec,
            entities: full.entities,
            blocks: full.blocks,
            layers: spec.layers,
          },
          written,
          modelOf(written),
        ),
    );
    return recordOutput(
      {
        written: t.name,
        format: t.format.toUpperCase(),
        version: written.header.version,
        bytes,
        sha256,
        entities: result.entities,
        layers: written.layers.length,
        like: source
          ? 'units, layers, linetypes and text styles copied from the --like drawing: the new drawing lies in its coordinates'
          : null,
        checked:
          'read again by a fresh engine process and compared with the specification: every entity matches',
        warnings: warnings(t.version, notes),
      },
      false,
      '`cad-axi create`',
      [DRAFT, `Run \`cad-axi info ${t.name}\` to look at what was written`],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function modelOf(d: Drawing): string {
  return (
    [...d.blocks.keys()].find((n) => n.toLowerCase() === '*model_space') ??
    '*Model_Space'
  );
}

function refuse(d: Drawing, format: 'dwg' | 'dxf'): void {
  const pf = preflight(d, format);
  if (pf.editable) return;
  const vertical = verticalClasses(d).length > 0;
  throw new AxiError(
    'would_lose',
    `The drawing cannot be re-saved without loss: ${pf.reason}.${vertical ? ' It holds objects from AutoCAD Architecture, MEP or similar.' : ''}`,
    {
      losses: pf.losses.length,
      first: pf.losses
        .slice(0, 6)
        .map((l) => `${l.name} x${l.count}`)
        .join(', '),
    },
  );
}

function targetsOf(d: Drawing): Targets {
  const layouts = new Set(d.header.layouts.map((l) => l.block));
  for (const b of d.blocks.values()) if (b.layout) layouts.add(b.name);
  const kinds = new Map<string, string>();
  const tags = new Map<string, Set<string>>();
  for (const e of d.entities) {
    if (!layouts.has(e.owner)) continue;
    kinds.set(e.h, e.kind);
    if (e.kind === 'INSERT' && e.attribs?.length)
      tags.set(e.h, new Set(e.attribs.map((a) => a.tag)));
  }
  return { kinds, tags };
}

function externalsNote(d: Drawing): string | null {
  const xrefs = [...d.blocks.values()].filter((b) => b.external).length;
  const images = d.externals.length;
  if (!xrefs && !images) return null;
  return `the copy keeps the source's ${xrefs} external references and ${images} images or underlays, which point to other files your CAD program may open`;
}

async function editLike(
  input: CommandInput,
  ops: Op[] | null,
): Promise<string> {
  const file = input.positionals[0];
  if (!file) throw usage('Missing <file>.');
  const t = target(input);
  const {
    path: sourcePath,
    name,
    drawing: source,
  } = await load(input, file, true);
  refuse(source, t.format);
  let checked: Op[] = [];
  if (ops === null) {
    const opsPath = str(input.values, 'ops');
    if (!opsPath)
      throw usage('--ops <file.json> is required: the operations to apply.');
    checked = checkOps(
      readJson(resolvePath(input.io, opsPath), 'ops'),
      namesOf(source),
      targetsOf(source),
    );
    if (!checked.length)
      throw new AxiError(
        'invalid_spec',
        'The operations list is empty; use `cad-axi convert` for a plain copy.',
        { field: 'ops' },
      );
  }
  const sending = checked.map((o) =>
    o.op === 'add_mtext' ||
    (o.op === 'set_text' &&
      source.entities.find((e) => e.h === o.h)?.kind === 'MTEXT')
      ? { ...o, value: mtextValue(o.value ?? '') }
      : o,
  );
  if (
    t.version < 'AC1021' &&
    outsideCodepage(
      sending.map((o) => o.value ?? ''),
      source.header.codepage,
    )
  )
    throw new AxiError(
      'invalid_spec',
      `Some text holds characters that the ${source.header.codepage} code page of an ${t.version} file cannot carry; they would be lost. Write 2010 or later.`,
      { field: 'ops' },
    );
  if (t.version < 'AC1021' && source.header.version >= 'AC1021') {
    const raw = source.entities.flatMap((e) => [
      e.raw ?? '',
      ...(e.attribs ?? []).map((a) => a.raw),
    ]);
    if (outsideCodepage(raw, source.header.codepage))
      throw new AxiError(
        'would_lose',
        `The drawing's text holds characters that an ${t.version} file in ${source.header.codepage} cannot carry. Write 2010 or later.`,
        { losses: 1 },
      );
  }
  const dir = mkdtempSync(join(dirname(t.path), '.cad-axi-ops-'));
  const opsFile = join(dir, 'ops.json');
  try {
    writeFileSync(opsFile, JSON.stringify({ ops: sending }), { mode: 0o600 });
    const { result, sha256, bytes, written } = await writeChecked(
      input,
      t,
      (tmp) =>
        engineWrite(input, [
          'edit',
          sourcePath,
          '--ops',
          opsFile,
          '--out',
          tmp,
          '--as',
          t.version,
          '--max-bytes',
          String(statSync(sourcePath).size + 1),
        ]),
      (written, added) => verifyEdit(source, written, sending, added),
    );
    const note = externalsNote(source);
    return recordOutput(
      {
        written: t.name,
        source: name,
        format: t.format.toUpperCase(),
        version: written.header.version,
        bytes,
        sha256,
        operations: checked.length,
        entities_changed: result.changed,
        entities_deleted: result.deleted,
        entities_added: result.added,
        entities_kept: result.kept,
        checked:
          'read again by a fresh engine process and compared with the source, entity by entity: every untouched entity matches, every operation is carried out, nothing is lost',
        warnings: warnings(t.version, note ? [note] : []),
      },
      false,
      ops === null ? '`cad-axi edit`' : '`cad-axi convert`',
      [DRAFT, `Run \`cad-axi diff ${name} ${t.name}\` to see what changed`],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const edit = (input: CommandInput) => editLike(input, null);
export const convert = (input: CommandInput) => editLike(input, []);
