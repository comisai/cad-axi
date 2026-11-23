// `measure` and `runs`: lengths by group, and connected runs with their sizes.

import type { CommandInput } from '../cli/table.ts';
import { usage } from '../errors.ts';
import type { Drawing } from '../model/drawing.ts';
import { collectTexts } from '../model/texts.ts';
import { metres, needMetres, unitsOf } from '../model/units.ts';
import { listOutput, type Row } from '../output/views.ts';
import {
  elevationFields,
  lengthMode,
  type Piece,
  piecesOf,
} from '../takeoff/lengths.ts';
import { findRuns, type Run } from '../takeoff/runs.ts';
import { sizeLabels, sizeRuns } from '../takeoff/sizes.ts';
import {
  at,
  list,
  load,
  pickLayer,
  pickLayers,
  positiveInt,
  positiveNumber,
  regionOf,
  round,
  save,
  spaceOf,
  str,
} from './common.ts';

interface Group {
  name: string;
  layers: Set<string>;
}

/** `--group name=LAYER+LAYER`, or one group per `--layer`. */
function groupsOf(
  input: CommandInput,
  d: Drawing,
  required: boolean,
): Group[] | null {
  const groups: Group[] = [];
  for (const g of list(input.values, 'group')) {
    const eq = g.indexOf('=');
    if (eq < 1 || eq === g.length - 1)
      throw usage(
        '--group takes name=LAYER, with layers joined by +: sewer=SAN+VENT.',
      );
    const name = g.slice(0, eq).trim();
    if (!/^[\p{L}\p{N} _.-]{1,40}$/u.test(name))
      throw usage(
        'A group name is letters, digits, spaces, dots, dashes and underscores, up to 40.',
      );
    if (groups.some((x) => x.name === name))
      throw usage('Two groups have the same name.');
    groups.push({ name, layers: new Set(pickLayers(d, g.slice(eq + 1))) });
  }
  for (const l of list(input.values, 'layer')) {
    const name = pickLayer(d, l);
    if (!groups.some((g) => g.name === name))
      groups.push({ name, layers: new Set([name]) });
  }
  if (!groups.length && required)
    throw usage(
      'Name the pipes to follow with --layer <layer> or --group name=LAYER+LAYER.',
    );
  return groups.length ? groups : null;
}

function fileArg(input: CommandInput): string {
  const file = input.positionals[0];
  if (!file) throw usage('Missing <file>.');
  return file;
}

/** The gap two ends may leave and still join: 10 mm by default, in drawing units. */
function gapOf(input: CommandInput, unitMetres: number | null): number {
  const given = str(input.values, 'gap');
  if (given !== undefined) return positiveNumber(input.values, 'gap', 1, 1e9);
  return unitMetres === null ? 0.001 : 0.01 / unitMetres;
}

function runsOf(
  input: CommandInput,
  d: Drawing,
  owners: readonly string[],
  groups: Group[],
  all: boolean,
  gap: number,
) {
  const region = regionOf(input.values);
  const spatial = input.values['3d'] === true;
  const layerSet = new Set(groups.flatMap((g) => [...g.layers]));
  const { pieces, hidden, elevation } = piecesOf(d, owners, region, {
    all,
    layers: layerSet,
    spatial,
    includeOtherLayers: true,
  });
  const byLayer = new Map<string, Piece[]>();
  for (const piece of pieces) {
    if (piece.length <= 0) continue;
    const list = byLayer.get(piece.item.layer);
    if (list) list.push(piece);
    else byLayer.set(piece.item.layer, [piece]);
  }
  const byGroup = groups.map((g) => ({
    name: g.name,
    pieces: pieces.filter((p) => p.length > 0 && g.layers.has(p.item.layer)),
  }));
  // Runs on every other visible layer compete for the labels too, so a label
  // as close to another layer's run sizes neither, whichever layers were
  // asked for. They are never reported.
  const rivals = [...byLayer]
    .filter(([name]) => !layerSet.has(name))
    .map(([name, list]) => ({ name: `${RIVAL}${name}`, pieces: list }));
  const found = findRuns([...byGroup, ...rivals], gap, spatial);
  const reach = positiveNumber(input.values, 'reach', 3, 100);
  const labels = sizeLabels(
    collectTexts(d, owners)
      .filter((t) => !t.hidden || all)
      .map((t) => ({
        text: t.text,
        at: t.at,
        height: t.height,
        rotation: t.rotation,
        h: t.h,
      })),
  );
  const sized = sizeRuns(found, labels, reach);
  const asked = (run: { group: string }) => !run.group.startsWith(RIVAL);
  const elsewhere = sized.placement.onRun.filter(
    (i) => !asked(found[i] as Run),
  ).length;
  const runs = sized.runs
    .filter(asked)
    .map((run, i) => ({ ...run, id: i + 1 }));
  const placement = {
    ...sized.placement,
    placed: sized.placement.placed - elsewhere,
    elsewhere,
  };
  return { runs, placement, hidden, elevation, reach };
}

/** Marks the group of a layer that was not asked for: it only competes. */
const RIVAL = '\u0000';

export async function measure(input: CommandInput): Promise<string> {
  const { drawing: d } = await load(input, fileArg(input), true);
  const units = unitsOf(d.header.insunits, str(input.values, 'units'));
  const factor = needMetres(units);
  const { owners, name: space } = spaceOf(d, input.values);
  const region = regionOf(input.values);
  const all = input.values.all === true;
  const by = str(input.values, 'by') ?? 'layer';
  if (!['layer', 'linetype', 'color', 'size'].includes(by))
    throw usage('--by takes layer, linetype, color or size.');
  const groups = groupsOf(input, d, by === 'size');
  const full = input.values.full === true;
  const limit = positiveInt(input.values, 'limit', 20);
  const unitNote = `metres, from ${units.name} (${units.basis === 'file' ? 'stated by the file' : 'given'})`;
  const spatial = input.values['3d'] === true;
  const length_mode = lengthMode(spatial);

  if (by === 'size') {
    const r = runsOf(
      input,
      d,
      owners,
      groups as Group[],
      all,
      gapOf(input, factor),
    );
    const rows = new Map<
      string,
      {
        group: string;
        size: string;
        length: number;
        runs: number;
        basis: string;
      }
    >();
    for (const run of r.runs) {
      const size =
        run.size ??
        (run.basis === 'conflict' ? 'conflicting labels' : 'unsized');
      const key = `${run.group}\u0000${size}`;
      const row = rows.get(key) ?? {
        group: run.group,
        size,
        length: 0,
        runs: 0,
        basis: run.basis === 'label' ? 'label' : 'none',
      };
      row.length += run.length;
      row.runs++;
      rows.set(key, row);
    }
    const out = [...rows.values()]
      .map((x) => ({ ...x, length: metres(x.length * factor) }))
      .sort(
        (a, b) =>
          a.group.localeCompare(b.group) ||
          (a.basis === b.basis
            ? b.length - a.length
            : a.basis === 'label'
              ? -1
              : 1),
      );
    const shown = full ? out : out.slice(0, limit);
    const geometry = { length_mode, ...elevationFields(r.elevation) };
    const saved = save(input.io, str(input.values, 'save'), {
      ...geometry,
      sizes: out,
    });
    return listOutput({
      key: 'sizes',
      summary: out.length
        ? `${shown.length} of ${out.length} rows of length by group and size`
        : '0 runs on those layers',
      head: {
        space,
        lengths: unitNote,
        ...geometry,
        reach: `${r.reach} text heights`,
        labels: `${r.placement.placed} sized these runs, ${r.placement.shared.length} sat as close to runs of two layers and sized neither, ${r.placement.elsewhere} belong to runs of other layers, ${r.placement.missed.length} with no run in reach`,
        ...(r.hidden.entities
          ? {
              left_out: `${metres(r.hidden.length * factor)} m on layers that are off or frozen; --all includes them`,
            }
          : {}),
        ...(saved ? { saved } : {}),
      },
      rows: shown,
      columns: ['group', 'size', 'length', 'runs', 'basis'],
      help: [
        'Run `cad-axi runs <file> --layer <layer>` for each run with its ends and label',
        'Unsized runs carry no label within reach; read them on the drawing, never guess',
      ],
      full,
      narrower: '--group, --layer or --limit',
    });
  }

  const layerSet = groups
    ? new Set(groups.flatMap((g) => [...g.layers]))
    : undefined;
  const { pieces, hidden, elevation } = piecesOf(d, owners, region, {
    all,
    spatial,
    ...(layerSet ? { layers: layerSet } : {}),
  });
  const keyOf = (p: Piece): string[] => {
    if (groups)
      return groups
        .filter((g) => g.layers.has(p.item.layer))
        .map((g) => g.name);
    if (by === 'linetype') return [p.item.linetype];
    if (by === 'color') return [String(p.item.color)];
    return [p.item.layer];
  };
  const rows = new Map<
    string,
    {
      group: string;
      length: number;
      entities: number;
      in_blocks: number;
      approximated: boolean;
    }
  >();
  for (const p of pieces)
    for (const key of keyOf(p)) {
      const row = rows.get(key) ?? {
        group: key,
        length: 0,
        entities: 0,
        in_blocks: 0,
        approximated: false,
      };
      row.length += p.length;
      row.entities++;
      if (p.item.depth > 0) row.in_blocks += p.length;
      if (p.approximated) row.approximated = true;
      rows.set(key, row);
    }
  if (groups)
    for (const g of groups)
      if (!rows.has(g.name))
        rows.set(g.name, {
          group: g.name,
          length: 0,
          entities: 0,
          in_blocks: 0,
          approximated: false,
        });
  const out: Row[] = [...rows.values()]
    .sort((a, b) => b.length - a.length || a.group.localeCompare(b.group))
    .map((r) => ({
      group: r.group,
      length: metres(r.length * factor),
      entities: r.entities,
      in_blocks: metres(r.in_blocks * factor),
      basis: r.approximated
        ? 'approximated: splines flattened'
        : region
          ? 'measured, cut to the region'
          : 'measured',
    }));
  const total = metres(
    [...rows.values()].reduce((s, r) => s + r.length, 0) * factor,
  );
  const shown = full ? out : out.slice(0, limit);
  const geometry = { length_mode, ...elevationFields(elevation) };
  const saved = save(input.io, str(input.values, 'save'), {
    ...geometry,
    groups: out,
  });
  return listOutput({
    key: 'groups',
    summary: out.length
      ? `${shown.length} of ${out.length} ${groups ? 'groups' : `${by}s`}, ${total} m in all`
      : '0 lines, arcs or polylines in that space',
    head: {
      space,
      lengths: unitNote,
      ...geometry,
      ...(region ? { region: str(input.values, 'region') } : {}),
      ...(hidden.entities
        ? {
            left_out: `${metres(hidden.length * factor)} m in ${hidden.entities} entities on layers that are off or frozen; --all includes them`,
          }
        : {}),
      ...(saved ? { saved } : {}),
    },
    rows: shown,
    columns: ['group', 'length', 'entities', 'in_blocks', 'basis'],
    help: out.length
      ? [
          'in_blocks is the part drawn inside block inserts, such as fittings; it is included in length',
          'Run `cad-axi measure <file> --by size --layer <layer>` for length by pipe size',
        ]
      : [
          'Run `cad-axi info <file>` for what the drawing holds',
          'Run `cad-axi measure <file> --space <layout>` for a paper space layout',
        ],
    full,
    narrower: '--layer, --group or --limit',
  });
}

export async function runs(input: CommandInput): Promise<string> {
  const { drawing: d } = await load(input, fileArg(input), true);
  const units = unitsOf(d.header.insunits, str(input.values, 'units'));
  const factor = needMetres(units);
  const { owners, name: space } = spaceOf(d, input.values);
  const groups = groupsOf(input, d, true) as Group[];
  const all = input.values.all === true;
  const gap = gapOf(input, factor);
  const r = runsOf(input, d, owners, groups, all, gap);
  const min =
    str(input.values, 'min') === undefined
      ? 0
      : positiveNumber(input.values, 'min', 1, 1e9);
  const kept = r.runs
    .filter((x) => x.length >= min)
    .sort((a, b) => b.length - a.length);
  const full = input.values.full === true;
  const limit = positiveInt(input.values, 'limit', 20);
  const shown = full ? kept : kept.slice(0, limit);
  const ends = (run: Run) =>
    run.ends ? `${at(run.ends[0])} to ${at(run.ends[1])}` : 'closed loop';
  const rows: Row[] = shown.map((run) => ({
    run: run.id,
    group: run.group,
    length: metres(run.length * factor),
    size: run.size ?? (run.basis === 'conflict' ? 'conflicting labels' : null),
    ends: ends(run),
    ...(full
      ? {
          pieces: run.pieces.length,
          in_blocks: metres(run.inBlocks * factor),
          labels: run.labels.join(' | ') || null,
        }
      : {}),
  }));
  const sized = kept.filter((x) => x.size).length;
  const geometry = {
    length_mode: lengthMode(input.values['3d'] === true),
    ...elevationFields(r.elevation),
  };
  const saved = save(input.io, str(input.values, 'save'), {
    ...geometry,
    runs: kept.map((run) => ({
      run: run.id,
      group: run.group,
      length_m: metres(run.length * factor),
      size: run.size,
      basis: run.basis,
      labels: run.labels,
      ends: run.ends,
      handles: run.pieces.map((p) => p.item.e.h),
    })),
  });
  return listOutput({
    key: 'runs',
    summary: kept.length
      ? `${shown.length} of ${kept.length} runs, ${sized} sized by a label`
      : '0 runs on those layers',
    head: {
      space,
      lengths: `metres, from ${units.name}`,
      ...geometry,
      gap: `${round(gap, 6)} drawing units`,
      reach: `${r.reach} text heights`,
      ...(r.hidden.entities
        ? {
            left_out: `${r.hidden.entities} entities on layers that are off or frozen; --all includes them`,
          }
        : {}),
      ...(saved ? { saved } : {}),
    },
    rows,
    columns: full
      ? [
          'run',
          'group',
          'length',
          'size',
          'ends',
          'pieces',
          'in_blocks',
          'labels',
        ]
      : ['run', 'group', 'length', 'size', 'ends'],
    help: kept.length
      ? [
          'Run `cad-axi measure <file> --by size --layer <layer>` for the totals by size',
          'Run `cad-axi render <file> --out runs.svg --layer <layer>` to look at them',
        ]
      : ['Run `cad-axi layers <file>` for the layers that hold lines'],
    full,
    narrower: '--min, --layer or --limit',
  });
}
