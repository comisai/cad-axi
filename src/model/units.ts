// Drawing units: the $INSUNITS code a file states, or --units. Nothing is
// assumed: a file that states none, with no --units, has no unit.

import { AxiError, usage } from '../errors.ts';

const SURVEY_FOOT = 1200 / 3937;

/** $INSUNITS codes: name and metres per unit. */
export const INSUNITS: Record<number, [string, number]> = {
  1: ['in', 0.0254],
  2: ['ft', 0.3048],
  3: ['mi', 1609.344],
  4: ['mm', 0.001],
  5: ['cm', 0.01],
  6: ['m', 1],
  7: ['km', 1000],
  8: ['microinch', 2.54e-8],
  9: ['mil', 2.54e-5],
  10: ['yd', 0.9144],
  11: ['angstrom', 1e-10],
  12: ['nm', 1e-9],
  13: ['micron', 1e-6],
  14: ['dm', 0.1],
  15: ['dam', 10],
  16: ['hm', 100],
  17: ['Gm', 1e9],
  18: ['au', 1.495978707e11],
  19: ['light-year', 9.4607304725808e15],
  20: ['parsec', 3.085677581491367e16],
  21: ['us-ft', SURVEY_FOOT],
  22: ['us-in', SURVEY_FOOT / 12],
  23: ['us-yd', SURVEY_FOOT * 3],
  24: ['us-mi', SURVEY_FOOT * 5280],
};

const GIVEN: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export interface Units {
  /** The unit's short name, or null when unknown. */
  name: string | null;
  /** Metres per drawing unit, or null when unknown. */
  metres: number | null;
  /** Where the unit came from. */
  basis: 'file' | 'given' | 'unknown';
}

export function unitsOf(insunits: number, given: string | undefined): Units {
  if (given !== undefined) {
    const m = Object.hasOwn(GIVEN, given) ? GIVEN[given] : undefined;
    if (m === undefined) throw usage('--units takes mm, cm, m, in or ft.');
    return { name: given, metres: m, basis: 'given' };
  }
  const found = INSUNITS[insunits];
  if (!found) return { name: null, metres: null, basis: 'unknown' };
  return { name: found[0], metres: found[1], basis: 'file' };
}

/** A unit supported by --units whose conversion matches the evidence. */
export function matchingUnit(
  metres: number,
  tolerance: number,
): string | undefined {
  return Object.entries(GIVEN).find(
    ([, factor]) => Math.abs(metres / factor - 1) <= tolerance,
  )?.[0];
}

/** Metres per unit, or `units_unknown`. */
export function needMetres(u: Units): number {
  if (u.metres === null)
    throw new AxiError(
      'units_unknown',
      'The drawing states no units. Run `cad-axi info <file>` for dimension and scale evidence, then pass --units mm, cm, m, in or ft.',
    );
  return u.metres;
}

/** A length in metres to the millimetre. */
export const metres = (v: number): number => Math.round(v * 1000) / 1000;
