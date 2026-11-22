// Every command as a separate process, on the sample drawing, against its
// chosen answers (implementation plan §7.1). Set CAD_AXI_BIN=dist to run
// the built package instead of the source.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  ANSWERS,
  BIDI,
  HEBREW,
  PLAN_REGION,
  PLANTED,
} from '../fixtures/sample.ts';
import { body, fixtureFolder, m, rowsOf, runBinary } from '../helpers.ts';

let dir: string;
const run = (...args: string[]) => runBinary(args, dir);
const ok = async (...args: string[]) => {
  const r = await run(...args);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
  assert.equal(r.stderr, '');
  return body(r.stdout);
};
const fails = async (code: string, exit: number, ...args: string[]) => {
  const r = await run(...args);
  assert.equal(r.code, exit, `${args.join(' ')}: ${r.stdout}`);
  const doc = body(r.stdout);
  assert.equal(doc.code, code, r.stdout);
  return doc;
};

before(async () => {
  dir = realpathSync(await fixtureFolder());
});

for (const file of ['plan.dwg', 'plan.dxf']) {
  describe(`reading the sample as ${file.slice(-3).toUpperCase()}`, () => {
    it('home lists both drawings with version, units and the edit verdict', async () => {
      const doc = await ok();
      const rows = rowsOf(doc, 'drawings');
      const plan = rows.find((r) => r.file === file);
      assert.ok(plan, JSON.stringify(rows));
      assert.equal(plan.units, 'mm');
      assert.equal(plan.editable, 'yes');
      assert.equal(
        rows.find((r) => r.file === 'old.dwg')?.units,
        'not readable: unsupported',
      );
    });

    it('info: version, units, layouts, counts and the external reference, never opened', async () => {
      const doc = await ok('info', file);
      assert.equal(doc.units, 'mm');
      assert.equal(doc.units_basis, 'stated by the file');
      assert.equal(doc.layouts, 'Model (39), Sheet (2)');
      assert.equal(doc.entities, 44);
      assert.equal(doc.blocks, 2);
      assert.match(
        String(doc.external_references),
        /^1: BASE \(listed, never opened\)$/,
      );
      assert.equal(doc.editable, 'yes');
      assert.doesNotMatch(
        JSON.stringify(doc),
        /made-up|base\.dwg/,
        'the reference path is never printed',
      );
    });

    it('layers: state, colour, entity count and length on each', async () => {
      const rows = rowsOf(await ok('layers', file), 'layers');
      const by = new Map(rows.map((r) => [r.name, r]));
      assert.equal(by.get('SAN')?.length, m(ANSWERS.san));
      assert.equal(by.get('RAIN')?.length, m(ANSWERS.rain));
      assert.equal(by.get('F')?.length, m(ANSWERS.fire));
      assert.equal(by.get('CW')?.length, m(ANSWERS.cw));
      assert.equal(by.get('HEADS')?.length, m(ANSWERS.heads));
      assert.equal(by.get('OLD')?.state, 'frozen');
      assert.equal(by.get('SAN')?.color, 3);
    });

    it('blocks: insert counts and attribute tags', async () => {
      const rows = rowsOf(await ok('blocks', file), 'blocks');
      const head = rows.find((r) => r.name === 'HEAD');
      assert.equal(head?.inserts, ANSWERS.headInserts);
      assert.equal(head?.attributes, 'SIZE');
      assert.equal(rows.find((r) => r.name === 'BASE')?.kind, 'xref');
    });

    it('texts: decoded, Hebrew kept, keyboard Hebrew decoded, overrides escaped', async () => {
      const r = await run('texts', file, '--full');
      const rows = rowsOf(body(r.stdout), 'texts');
      assert.equal(rows.length, ANSWERS.modelTexts);
      const texts = rows.map((x) => x.text);
      assert.ok(texts.includes('Ø110'), 'the %%c code is decoded');
      assert.ok(
        texts.includes(`${HEBREW.note}\n${HEBREW.diameter} 110`),
        'MTEXT codes are removed',
      );
      assert.ok(
        texts.includes(PLANTED),
        'a planted instruction is data, shown as text',
      );
      const keyed = rows
        .filter((x) => x.decoded === 'keyboard')
        .map((x) => x.text);
      assert.deepEqual(keyed.sort(), [HEBREW.sewer, HEBREW.water].sort());
      assert.ok(
        r.stdout.includes('\\u202eSAN 110'),
        'the bidirectional override is printed as an escape',
      );
      assert.ok(!r.stdout.includes(BIDI));
      const attrib = rows.find((x) => x.block === 'HEAD: SIZE');
      assert.equal(attrib?.text, '1/2"');
    });

    it('texts in a paper space layout', async () => {
      const rows = rowsOf(await ok('texts', file, '--space', 'Sheet'), 'texts');
      assert.deepEqual(
        rows.map((x) => x.text),
        ['SAMPLE DRAINAGE PLAN'],
      );
    });

    it('query: by kind, layer, block and handle', async () => {
      const inserts = rowsOf(
        await ok('query', file, '--block', 'HEAD', '--full'),
        'entities',
      );
      assert.equal(inserts.length, ANSWERS.headInserts);
      const one = rowsOf(
        await ok('query', file, '--handle', String(inserts[0]?.h)),
        'entities',
      );
      assert.equal(one.length, 1);
      const lines = rowsOf(
        await ok('query', file, '--type', 'line', '--layer', 'CW'),
        'entities',
      );
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.detail, 'length 8000');
    });

    it('measure: by layer, with the part in blocks apart and frozen layers left out', async () => {
      const doc = await ok('measure', file);
      const rows = new Map(rowsOf(doc, 'groups').map((r) => [r.group, r]));
      assert.equal(rows.get('SAN')?.length, m(ANSWERS.san));
      assert.equal(rows.get('SAN')?.in_blocks, m(ANSWERS.inBlock));
      assert.equal(rows.get('HEADS')?.in_blocks, m(ANSWERS.heads));
      assert.equal(rows.has('OLD'), false);
      assert.match(String(doc.left_out), /^1 m in 1 entities/);
      const all = new Map(
        rowsOf(await ok('measure', file, '--all'), 'groups').map((r) => [
          r.group,
          r,
        ]),
      );
      assert.equal(all.get('OLD')?.length, m(ANSWERS.frozen));
    });

    it('measure: a region leaves the legend out; named groups add layers', async () => {
      const rows = new Map(
        rowsOf(
          await ok('measure', file, '--region', PLAN_REGION),
          'groups',
        ).map((r) => [r.group, r]),
      );
      assert.equal(rows.get('SAN')?.length, m(ANSWERS.sanInPlan));
      assert.equal(rows.has('LEGEND'), false);
      const groups = rowsOf(
        await ok(
          'measure',
          file,
          '--group',
          'wet=SAN+RAIN',
          '--group',
          'fire=F',
        ),
        'groups',
      );
      assert.deepEqual(
        groups.map((g) => [g.group, g.length]),
        [
          ['wet', m(ANSWERS.san + ANSWERS.rain)],
          ['fire', m(ANSWERS.fire)],
        ],
      );
    });

    it('runs: joined end to end, sized by labels; a shared label sizes neither', async () => {
      const rows = rowsOf(
        await ok('runs', file, '--layer', 'SAN', '--layer', 'RAIN'),
        'runs',
      );
      const sized = rows
        .filter((r) => r.size)
        .map((r) => [r.group, r.size, r.length]);
      assert.deepEqual(sized, [
        ['SAN', 'Ø110', m(ANSWERS.runA)],
        ['RAIN', 'Ø125', 12],
        ['SAN', 'Ø160', 5],
      ]);
      const unsized = rows
        .filter((r) => !r.size)
        .map((r) => [r.group, r.length]);
      assert.deepEqual(unsized, [
        ['SAN', 6],
        ['RAIN', 6],
        ['SAN', 2],
        ['SAN', 2],
      ]);
    });

    it('runs: a coded label sizes only its own system', async () => {
      const rows = rowsOf(
        await ok('runs', file, '--layer', 'F', '--layer', 'CW'),
        'runs',
      );
      assert.deepEqual(
        rows.map((r) => [r.group, r.size, r.length]),
        [
          ['F', '3"', 9],
          ['F', '2"', 8],
          ['CW', null, 8],
        ],
      );
    });

    it('measure --by size: totals by system and size, unsized apart', async () => {
      const doc = await ok('measure', file, '--by', 'size', '--layer', 'SAN');
      const rows = rowsOf(doc, 'sizes').map((r) => [r.size, r.length]);
      // Alone, the sewer layer has no rival for the shared label.
      assert.deepEqual(rows, [
        ['Ø110', m(ANSWERS.runA)],
        ['Ø90', 6],
        ['Ø160', 5],
        ['unsized', 4],
      ]);
    });

    it('check: a fresh read holds together', async () => {
      const doc = await ok('check', file);
      assert.equal(doc.result, 'all 7 checks pass');
    });
  });
}

describe('pictures and comparing', () => {
  it('render writes SVG with escaped text and nothing from the file but numbers and text', async () => {
    const doc = await ok('render', 'plan.dwg', '--out', 'plan.svg');
    assert.equal(doc.written, 'plan.svg');
    const svg = readFileSync(join(dir, 'plan.svg'), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.doesNotMatch(
      svg,
      /<script|<image|<a |href=|<foreignObject|@font-face/i,
    );
    assert.ok(svg.includes(HEBREW.sewer));
    await fails('exists', 1, 'render', 'plan.dwg', '--out', 'plan.svg');
    await ok(
      'render',
      'plan.dwg',
      '--out',
      'plan.svg',
      '--force',
      '--layer',
      'SAN',
    );
  });

  it('diff: the DXF and its DWG copy match entity for entity', async () => {
    const doc = await ok('diff', 'plan.dxf', 'plan.dwg');
    assert.match(String(doc.summary), /^no differences/);
  });

  it('version: package, engine and the pinned ACadSharp', async () => {
    const doc = await ok('version');
    assert.equal(doc.acadsharp, '3.8.35');
    assert.equal(doc.protocol, 1);
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    assert.equal(doc.package, pkg.version);
    const r = await run('--version');
    assert.equal(r.stdout, `${pkg.version}\n`);
  });
});

describe('errors', () => {
  it('closed codes, never echoing what was given', async () => {
    const missing = await fails('not_found', 1, 'info', 'secret-name.dwg');
    assert.doesNotMatch(JSON.stringify(missing), /secret-name/);
    await fails('not_cad', 1, 'info', 'notes.txt');
    await fails('damaged', 1, 'info', 'fake.dwg');
    await fails('unsupported', 1, 'info', 'old.dwg');
    await fails('usage', 2, 'info');
    await fails('usage', 2, 'frobnicate');
    const flag = await fails(
      'usage',
      2,
      'layers',
      'plan.dwg',
      '--secret-flag=value',
    );
    assert.doesNotMatch(JSON.stringify(flag), /value/);
    const layer = await fails(
      'unknown_layer',
      1,
      'measure',
      'plan.dwg',
      '--layer',
      'NO-SUCH',
    );
    assert.match(String(layer.message), /no layer named `NO-SUCH`/);
    await fails('unknown_block', 1, 'query', 'plan.dwg', '--block', 'NOPE');
    await fails('unknown_handle', 1, 'query', 'plan.dwg', '--handle', 'FFFFFF');
    await fails('too_large', 1, 'info', 'plan.dwg', '--max-bytes', '100');
  });

  it('units_unknown when the file states none and --units is not given', async () => {
    const { writeDxf } = await import('../fixtures/dxf.ts');
    const { SAMPLE } = await import('../fixtures/sample.ts');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'unitless.dxf'), writeDxf({ ...SAMPLE, units: 0 }));
    await fails('units_unknown', 1, 'measure', 'unitless.dxf');
    const rows = rowsOf(
      await ok('measure', 'unitless.dxf', '--units', 'mm'),
      'groups',
    );
    assert.equal(rows.find((r) => r.group === 'SAN')?.length, m(ANSWERS.san));
  });

  it('COMIS_DEADLINE in the past stops before reading', async () => {
    const r = await runBinary(['info', 'plan.dwg'], dir, {
      COMIS_DEADLINE: String(Date.now() - 1000),
    });
    assert.equal(r.code, 1);
    assert.equal(body(r.stdout).code, 'timed_out');
  });

  it('no stray files are left in the folder', () => {
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.cad-axi-')));
    assert.ok(existsSync(join(dir, 'plan.dwg')));
  });
});
