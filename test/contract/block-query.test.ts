import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, it } from 'node:test';
import { blockQueryDxf } from '../fixtures/block-query.ts';
import { body, rowsOf, runBinary, tempDir } from '../helpers.ts';

const dir = tempDir();
const west = '-1,-1,10,1';
const east = '9,-1,21,1';
const blocks = ['--block', 'VALVE', '--block', 'CAP', '--block', 'SPARE'];
const regions = ['--region', west, '--region', east];

async function read(...args: string[]) {
  const result = await runBinary(args, dir);
  assert.equal(result.code, 0, result.stdout);
  return body(result.stdout);
}

function saved(file: string) {
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

before(async () => {
  writeFileSync(join(dir, 'symbols.dxf'), blockQueryDxf());
  await read('convert', 'symbols.dxf', '--out', 'symbols.dwg');
});

for (const file of ['symbols.dxf', 'symbols.dwg']) {
  it(`counts each named block in each region of ${file}, with zeros and overlap`, async () => {
    const out = `counts-${file}.json`;
    const result = await read(
      'query',
      file,
      '--count',
      ...blocks,
      ...regions,
      '--limit',
      '1',
      '--save',
      out,
    );
    const expected = [
      { block: 'VALVE', region: west, inserts: 2 },
      { block: 'CAP', region: west, inserts: 0 },
      { block: 'SPARE', region: west, inserts: 0 },
      { block: 'VALVE', region: east, inserts: 1 },
      { block: 'CAP', region: east, inserts: 1 },
      { block: 'SPARE', region: east, inserts: 0 },
    ];
    assert.deepEqual(rowsOf(result, 'block_counts'), expected.slice(0, 1));
    assert.deepEqual(rowsOf(saved(out), 'block_counts'), expected);

    const total = await read(
      'query',
      file,
      '--count',
      ...blocks,
      '--space',
      'all',
    );
    assert.deepEqual(rowsOf(total, 'block_counts'), [
      { block: 'VALVE', region: null, inserts: 2 },
      { block: 'CAP', region: null, inserts: 2 },
      { block: 'SPARE', region: null, inserts: 0 },
    ]);
  });

  it(`extracts inserts in the union of regions of ${file} with no duplicates`, async () => {
    const result = await read('query', file, ...blocks, ...regions, '--full');
    const rows = rowsOf(result, 'entities');
    assert.deepEqual(
      rows.map(({ block, at }) => [block, at]),
      [
        ['VALVE', '0,0'],
        ['VALVE', '10,0'],
        ['CAP', '20,0'],
      ],
    );
    const curves = await read('query', file, '--type', 'LINE', ...regions);
    assert.equal(rowsOf(curves, 'entities').length, 1);
  });

  it(`shows every queried insert scale and lists reference names from ${file}`, async () => {
    const out = `inserts-${file}.json`;
    const compact = await read(
      'query',
      file,
      '--type',
      'INSERT',
      '--save',
      out,
    );
    assert.match(
      String(rowsOf(compact, 'entities')[1]?.detail),
      /scale 2,3,-4/,
    );
    const result = await read('query', file, '--type', 'INSERT', '--full');
    assert.deepEqual(
      rowsOf(result, 'entities').map(({ block, scale }) => [block, scale]),
      [
        ['VALVE', '1,1,1'],
        ['VALVE', '2,3,-4'],
        ['CAP', '1,1,1'],
        ['FRAME', '100,100,100'],
      ],
    );
    assert.deepEqual(
      rowsOf(saved(out), 'entities').map(({ block, scale }) => [block, scale]),
      [
        ['VALVE', [1, 1, 1]],
        ['VALVE', [2, 3, -4]],
        ['CAP', [1, 1, 1]],
        ['FRAME', [100, 100, 100]],
      ],
    );
    const references = rowsOf(await read('info', file, '--full'), 'xrefs');
    assert.deepEqual(
      references.map(({ name, file, folder }) => [name, file, folder]),
      [['FRAME', 'frame.dwg', 'refs']],
    );
  });
}

it('rejects invalid query and measure flags before looking up the file', async () => {
  for (const [command, flags, message] of [
    ['query', ['--limit', '0', '--full'], /--limit/],
    ['query', ['--handle', 'not-hex'], /--handle/],
    ['query', ['--region', west, '--region', '1,2,3'], /--region/],
    ['query', ['--region', '0,0,1e999,1'], /--region/],
    ['query', ['--count'], /--block/],
    ['measure', ['--limit', '0'], /--limit/],
    ['measure', ['--by', 'lines'], /--by/],
    ['measure', ['--region', '0,0,0,0'], /--region/],
    ['measure', ['--units', 'yards'], /--units/],
    ['measure', ['--units', 'toString'], /--units/],
    ['measure', ['--group', 'bad'], /--group/],
    ['measure', ['--by', 'size'], /--layer/],
    ['measure', ['--by', 'size', '--layer', 'SYMBOLS', '--gap', '0'], /--gap/],
    [
      'measure',
      ['--by', 'size', '--layer', 'SYMBOLS', '--reach', '0'],
      /--reach/,
    ],
  ] as const) {
    const result = await runBinary([command, 'missing.dwg', ...flags], dir);
    const doc = body(result.stdout);
    assert.equal(result.code, 2, result.stdout);
    assert.match(String(doc.message), message);
  }
});
