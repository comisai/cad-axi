import type { Drawing, Entity, P3 } from './drawing.ts';
import { INSUNITS, matchingUnit, unitsOf } from './units.ts';

export function insertScale(e: Entity): P3 | undefined {
  if (e.sx === undefined || e.sy === undefined || e.sz === undefined) return;
  return [e.sx, e.sy, e.sz];
}

/** Paper drawing units per model drawing unit. Viewport 1 is the paper view. */
export function viewportScale(e: Entity): number | undefined {
  if (e.id === 1 || !(e.ht && e.ht > 0 && e.view_height && e.view_height > 0))
    return;
  const ratio = e.ht / e.view_height;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

function dimensionUnits(e: Entity): string | undefined {
  if (e.measurement_kind !== 'length' || !(e.measurement && e.measurement > 0))
    return;
  const text = e.text ?? '';
  // A dimension may replace the measured number, or use <> to display the
  // drawn length multiplied by DIMLFAC. Only explicit length units count.
  const explicit = /^\s*(\d+(?:[.,]\d{1,2}|\.\d+)?|<>)\s*(mm|cm|m|in|ft)\s*$/i;
  const match =
    explicit.exec(text) ??
    (text === '' || text === '<>'
      ? explicit.exec(`<> ${e.dimension_suffix ?? ''}`)
      : null);
  if (!match) return;
  const number = match[1] as string;
  if (number === '<>' && !(e.dimension_factor && e.dimension_factor > 0))
    return;
  const unit = (match[2] as string).toLowerCase();
  const factor = unitsOf(0, unit).metres as number;
  const metresPerUnit =
    number === '<>'
      ? (e.dimension_factor as number) * factor
      : (Number(number.replace(',', '.')) * factor) / e.measurement;
  return matchingUnit(metresPerUnit, 0.02);
}

export function unitEvidence(d: Drawing, full: boolean) {
  const limit = full ? 20 : 3;
  const layouts = new Map(d.header.layouts.map((l) => [l.block, l.name]));
  const model = d.header.layouts.find(
    (l) => l.name.toLowerCase() === 'model',
  )?.block;
  const dimensions: Array<Record<string, unknown>> = [];
  const references: Array<Record<string, unknown>> = [];
  const viewports: Array<Record<string, unknown>> = [];
  const possible = new Map<string, Set<string>>();
  let dimensionCount = 0;
  let referenceCount = 0;
  let viewportCount = 0;
  const record = (
    sample: Array<Record<string, unknown>>,
    row: Record<string, unknown>,
    unit: string | undefined,
    basis: string,
  ) => {
    if (unit) {
      const sources = possible.get(unit) ?? new Set<string>();
      sources.add(basis);
      possible.set(unit, sources);
    }
    if (sample.length < limit) sample.push({ ...row, implied_units: unit });
    else if (unit) {
      const i = sample.findIndex((v) => v.implied_units === undefined);
      if (i >= 0) sample[i] = { ...row, implied_units: unit };
    }
  };

  for (const e of d.entities) {
    const layout = layouts.get(e.owner);
    if (layout === undefined) continue;
    if (e.kind === 'DIMENSION') {
      dimensionCount++;
      record(
        dimensions,
        {
          h: e.h,
          layout,
          drawn: e.measurement,
          kind: e.measurement_kind,
          text: e.text || '<>',
          display_factor: e.dimension_factor,
          style_suffix: e.dimension_suffix,
        },
        e.owner === model ? dimensionUnits(e) : undefined,
        'model dimension',
      );
    } else if (e.kind === 'INSERT' && e.block) {
      const block = d.blocks.get(e.block);
      if (!block?.external) continue;
      referenceCount++;
      const scale = insertScale(e);
      const unit = INSUNITS[block.units ?? 0];
      const magnitude = scale?.map(Math.abs);
      const x = magnitude?.[0];
      const uniform = x && magnitude?.every((n) => Math.abs(n / x - 1) <= 1e-9);
      const implied =
        e.owner === model && unit && x && uniform
          ? matchingUnit(unit[1] / x, 1e-6)
          : undefined;
      // A scale can still be interpreted once the source drawing's unit is
      // known. Report the common case of a reference drawn in metres.
      const ifMetres =
        e.owner === model && !unit && x && uniform
          ? matchingUnit(1 / x, 1e-6)
          : undefined;
      record(
        references,
        {
          h: e.h,
          layout,
          block: e.block,
          scale,
          reference_units: unit?.[0] ?? 'not stated',
          host_units_if_reference_is_metres: ifMetres,
        },
        implied,
        'scaled external reference',
      );
    } else if (e.kind === 'VIEWPORT') {
      const ratio = viewportScale(e);
      if (ratio === undefined) continue;
      viewportCount++;
      if (viewports.length < limit)
        viewports.push({
          h: e.h,
          layout,
          paper_height: e.ht,
          model_height: e.view_height,
          paper_per_model: ratio,
        });
    }
  }
  const units = [...possible.keys()];
  const candidate = units.length === 1 ? units[0] : undefined;
  const declared = INSUNITS[d.header.insunits]?.[0];
  const suggestion_basis =
    units.length > 1 || (declared && units.some((unit) => unit !== declared))
      ? `Conflicting unit evidence: ${[...new Set([...(declared ? [declared] : []), ...units])].join(', ')}. Confirm the unit with the drawing owner.`
      : candidate
        ? `From ${[...(possible.get(candidate) ?? [])].join(' and ')}. Confirm before using --units.`
        : declared
          ? undefined
          : 'No model dimension or scaled reference established a unit. Check the title block or confirm with the drawing owner.';
  return {
    suggested_units: declared ? undefined : candidate,
    suggestion_basis,
    dimensions,
    dimension_count: dimensionCount,
    references,
    reference_count: referenceCount,
    viewports,
    viewport_count: viewportCount,
  };
}
