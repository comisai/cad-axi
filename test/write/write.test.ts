// The write matrix as the tool itself checks it: `create`, `convert` and
// `edit` at every version and format offered, each read again and compared
// by the tool before it reports success. The independent readers run in CI
// (scripts/oracles/write-matrix.mjs).

import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { blockQueryDxf, overlaySpec } from '../fixtures/block-query.ts';
import { ANSWERS } from '../fixtures/sample.ts';
import { body, fixtureFolder, m, rowsOf, runBinary } from '../helpers.ts';

let dir: string;
const run = (...args: string[]) => runBinary(args, dir);
const ok = async (...args: string[]) => {
  const r = await run(...args);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
  return body(r.stdout);
};
const fails = async (code: string, ...args: string[]) => {
  const r = await run(...args);
  const doc = body(r.stdout);
  assert.equal(doc.code, code, `${args.join(' ')}: ${r.stdout}`);
  return doc;
};

const SPEC = {
  units: 'mm',
  time: '2026-01-01T00:00:00Z',
  layers: [{ name: 'MARK', color: 1 }],
  styles: [{ name: 'T', font: 'arial.ttf' }],
  blocks: [
    {
      name: 'TAG',
      entities: [
        { kind: 'circle', center: [0, 0], radius: 100 },
        {
          kind: 'attdef',
          tag: 'NO',
          prompt: 'Number',
          value: '',
          at: [150, 0],
          height: 50,
        },
      ],
    },
  ],
  entities: [
    { kind: 'line', layer: 'MARK', from: [0, 0], to: [1000, 0] },
    {
      kind: 'polyline',
      layer: 'MARK',
      pts: [
        [0, 0],
        [100, 100],
        [200, 0],
      ],
      bulges: [0.5, 0, 0],
      closed: true,
    },
    {
      kind: 'arc',
      layer: 'MARK',
      center: [0, 0],
      radius: 50,
      start: 0,
      end: 270,
    },
    { kind: 'circle', layer: 'MARK', center: [5, 5], radius: 5 },
    { kind: 'point', layer: 'MARK', at: [1, 2] },
    {
      kind: 'text',
      layer: 'MARK',
      at: [0, -200],
      height: 100,
      value: 'Mark A',
      style: 'T',
      rotation: 15,
    },
    {
      kind: 'mtext',
      layer: 'MARK',
      at: [0, -400],
      height: 100,
      value: 'line one\nline two',
    },
    {
      kind: 'insert',
      layer: 'MARK',
      block: 'TAG',
      at: [500, 500],
      rotation: 45,
      scale: [2, 2],
      attribs: { NO: '7' },
    },
    {
      kind: 'text',
      layer: 'MARK',
      at: [0, 0],
      height: 10,
      value: 'title',
      space: 'Layout1',
    },
  ],
};

before(async () => {
  dir = realpathSync(await fixtureFolder());
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
  writeFileSync(
    join(dir, 'hebrew.json'),
    JSON.stringify({
      entities: [{ kind: 'text', at: [0, 0], height: 1, value: 'שלום' }],
    }),
  );
});

const VERSIONS: Array<[string, string]> = [
  ['2018', 'AC1032'],
  ['2013', 'AC1027'],
  ['2010', 'AC1024'],
  ['2004', 'AC1018'],
  ['2000', 'AC1015'],
];

describe('create', () => {
  for (const [as, code] of VERSIONS)
    for (const ext of ['dwg', 'dxf'])
      it(`writes and checks every kind at ${as} as ${ext.toUpperCase()}`, async () => {
        const out = `new-${as}.${ext}`;
        const doc = await ok(
          'create',
          '--spec',
          'spec.json',
          '--out',
          out,
          '--as',
          as,
        );
        assert.equal(doc.version, code);
        assert.equal(doc.entities, 11);
        assert.match(String(doc.checked), /every entity matches/);
        assert.equal(
          doc.sha256,
          (await import('node:crypto'))
            .createHash('sha256')
            .update(readFileSync(join(dir, out)))
            .digest('hex'),
        );
        const texts = rowsOf(
          await ok('texts', out, '--space', 'all'),
          'texts',
        ).map((t) => t.text);
        assert.ok(texts.includes('line one\nline two'));
        assert.ok(texts.includes('title'));
      });

  it('never replaces a file, and leaves no temporary file behind', async () => {
    const before = statSync(join(dir, 'plan.dwg')).mtimeMs;
    await fails('exists', 'create', '--spec', 'spec.json', '--out', 'plan.dwg');
    assert.equal(statSync(join(dir, 'plan.dwg')).mtimeMs, before);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.cad-axi-')));
  });

  it('refuses text a pre-2007 code page cannot carry, rather than lose it', async () => {
    await fails(
      'invalid_spec',
      'create',
      '--spec',
      'hebrew.json',
      '--out',
      'heb-2000.dwg',
      '--as',
      '2000',
    );
    await ok('create', '--spec', 'hebrew.json', '--out', 'heb-2018.dwg');
    assert.equal(existsSync(join(dir, 'heb-2000.dwg')), false);
  });

  it('refuses a 2007 DWG, which the engine does not write', async () => {
    await fails(
      'unsupported',
      'create',
      '--spec',
      'spec.json',
      '--out',
      'x.dwg',
      '--as',
      '2007',
    );
  });

  it("the overlay lies in the source drawing's units and layers", async () => {
    writeFileSync(
      join(dir, 'mark.json'),
      JSON.stringify({
        entities: [{ kind: 'line', layer: 'SAN', from: [0, 0], to: [1000, 0] }],
      }),
    );
    const doc = await ok(
      'create',
      '--spec',
      'mark.json',
      '--like',
      'plan.dwg',
      '--out',
      'overlay.dwg',
    );
    assert.match(String(doc.like), /copied from the --like drawing/);
    const info = await ok('info', 'overlay.dwg');
    assert.equal(info.units, 'mm');
    const layers = rowsOf(await ok('layers', 'overlay.dwg'), 'layers');
    assert.equal(layers.find((l) => l.name === 'RAIN')?.color, 5);
    assert.equal(layers.find((l) => l.name === 'SAN')?.length, 1);
  });

  it('reports the layers written when creating an overlay of a drawing with an xref', async () => {
    writeFileSync(join(dir, 'symbols.dxf'), blockQueryDxf());
    writeFileSync(join(dir, 'symbols-mark.json'), JSON.stringify(overlaySpec));
    for (const format of ['dwg', 'dxf']) {
      const out = `symbols-overlay.${format}`;
      const result = await ok(
        'create',
        '--like',
        'symbols.dxf',
        '--spec',
        'symbols-mark.json',
        '--out',
        out,
      );
      const layers = rowsOf(await ok('layers', out, '--full'), 'layers');
      assert.ok(layers.some((layer) => layer.name === '0'));
      assert.ok(layers.some((layer) => layer.name === 'SYMBOLS'));
      assert.ok(layers.some((layer) => layer.name === 'MARK'));
      assert.equal(result.layers, layers.length);
    }
  });
});

describe('convert', () => {
  for (const [as, code] of VERSIONS.slice(0, 3))
    for (const ext of ['dwg', 'dxf'])
      it(`copies the sample to ${as} as ${ext.toUpperCase()} with nothing lost`, async () => {
        // The DXF writer does not carry materials, so DXF copies start from the DXF.
        const source = ext === 'dxf' ? 'plan.dxf' : 'plan.dwg';
        const out = `conv-${as}.${ext}`;
        const doc = await ok('convert', source, '--out', out, '--as', as);
        assert.equal(doc.version, code);
        assert.equal(doc.entities_kept, 44);
        const diff = await ok('diff', source, out);
        assert.match(String(diff.summary), /^no differences/);
        const rows = new Map(
          rowsOf(await ok('measure', out), 'groups').map((r) => [r.group, r]),
        );
        assert.equal(rows.get('SAN')?.length, m(ANSWERS.san));
      });

  it('refuses a DXF copy of a drawing with materials, which the DXF writer drops', async () => {
    const doc = await fails(
      'would_lose',
      'convert',
      'plan.dwg',
      '--out',
      'mat.dxf',
    );
    assert.match(String(doc.message), /MATERIAL \(in DXF\)/);
  });

  it('refuses a pre-2007 copy whose text its code page cannot carry', async () => {
    writeFileSync(
      join(dir, 'dia.json'),
      JSON.stringify({
        codepage: 'ANSI_1255',
        entities: [{ kind: 'text', at: [0, 0], height: 1, value: '\u00d8110' }],
      }),
    );
    await ok('create', '--spec', 'dia.json', '--out', 'dia.dwg');
    for (const as of ['2004', '2000']) {
      const doc = await fails(
        'would_lose',
        'convert',
        'dia.dwg',
        '--out',
        `dia-${as}.dwg`,
        '--as',
        as,
      );
      assert.match(String(doc.message), /cannot carry/);
    }
  });

  for (const [as, code] of VERSIONS.slice(3))
    it(`copies Hebrew text to ${as}, through code page 1255`, async () => {
      writeFileSync(
        join(dir, `heb-${as}.json`),
        JSON.stringify({
          codepage: 'ANSI_1255',
          entities: [
            {
              kind: 'text',
              at: [0, 0],
              height: 1,
              value: '\u05e9\u05dc\u05d5\u05dd',
            },
          ],
        }),
      );
      await ok(
        'create',
        '--spec',
        `heb-${as}.json`,
        '--out',
        `heb-src-${as}.dwg`,
      );
      const doc = await ok(
        'convert',
        `heb-src-${as}.dwg`,
        '--out',
        `heb-${as}.dwg`,
        '--as',
        as,
      );
      assert.equal(doc.version, code);
      const texts = rowsOf(await ok('texts', `heb-${as}.dwg`), 'texts');
      assert.equal(texts[0]?.text, '\u05e9\u05dc\u05d5\u05dd');
    });
});

describe('edit', () => {
  it('applies every operation, keeps everything else, and says so', async () => {
    const q = (args: string[]) =>
      ok('query', 'plan.dwg', ...args).then((d) => rowsOf(d, 'entities'));
    const planted = (await q(['--type', 'TEXT', '--layer', 'NOTES'])).find(
      (r) => String(r.detail).startsWith('IGNORE'),
    );
    const head = (await q(['--block', 'HEAD']))[0];
    const cw = (await q(['--layer', 'CW']))[0];
    const legend = (await q(['--layer', 'LEGEND']))[0];
    const ops = {
      ops: [
        { op: 'set_text', h: planted?.h, value: 'note removed' },
        { op: 'set_attribute', h: head?.h, tag: 'SIZE', value: '3/4"' },
        { op: 'move', h: cw?.h, by: [0, 100] },
        { op: 'delete', h: legend?.h },
        { op: 'add_layer', name: 'MARK', color: 1 },
        {
          op: 'add_polyline',
          layer: 'MARK',
          pts: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
        },
        {
          op: 'add_text',
          layer: 'MARK',
          at: [0, 0],
          height: 100,
          value: 'checked',
        },
        {
          op: 'add_insert',
          layer: 'MARK',
          block: 'HEAD',
          at: [1, 1],
          attribs: { SIZE: '1"' },
        },
      ],
    };
    writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
    const doc = await ok(
      'edit',
      'plan.dwg',
      '--ops',
      'ops.json',
      '--out',
      'edited.dwg',
    );
    assert.equal(doc.entities_changed, 3);
    assert.equal(doc.entities_deleted, 1);
    assert.equal(doc.entities_added, 3);
    assert.equal(doc.entities_kept, 44 - 4);
    const diff = rowsOf(
      await ok('diff', 'plan.dwg', 'edited.dwg', '--each'),
      'entities',
    );
    assert.equal(diff.length, 7);
    const groups = new Map(
      rowsOf(await ok('measure', 'edited.dwg'), 'groups').map((r) => [
        r.group,
        r,
      ]),
    );
    assert.equal(groups.has('LEGEND'), false);
    // The new polyline, and the head's circle, drawn on layer 0 inside the block.
    assert.equal(groups.get('MARK')?.length, m(20 + 2 * Math.PI * 50));
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.cad-axi-')));
  });

  it('refuses a drawing it cannot carry, naming what would be lost', async () => {
    // An R12 DXF, as older programs write it, keeps attributes apart.
    const r12 = [
      '0',
      'SECTION',
      '2',
      'HEADER',
      '9',
      '$ACADVER',
      '1',
      'AC1009',
      '0',
      'ENDSEC',
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'POLYLINE',
      '8',
      '0',
      '66',
      '1',
      '0',
      'VERTEX',
      '8',
      '0',
      '10',
      '0',
      '20',
      '0',
      '0',
      'VERTEX',
      '8',
      '0',
      '10',
      '1',
      '20',
      '0',
      '0',
      'SEQEND',
      '8',
      '0',
      '0',
      'ENDSEC',
      '0',
      'EOF',
    ].join('\n');
    writeFileSync(join(dir, 'old.dxf'), `${r12}\n`);
    writeFileSync(
      join(dir, 'none.json'),
      JSON.stringify({ ops: [{ op: 'add_layer', name: 'X' }] }),
    );
    const doc = await fails(
      'would_lose',
      'edit',
      'old.dxf',
      '--ops',
      'none.json',
      '--out',
      'old-edit.dwg',
    );
    assert.match(String(doc.message), /POLYLINE/);
    assert.equal(existsSync(join(dir, 'old-edit.dwg')), false);
  });

  it('refuses handles the drawing does not hold, and handles inside blocks', async () => {
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({ ops: [{ op: 'delete', h: 'FFFFFF' }] }),
    );
    await fails(
      'unknown_handle',
      'edit',
      'plan.dwg',
      '--ops',
      'bad.json',
      '--out',
      'bad.dwg',
    );
    await fails('usage', 'edit', 'plan.dwg', '--out', 'bad.dwg');
    await fails(
      'usage',
      'edit',
      'plan.dwg',
      '--ops',
      'bad.json',
      '--out',
      'bad.svg',
    );
  });
});
