// A picture of a space as SVG (design §8.5). Nothing from the file goes into
// the SVG but numbers and escaped text: no links, scripts, images or fonts.

import type { P3 } from '../model/drawing.ts';
import { apply, type Box, primPoints } from '../model/geometry.ts';
import type { TextItem } from '../model/texts.ts';

export interface Shape {
  points: P3[];
  closed: boolean;
  color: string;
}

/** AutoCAD colour index to RGB, with 7 drawn dark on the white page. */
export function aciColor(index: number, rgb?: string): string {
  if (rgb && /^#[0-9a-f]{6}$/i.test(rgb)) return rgb;
  const base: Record<number, string> = {
    1: '#ff0000',
    2: '#d4b000',
    3: '#00a000',
    4: '#00a0a0',
    5: '#0000ff',
    6: '#c000c0',
    7: '#000000',
    8: '#808080',
    9: '#a0a0a0',
  };
  if (base[index]) return base[index] as string;
  if (index >= 250 && index <= 255) {
    const g = [51, 80, 105, 130, 160, 190][index - 250] as number;
    return `#${g.toString(16).padStart(2, '0').repeat(3)}`;
  }
  if (index >= 10 && index <= 249) {
    const hue = Math.floor((index - 10) / 10) * 15;
    const v = (index - 10) % 10;
    const value = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][v] as number;
    const sat = v % 2 === 0 ? 1 : 0.5;
    const c = value * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = value - c;
    const [r, g, b] =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x];
    const hex = (n: number) =>
      Math.round((n + m) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return '#000000';
}

const escapeXml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

const n = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);

export function boxOf(
  shapes: readonly Shape[],
  texts: readonly TextItem[],
): Box | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const see = (p: readonly number[]) => {
    const x = p[0] as number;
    const y = p[1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const s of shapes) for (const p of s.points) see(p);
  for (const t of texts) see(t.at);
  if (!Number.isFinite(x0)) return null;
  if (x1 === x0) x1 = x0 + 1;
  if (y1 === y0) y1 = y0 + 1;
  return { x0, y0, x1, y1 };
}

export function svg(
  shapes: readonly Shape[],
  texts: readonly TextItem[],
  box: Box,
  width: number,
): string {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const k = width / w;
  const height = Math.max(1, Math.round(h * k));
  const X = (x: number) => n((x - box.x0) * k);
  const Y = (y: number) => n((box.y1 - y) * k);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
  ];
  for (const s of shapes) {
    if (s.points.length < 2) {
      const p = s.points[0];
      if (p)
        parts.push(
          `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="1.5" fill="${s.color}"/>`,
        );
      continue;
    }
    const d = s.points
      .map((p, i) => `${i ? 'L' : 'M'}${X(p[0])} ${Y(p[1])}`)
      .join('');
    parts.push(
      `<path d="${d}${s.closed ? 'Z' : ''}" fill="none" stroke="${s.color}" stroke-width="1"/>`,
    );
  }
  for (const t of texts) {
    const size = n(Math.max(1, t.height * k));
    const angle = n((-t.rotation * 180) / Math.PI);
    const first = t.text.split('\n')[0] ?? '';
    parts.push(
      `<text x="${X(t.at[0])}" y="${Y(t.at[1])}" font-size="${size}" font-family="sans-serif" fill="#303030" transform="rotate(${angle} ${X(t.at[0])} ${Y(t.at[1])})">${escapeXml(first)}</text>`,
    );
  }
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

/** Outline points of a hatch loop or a solid, placed in the world. */
export function placed(
  points: readonly number[][],
  m: readonly number[],
  z = 0,
): P3[] {
  return points.map((p) => apply(m, [p[0] ?? 0, p[1] ?? 0, p[2] ?? z]));
}

export { primPoints };
