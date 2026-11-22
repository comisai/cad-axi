// Pipe sizes from the labels written beside runs (design §8.4): "Ø160-1%",
// "F-Ø3"", "DN100". The size patterns come from drawing-axi. In a CAD file
// the reach is a multiple of the label's text height, which tracks the
// plotted size without knowing the plot scale.
//
// - A label sizes the one run that fits it best: near it, along it.
// - A label with a system code sizes only runs of the group with that code.
// - A label that fits runs of two groups about equally sizes neither.
// - An unlabelled run stays unsized. No size is ever guessed.

import type { P3 } from '../model/drawing.ts';
import { directionNear, distanceTo } from '../model/geometry.ts';
import type { Run } from './runs.ts';

const METRIC = /Ø\s*(\d{1,4}(?:\.\d+)?)(?!\s*["\d.])/;
const INCH = /(?:Ø\s*)?(\d{1,2}(?:\.\d+)?(?:\s*\d\/\d)?|\d\/\d)\s*"/;
const DN = /\bDN\s*(\d{2,4})\b/i;
const PREFIX = /^[A-Za-z][A-Za-z0-9.]{0,5}\s*-/;

/** The letters before the first digit, dots left out: "C.W.2-" is CW. */
export function codeOf(text: string): string | null {
  const head = /^[^0-9]*/.exec(text)?.[0] ?? '';
  const letters = head.replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters || null;
}

/** The pipe size a label states, normalised: Ø110, 3", DN100; or null. */
export function sizeOf(text: string): string | null {
  const t = text.trim();
  const dn = DN.exec(t);
  if (dn) return `DN${dn[1]}`;
  const inch = INCH.exec(t);
  const metric = METRIC.exec(t);
  if (inch && (!metric || inch.index <= metric.index))
    return `${(inch[1] as string).replace(/\s+/g, ' ')}"`;
  if (metric) return `Ø${metric[1]}`;
  return null;
}

export interface SizeLabel {
  size: string;
  text: string;
  code: string | null;
  /** The middle of the label, world coordinates. */
  x: number;
  y: number;
  height: number;
  /** Direction of the text, radians. */
  rotation: number;
  h: string;
}

export interface LabelInput {
  text: string;
  at: P3;
  height: number;
  rotation: number;
  h: string;
  /** MTEXT and attributes are placed by their corner; TEXT by its baseline start. */
}

export function sizeLabels(texts: readonly LabelInput[]): SizeLabel[] {
  const out: SizeLabel[] = [];
  for (const t of texts) {
    // One label that lists several sizes is a legend line, not a pipe's size.
    if ((t.text.match(/Ø/g)?.length ?? 0) > 1) continue;
    const size = sizeOf(t.text);
    if (!size || !(t.height > 0)) continue;
    const prefix = PREFIX.exec(t.text.trim());
    // The middle of a one-line label: half its estimated width along the
    // text, half its height across it.
    const width = [...t.text.trim()].length * t.height * 0.7;
    const cx =
      t.at[0] +
      Math.cos(t.rotation) * (width / 2) -
      Math.sin(t.rotation) * (t.height / 2);
    const cy =
      t.at[1] +
      Math.sin(t.rotation) * (width / 2) +
      Math.cos(t.rotation) * (t.height / 2);
    out.push({
      size,
      text: t.text.trim(),
      code: prefix ? codeOf(prefix[0]) : null,
      x: cx,
      y: cy,
      height: t.height,
      rotation: t.rotation,
      h: t.h,
    });
  }
  return out;
}

export interface SizedRun extends Run {
  size: string | null;
  basis: 'label' | 'conflict' | 'none';
  labels: string[];
}

export interface Placement {
  /** Labels that sized a run. */
  placed: number;
  /** The run each placed label sized, by index. */
  onRun: number[];
  /** Labels near runs of two groups, which sized neither. */
  shared: SizeLabel[];
  /** Labels with no run within reach. */
  missed: SizeLabel[];
}

/** How well a direction matches a label's: 0 along it, 1 across it. */
function across(direction: number, rotation: number): number {
  const d = Math.abs(Math.sin(direction - rotation));
  return d;
}

export function sizeRuns(
  runs: readonly Run[],
  labels: readonly SizeLabel[],
  reach: number,
): { runs: SizedRun[]; placement: Placement } {
  const votes = runs.map(() => new Map<string, string[]>());
  const placement: Placement = { placed: 0, onRun: [], shared: [], missed: [] };
  const groupCodes = new Map<string, string>();
  for (const r of runs) {
    const code = codeOf(r.group.replace(/[^A-Za-z]/g, '')) ?? '';
    groupCodes.set(r.group, code);
  }
  const coded = new Set([...groupCodes.values()]);
  for (const label of labels) {
    const limit = reach * label.height;
    const candidates: Array<{ run: number; score: number }> = [];
    runs.forEach((run, i) => {
      if (
        label.code &&
        coded.has(label.code) &&
        groupCodes.get(run.group) !== label.code
      )
        return;
      if (label.code && !coded.has(label.code)) return;
      let best = Number.POSITIVE_INFINITY;
      let along = 1;
      for (const piece of run.pieces)
        for (const prim of piece.prims) {
          const d = distanceTo(prim, label.x, label.y);
          if (d < best) {
            best = d;
            along = across(
              directionNear(prim, label.x, label.y),
              label.rotation,
            );
          }
        }
      if (best > limit) return;
      // A run written along the label fits it best; one across it only when close.
      if (along > 0.5 && best > label.height) return;
      candidates.push({ run: i, score: best * (1 + along * 2) });
    });
    if (!candidates.length) {
      placement.missed.push(label);
      continue;
    }
    candidates.sort((a, b) => a.score - b.score);
    const first = candidates[0] as { run: number; score: number };
    const rival = candidates.find(
      (c) => (runs[c.run] as Run).group !== (runs[first.run] as Run).group,
    );
    if (rival && rival.score <= first.score * 1.25 + 1e-9) {
      placement.shared.push(label);
      continue;
    }
    const v = votes[first.run] as Map<string, string[]>;
    const list = v.get(label.size) ?? [];
    list.push(label.text);
    v.set(label.size, list);
    placement.placed++;
    placement.onRun.push(first.run);
  }
  const sized: SizedRun[] = runs.map((run, i) => {
    const v = votes[i] as Map<string, string[]>;
    if (!v.size) return { ...run, size: null, basis: 'none', labels: [] };
    const ranked = [...v.entries()].sort((a, b) => b[1].length - a[1].length);
    const top = ranked[0] as [string, string[]];
    const next = ranked[1];
    if (next && next[1].length === top[1].length)
      return {
        ...run,
        size: null,
        basis: 'conflict',
        labels: ranked.flatMap((r) => r[1]),
      };
    return { ...run, size: top[0], basis: 'label', labels: top[1] };
  });
  return { runs: sized, placement };
}
