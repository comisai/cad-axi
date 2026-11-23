import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Entity, P3 } from '../../src/model/drawing.ts';
import {
  apply,
  conicLength,
  insertMatrix,
  lengthIn,
  ocs,
  type Prim,
  primEnds,
  primLength,
  primsOf,
  transformPrim,
} from '../../src/model/geometry.ts';
import {
  controlCodes,
  decodeText,
  keyboardStyles,
  mtextPlain,
  unicodeEscapes,
} from '../../src/model/text.ts';
import { unitsOf } from '../../src/model/units.ts';
import { codeOf, sizeOf } from '../../src/takeoff/sizes.ts';
import { VERSION } from '../../src/version.ts';

const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const nearP = (a: P3, b: P3, tol = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i] as number, b[i] as number, tol);
};
const ent = (e: Partial<Entity>): Entity => ({
  h: '1',
  kind: 'LINE',
  layer: '0',
  owner: '*Model_Space',
  color: 256,
  lt: 'ByLayer',
  ...e,
});
const len = (
  e: Partial<Entity>,
  m = insertMatrix(ent({ kind: 'INSERT', at: [0, 0, 0] }), [0, 0, 0]),
) => primsOf(ent(e)).reduce((s, p) => s + primLength(transformPrim(p, m)), 0);

describe('geometry', () => {
  it('a polyline bulge is an arc: a quarter circle of radius 1000', () => {
    const e = {
      kind: 'LWPOLYLINE',
      pts: [
        [1000, 0],
        [2000, 1000],
      ],
      bulges: [Math.tan(Math.PI / 8), 0],
    };
    near(len(e), (1000 * Math.PI) / 2);
    const [p] = primsOf(ent(e)) as [Prim];
    nearP(primEnds(p)[1], [2000, 1000, 0], 1e-9);
  });

  it('a negative bulge turns clockwise; a bulge of 1 is a half circle', () => {
    near(
      len({
        kind: 'LWPOLYLINE',
        pts: [
          [0, 0],
          [2, 0],
        ],
        bulges: [-1, 0],
      }),
      Math.PI,
    );
    near(
      len({
        kind: 'LWPOLYLINE',
        pts: [
          [0, 0],
          [2, 0],
        ],
        bulges: [1, 0],
      }),
      Math.PI,
    );
  });

  it('a closed polyline adds its closing piece', () => {
    near(
      len({
        kind: 'LWPOLYLINE',
        pts: [
          [0, 0],
          [10, 0],
          [10, 5],
        ],
        closed: true,
      }),
      10 + 5 + Math.hypot(10, 5),
    );
  });

  it('arcs measure their sweep, across zero too', () => {
    near(
      len({
        kind: 'ARC',
        c: [0, 0, 0],
        r: 2,
        a0: (3 * Math.PI) / 2,
        a1: Math.PI / 2,
      }),
      2 * Math.PI,
    );
    near(len({ kind: 'CIRCLE', c: [5, 5, 0], r: 1 }), 2 * Math.PI);
  });

  it('an ellipse is integrated: a circle exactly, a 2:1 ellipse to Ramanujan', () => {
    near(
      len({
        kind: 'ELLIPSE',
        c: [0, 0, 0],
        major: [3, 0, 0],
        ratio: 1,
        t0: 0,
        t1: 2 * Math.PI,
      }),
      6 * Math.PI,
    );
    const a = 2;
    const b = 1;
    const h = (a - b) ** 2 / (a + b) ** 2;
    const ramanujan =
      Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    near(
      len({
        kind: 'ELLIPSE',
        c: [0, 0, 0],
        major: [2, 0, 0],
        ratio: 0.5,
        t0: 0,
        t1: 2 * Math.PI,
      }),
      ramanujan,
      1e-6,
    );
  });

  it('a spline is flattened to its tolerance: a straight one measures exactly', () => {
    const e = {
      kind: 'SPLINE',
      degree: 3,
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      ctrl: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
      ] as P3[],
    };
    near(len(e), 3, 1e-9);
  });

  it('the arbitrary axis rule: normal (0,0,-1) mirrors x', () => {
    nearP(apply(ocs([0, 0, -1]), [1, 2, 0]), [-1, 2, 0]);
    nearP(apply(ocs([0, 0, 1]), [1, 2, 3]), [1, 2, 3]);
  });

  it('a rotated, scaled, mirrored insert measures right', () => {
    const line = { kind: 'LINE', a: [0, 0, 0] as P3, b: [1000, 0, 0] as P3 };
    const rotated = insertMatrix(
      ent({
        kind: 'INSERT',
        at: [500, 0, 0],
        rot: Math.PI / 2,
        sx: 2,
        sy: 2,
        sz: 1,
      }),
      [0, 0, 0],
    );
    near(len(line, rotated), 2000);
    const [p] = primsOf(ent(line)).map((q) => transformPrim(q, rotated)) as [
      Prim,
    ];
    nearP(primEnds(p)[1], [500, 2000, 0], 1e-9);
    const mirrored = insertMatrix(
      ent({ kind: 'INSERT', at: [0, 0, 0], sx: -1, sy: 1, sz: 1 }),
      [0, 0, 0],
    );
    near(len(line, mirrored), 1000);
    const arc = { kind: 'ARC', c: [0, 0, 0] as P3, r: 100, a0: 0, a1: Math.PI };
    const squashed = insertMatrix(
      ent({ kind: 'INSERT', at: [0, 0, 0], sx: 2, sy: 1, sz: 1 }),
      [0, 0, 0],
    );
    // An arc scaled unevenly is half an ellipse of axes 200 and 100.
    near(len(arc, squashed), 0.5 * 4.844224110273838 * 200, 1e-6);
  });

  it('a block base point is honoured', () => {
    const m = insertMatrix(ent({ kind: 'INSERT', at: [10, 10, 0] }), [5, 5, 0]);
    nearP(apply(m, [5, 5, 0]), [10, 10, 0]);
  });

  it('measures a tilted conic after projection, including a reversal in XY', () => {
    const phase = 0.3;
    const conic: Prim = {
      t: 'conic',
      c: [0, 0, 0],
      M: [Math.cos(phase), 0, Math.sin(phase)],
      m: [-Math.sin(phase), 0, Math.cos(phase)],
      t0: 0,
      t1: 2 * Math.PI,
    };
    near(primLength(conic), 4);
    near(primLength(conic, true), 2 * Math.PI);
    near(lengthIn(conic, { x0: 0, y0: -1, x1: 2, y1: 1 }), 2, 1e-4);
  });

  it('a region keeps the part inside', () => {
    const seg: Prim = { t: 'seg', a: [0, 0, 0], b: [10, 0, 0] };
    near(lengthIn(seg, { x0: 2, y0: -1, x1: 5, y1: 1 }), 3);
    near(lengthIn(seg, { x0: 20, y0: -1, x1: 25, y1: 1 }), 0);
    const circle = primsOf(
      ent({ kind: 'CIRCLE', c: [0, 0, 0], r: 1 }),
    )[0] as Prim;
    near(lengthIn(circle, { x0: 0, y0: -2, x1: 2, y1: 2 }), Math.PI, 1e-4);
    near(conicLength(circle as Extract<Prim, { t: 'conic' }>), 2 * Math.PI);
  });
});

describe('text', () => {
  it('%% codes and \\U+ escapes', () => {
    assert.equal(controlCodes('%%c110 %%d %%p0.5 %%%'), 'Ø110 ° ±0.5 %');
    assert.equal(unicodeEscapes('\\U+05E9\\U+05DC'), 'של');
  });

  it('MTEXT codes are removed and kept apart from the text', () => {
    assert.equal(mtextPlain('{\\fArial|b0|i0;Hello}\\PWorld'), 'Hello\nWorld');
    assert.equal(mtextPlain('\\H2.5x;\\C1;Red \\Lunder\\l'), 'Red under');
    assert.equal(mtextPlain('1\\S1^2;" pipe'), '11/2" pipe');
    assert.equal(mtextPlain('a\\\\b \\{c\\}'), 'a\\b {c}');
    assert.equal(decodeText('{\\fArial;\\U+05E6}', true, false).text, 'צ');
  });

  it('Hebrew on Latin keys is decoded only for a keyboard style, and marked', () => {
    assert.deepEqual(decodeText('chuc', false, true), {
      text: 'ביוב',
      decoded: 'keyboard',
    });
    assert.deepEqual(decodeText('chuc', false, false), {
      text: 'chuc',
      decoded: null,
    });
  });

  it('Latin text that must not change', () => {
    for (const t of [
      'PVC pipe',
      'SAN 110',
      'F-Ø3"',
      'DN100',
      'see note 4',
      'Q= 30 m \\h',
      'UP',
      'CW1',
    ])
      assert.equal(decodeText(t, false, true).text, t, t);
  });

  it('keeps logical Hebrew and size labels in reading order', () => {
    assert.equal(decodeText('משאבה 4/8"', false, false).text, 'משאבה 4/8"');
    assert.equal(decodeText('chuc "8/4', false, true).text, 'ביוב 4/8"');
    assert.equal(decodeText('chuc 4/8"', false, true).text, 'ביוב 4/8"');
  });

  it('a keyboard style is chosen by its font or by most of its texts', () => {
    const styles = [
      { name: 'H', font: 'hebrew.shx', kind: 'shx' },
      { name: 'R', font: 'romans.shx', kind: 'shx' },
      { name: 'T', font: 'arial.ttf', kind: 'ttf' },
    ];
    const samples = [
      { style: 'R', raw: 'chuc' },
      { style: 'R', raw: 'nhoh' },
      { style: 'R', raw: 'tnhb' },
      { style: 'T', raw: 'chuc' },
    ];
    assert.deepEqual([...keyboardStyles(styles, samples)].sort(), ['H', 'R']);
  });
});

describe('sizes and units', () => {
  it('reads pipe sizes as drawing-axi does', () => {
    assert.equal(sizeOf('Ø110'), 'Ø110');
    assert.equal(sizeOf('Ø160-1%'), 'Ø160');
    assert.equal(sizeOf('F-Ø3"'), '3"');
    assert.equal(sizeOf('1 1/2"'), '1 1/2"');
    assert.equal(sizeOf('DN 100'), 'DN100');
    assert.equal(sizeOf('note 3'), null);
    assert.equal(codeOf('C.W.2-'), 'CW');
  });

  it('units come from the file, or --units, never assumed', () => {
    assert.deepEqual(unitsOf(4, undefined), {
      name: 'mm',
      metres: 0.001,
      basis: 'file',
    });
    assert.deepEqual(unitsOf(0, undefined), {
      name: null,
      metres: null,
      basis: 'unknown',
    });
    assert.deepEqual(unitsOf(0, 'ft'), {
      name: 'ft',
      metres: 0.3048,
      basis: 'given',
    });
    assert.throws(() => unitsOf(0, 'parsec'), /--units takes/);
  });

  it('the version matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
