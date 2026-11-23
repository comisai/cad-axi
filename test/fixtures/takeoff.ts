import type { DxfDrawing, Ent } from './dxf.ts';

/** Independent bays with a pipe run, its size label and nearby unrelated arcs. */
export function takeoffBays(count: number): DxfDrawing {
  const model: Ent[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i % 64) * 500;
    const y = Math.floor(i / 64) * 500;
    model.push(
      { kind: 'LINE', layer: 'PIPE', from: [x, y], to: [x + 50, y] },
      { kind: 'LINE', layer: 'PIPE', from: [x + 50, y], to: [x + 100, y] },
      {
        kind: 'TEXT',
        layer: 'NOTES',
        at: [x + 40, y + 1],
        height: 2,
        value: 'DN80',
      },
      {
        kind: 'ARC',
        layer: 'OUTLINE',
        center: [x, y + 60],
        radius: 10,
        start: 1,
        end: 88,
      },
      {
        kind: 'ARC',
        layer: 'OUTLINE',
        center: [x + 50, y + 60],
        radius: 20,
        start: 1,
        end: 178,
      },
    );
  }
  return {
    units: 4,
    layers: [
      { name: 'PIPE', color: 2 },
      { name: 'NOTES', color: 1 },
      { name: 'OUTLINE', color: 3 },
    ],
    model,
  };
}
