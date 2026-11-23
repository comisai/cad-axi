import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { type Ent, writeDxf } from '../fixtures/dxf.ts';
import { body, rowsOf, runBinary, tempDir } from '../helpers.ts';

async function read(dir: string, ...args: string[]) {
  const result = await runBinary(args, dir);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, '');
  return body(result.stdout);
}

function labels(...values: string[]): Extract<Ent, { kind: 'TEXT' }>[] {
  return values.map((value, i) => ({
    kind: 'TEXT',
    layer: '0',
    at: [i * 20, 0],
    height: 2,
    style: 'STROKE',
    value,
  }));
}

const stroke = [{ name: 'STROKE', font: 'simplex.shx' }];

it('honors declared code pages and detects DOS Hebrew when a legacy DXF has none', async () => {
  const dir = tempDir();
  // 0x81 is bet in IBM862 and an undefined slot in Windows-1252.
  const fixture = (page: string, legacyBytes: string) =>
    writeDxf({
      units: 4,
      layers: [],
      styles: stroke,
      codepage: page,
      model: labels('LEGACY_LABEL'),
    })
      .toString('latin1')
      .replace('LEGACY_LABEL', legacyBytes);
  const visual = '4/8" \x84\x81\x80\x99\x8e'; // visual order for משאבה
  writeFileSync(join(dir, 'dos.dxf'), fixture('DOS862', visual), 'latin1');
  writeFileSync(
    join(dir, 'unknown.dxf'),
    fixture('DOS862', visual).replace(
      '9\r\n$DWGCODEPAGE\r\n3\r\nDOS862\r\n',
      '',
    ),
    'latin1',
  );
  writeFileSync(
    join(dir, 'cyrillic.dxf'),
    fixture('ANSI_1251', '\xcd\xe0\xf1\xee\xf1'),
    'latin1',
  );
  writeFileSync(
    join(dir, 'alias.dxf'),
    fixture('CP1251', '\xcd\xe0\xf1\xee\xf1'),
    'latin1',
  );
  writeFileSync(
    join(dir, 'western.dxf'),
    fixture('ANSI_1252', '\x91\x92\x93\x94 \x80'),
    'latin1',
  );
  for (const file of ['dos.dxf', 'unknown.dxf']) {
    const [row] = rowsOf(await read(dir, 'texts', file, '--full'), 'texts');
    assert.equal(row?.text, 'משאבה 4/8"', file);
    assert.equal(row?.decoded, 'dos-hebrew', file);
  }
  const [declared] = rowsOf(
    await read(dir, 'texts', 'dos.dxf', '--full'),
    'texts',
  );
  assert.equal(declared?.raw, '4/8" הבאשמ');
  assert.match(
    String((await read(dir, 'info', 'unknown.dxf')).codepage_basis),
    /declaration missing or unrecognized/,
  );
  for (const [file, expected] of [
    ['cyrillic.dxf', 'Насос'],
    ['alias.dxf', 'Насос'],
    ['western.dxf', '‘’“” €'],
  ] as const) {
    const [row] = rowsOf(await read(dir, 'texts', file, '--full'), 'texts');
    assert.equal(row?.text, expected, file);
    assert.equal(row?.decoded, null, file);
  }
});

it('reads legacy stroke-font text in a modern DWG with its size labels intact', async () => {
  const dir = tempDir();
  const logical = 'Ž\u0081‡\u008f 4/8"'; // logical order for מבחן
  const visual = '"8/4 „\u0081€™Ž'; // visual order for משאבה, with a reversed size
  const alreadyOrdered = 'מבחן 4/8"';
  writeFileSync(
    join(dir, 'legacy.dxf'),
    writeDxf({
      units: 4,
      layers: [],
      styles: [...stroke, { name: 'SIZES', font: 'romans.shx' }],
      model: [
        ...labels(
          visual,
          logical,
          alreadyOrdered,
          '1 3/8"„\u0081€™Ž',
          '"8/3 1',
          '\u0081€',
        ),
        ...labels('VALVE 8/4"', '4/2"', '4/8"').map((label) => ({
          ...label,
          style: 'SIZES',
        })),
        {
          kind: 'MTEXT',
          layer: '0',
          at: [0, 10],
          height: 2,
          style: 'STROKE',
          value: `{\\Fsimplex.shx;${visual}}\\P${alreadyOrdered}`,
        },
      ],
    }),
  );
  await read(dir, 'convert', 'legacy.dxf', '--out', 'legacy.dwg');
  const rows = rowsOf(
    await read(dir, 'texts', 'legacy.dwg', '--full'),
    'texts',
  );
  assert.deepEqual(
    rows.map(({ text, decoded }) => [text, decoded]),
    [
      ['משאבה 4/8"', 'dos-hebrew'],
      [alreadyOrdered, 'dos-hebrew'],
      [alreadyOrdered, null],
      ['משאבה1 3/8"', 'dos-hebrew'],
      ['1 3/8"', 'dos-hebrew'],
      ['אב', 'dos-hebrew'],
      ['VALVE 4/8"', 'dos-hebrew'],
      ['2/4"', 'dos-hebrew'],
      ['4/8"', null],
      [`משאבה 4/8"\n${alreadyOrdered}`, 'dos-hebrew'],
    ],
  );
});

it('lists reference filenames and host-relative folders from DXF and DWG', async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'host.dxf'),
    writeDxf({
      units: 4,
      layers: [],
      model: [],
      xrefs: [
        { name: 'UPPER', path: '.\\upper\\base.dwg' },
        { name: 'LOWER', path: 'lower/base.dwg' },
        { name: 'SIBLING', path: '..\\drawings\\side.dwg' },
        { name: 'HERE', path: 'here.dwg' },
        { name: 'LOCAL', path: join(dir, 'local', 'in.dwg') },
        { name: 'WINDOWS', path: 'D:\\private\\outside.dwg' },
        { name: 'NETWORK', path: '\\\\server\\share\\network.dwg' },
        { name: 'UNIX', path: '/private/outside/plan.dwg' },
        { name: 'SHARE', path: '\\\\server\\share' },
      ],
    }),
  );
  await read(dir, 'convert', 'host.dxf', '--out', 'host.dwg');
  for (const file of ['host.dxf', 'host.dwg']) {
    const doc = await read(dir, 'info', file, '--full');
    const xrefs = Object.fromEntries(
      rowsOf(doc, 'xrefs').map(({ name, file, folder }) => [
        String(name),
        [file, folder ?? null],
      ]),
    );
    assert.deepEqual(xrefs, {
      UPPER: ['base.dwg', 'upper'],
      LOWER: ['base.dwg', 'lower'],
      SIBLING: ['side.dwg', '../drawings'],
      HERE: ['here.dwg', '.'],
      LOCAL: ['in.dwg', 'local'],
      WINDOWS: ['outside.dwg', null],
      NETWORK: ['network.dwg', null],
      UNIX: ['plan.dwg', null],
      SHARE: [null, null],
    });
    assert.doesNotMatch(JSON.stringify(doc), /private|server|share/);
  }
});
