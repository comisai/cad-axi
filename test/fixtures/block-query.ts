import { writeDxf } from './dxf.ts';

export const overlaySpec = {
  layers: [{ name: 'MARK', color: 1 }],
  entities: [{ kind: 'line', layer: 'MARK', from: [0, 0], to: [1, 0] }],
};

export function blockQueryDxf(): Buffer {
  return writeDxf({
    units: 0,
    layers: [
      { name: 'SYMBOLS', color: 2 },
      { name: 'FRAME|WALLS', color: 3, dependent: true },
      { name: 'FRAME|GRID', color: 4, dependent: true },
    ],
    blocks: [
      {
        name: 'VALVE',
        entities: [{ kind: 'INSERT', layer: '0', block: 'CAP', at: [0, 0] }],
      },
      { name: 'CAP', entities: [] },
      { name: 'SPARE', entities: [] },
    ],
    xrefs: [{ name: 'FRAME', path: 'refs/frame.dwg' }],
    model: [
      { kind: 'INSERT', layer: 'SYMBOLS', block: 'VALVE', at: [0, 0] },
      {
        kind: 'INSERT',
        layer: 'SYMBOLS',
        block: 'VALVE',
        at: [-10, 0],
        scale: [2, 3, -4],
        normal: [0, 0, -1],
      },
      { kind: 'INSERT', layer: 'SYMBOLS', block: 'CAP', at: [20, 0] },
      {
        kind: 'INSERT',
        layer: '0',
        block: 'FRAME',
        at: [30, 0],
        scale: [100, 100, 100],
      },
      { kind: 'LINE', layer: '0', from: [-5, 0], to: [30, 0] },
    ],
    paper: [{ kind: 'INSERT', layer: 'SYMBOLS', block: 'CAP', at: [0, 0] }],
  });
}
