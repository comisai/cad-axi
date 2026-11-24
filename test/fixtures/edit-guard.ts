import { writeDxf } from './dxf.ts';

/** A reconstruction of the R27 one-line upload from the reported version, units and length. */
export function minimalEditDxf(length: number): string {
  return [
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1015'],
    [9, '$INSUNITS'],
    [70, 4],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    [0, 'LINE'],
    [5, '100'],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbLine'],
    [10, 0],
    [20, 0],
    [30, 0],
    [11, length],
    [21, 0],
    [31, 0],
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]
    .map(([code, value]) => `${code}\n${value}\n`)
    .join('');
}

export function structuredEditDxf(): Buffer {
  return writeDxf({
    units: 4,
    layers: [{ name: 'MARK', color: 3 }],
    blocks: [
      {
        name: 'SYMBOL',
        entities: [{ kind: 'CIRCLE', layer: '0', center: [0, 0], radius: 10 }],
      },
    ],
    model: [{ kind: 'LINE', layer: '0', from: [0, 0], to: [250, 0] }],
    paper: [{ kind: 'POINT', layer: 'MARK', at: [10, 10] }],
  });
}

export function resizeLineOps(handle: string) {
  return {
    ops: [
      { op: 'delete', h: handle },
      { op: 'add_line', from: [0, 0], to: [300, 0] },
    ],
  };
}

/** Add an authored dictionary that ACadSharp's DXF writer drops because it is empty. */
export function dxfWithEmptyDictionary(): string {
  const text = structuredEditDxf().toString('ascii');
  const root =
    /(\r\n2\r\nOBJECTS\r\n0\r\nDICTIONARY\r\n5\r\n)([A-F0-9]+)(\r\n330\r\n0\r\n100\r\nAcDbDictionary\r\n281\r\n1\r\n)/;
  const handle = root.exec(text)?.[2];
  if (!handle) throw new Error('missing fixture root dictionary');
  const child = [
    0,
    'DICTIONARY',
    5,
    'F000',
    330,
    handle,
    100,
    'AcDbDictionary',
    281,
    1,
    '',
  ].join('\r\n');
  return text
    .replace(root, '$&3\r\nPROJECT_INDEX\r\n350\r\nF000\r\n')
    .replace(/0\r\nENDSEC\r\n0\r\nEOF\r\n$/, `${child}$&`);
}
