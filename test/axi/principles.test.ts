// The ten AXI principles (axi.md, and the stricter Comis reading), checked
// against the real binary as a separate process. Set CAD_AXI_BIN=dist to
// check the built package instead of the source.

import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { COMMANDS } from '../../src/cli/run.ts';
import { FULL_LIMIT, OUTPUT_LIMIT } from '../../src/output/toon.ts';
import { body, fixtureFolder, rowsOf, runBinary } from '../helpers.ts';

let dir: string;
const run = (...args: string[]) => runBinary(args, dir);

before(async () => {
  dir = realpathSync(await fixtureFolder());
  writeFileSync(
    join(dir, 'spec.json'),
    JSON.stringify({ entities: [{ kind: 'line', from: [0, 0], to: [1, 1] }] }),
  );
});

/** The help footer's hints: a TOON list at the end, one `- ` item per line. */
function helpLines(text: string): string[] {
  const found = /^help\[(\d+)\]:\n((?: {2}- .*\n)*)$/m.exec(text);
  if (!found) {
    assert.doesNotMatch(text, /^help\[/m, 'a help footer is a TOON list');
    return [];
  }
  const raw = (found[2] ?? '').split('\n').filter(Boolean);
  assert.equal(raw.length, Number(found[1]), 'help[n] counts its lines');
  const hints = body(text).help;
  assert.ok(Array.isArray(hints), 'help decodes as a list');
  return hints.map(String);
}

const LISTS: Array<[string, string[]]> = [
  ['layers', ['layers', 'plan.dwg']],
  ['blocks', ['blocks', 'plan.dwg']],
  ['texts', ['texts', 'plan.dwg']],
  ['entities', ['query', 'plan.dwg']],
  ['groups', ['measure', 'plan.dwg']],
  ['sizes', ['measure', 'plan.dwg', '--by', 'size', '--layer', 'SAN']],
  ['runs', ['runs', 'plan.dwg', '--layer', 'SAN']],
  ['layers', ['diff', 'plan.dwg', 'plan.dxf']],
];
const RECORDS: string[][] = [
  ['info', 'plan.dwg'],
  ['check', 'plan.dwg'],
  ['version'],
  ['render', 'plan.dwg', '--out', 'p.svg', '--force'],
];
const ERRORS: string[][] = [
  ['info', 'missing.dwg'],
  ['info'],
  ['layers', 'plan.dwg', '--bogus'],
  ['frobnicate'],
  ['measure', 'plan.dwg', '--layer', 'NOPE'],
  ['info', 'notes.txt'],
  ['create', '--spec', 'spec.json', '--out', 'plan.dwg'],
  ['edit', 'plan.dwg', '--ops', 'missing.json', '--out', 'x.dwg'],
];

describe('AXI principles', () => {
  it('1. output is TOON from the official encoder, on stdout only', async () => {
    for (const args of [[], ...LISTS.map((l) => l[1]), ...RECORDS]) {
      const r = await run(...args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.doesNotThrow(() => body(r.stdout), args.join(' '));
      assert.ok(r.stdout.endsWith('\n'), args.join(' '));
    }
  });

  it('1b. every output decodes as one TOON document: lists, help, usage and errors', async () => {
    for (const args of [
      [],
      ['--help'],
      ['help'],
      ...COMMANDS.filter((c) => c.name).map((c) => [c.name, '--help']),
      ...ERRORS,
    ]) {
      const r = await run(...args);
      assert.equal(r.stderr, '', args.join(' '));
      assert.doesNotThrow(() => body(r.stdout), args.join(' '));
      if (/^help\[/m.test(r.stdout)) helpLines(r.stdout);
    }
  });

  it('2. list rows carry three to five fields by default', async () => {
    for (const [key, args] of LISTS) {
      const rows = rowsOf(body((await run(...args)).stdout), key);
      for (const row of rows) {
        const n = Object.keys(row).length;
        assert.ok(n >= 3 && n <= 5, `${args.join(' ')}: ${n} fields`);
      }
    }
  });

  it('3. long text is cut with its size and a --full hint', async () => {
    const r = await run('texts', 'plan.dwg', '--match', 'General notes');
    assert.match(
      r.stdout,
      / … \(truncated, \d+ code points total; use --full to see all\)/,
    );
    const full = await run(
      'texts',
      'plan.dwg',
      '--match',
      'General notes',
      '--full',
    );
    assert.doesNotMatch(full.stdout, /truncated/);
  });

  it('4. a list says how many rows it shows and how many there are', async () => {
    const two = body((await run('layers', 'plan.dwg', '--limit', '2')).stdout);
    assert.equal(two.summary, '2 of 9 layers');
    assert.equal(rowsOf(two, 'layers').length, 2);
    const one = body(
      (await run('runs', 'plan.dwg', '--layer', 'SAN', '--limit', '1')).stdout,
    );
    assert.match(String(one.summary), /^1 of 5 runs, /);
  });

  it('5. an empty answer says so, and says what to try', async () => {
    for (const [args, summary] of [
      [['texts', 'plan.dwg', '--match', 'zzzz'], /^0 texts match$/],
      [
        ['layers', 'plan.dwg', '--match', 'zzzz'],
        /^0 layers match; the drawing has 9$/,
      ],
      [['query', 'plan.dwg', '--type', 'HATCH'], /^0 entities match$/],
      [['runs', 'plan.dwg', '--layer', 'NOTES'], /^0 runs/],
    ] as const) {
      const r = await run(...args);
      assert.equal(r.code, 0, args.join(' '));
      assert.match(String(body(r.stdout).summary), summary, args.join(' '));
      assert.ok(helpLines(r.stdout).length >= 1, args.join(' '));
    }
  });

  it('6. errors are records on stdout with exit code 1, or 2 for usage', async () => {
    for (const args of ERRORS) {
      const r = await run(...args);
      const doc = body(r.stdout);
      assert.equal(r.stderr, '', args.join(' '));
      assert.deepEqual(
        Object.keys(doc).slice(0, 3),
        ['message', 'code', 'usage'],
        args.join(' '),
      );
      assert.equal(r.code, doc.code === 'usage' ? 2 : 1, args.join(' '));
      assert.match(
        String(doc.message),
        /[.)]$/,
        `a message is a sentence: ${doc.message}`,
      );
    }
  });

  it('6b. an error never echoes what it was given', async () => {
    const secret = 'sk-test-0123456789abcdefXYZ';
    for (const args of [
      ['info', `/tmp/${secret}.dwg`],
      ['layers', 'plan.dwg', `--${secret}`],
      ['measure', 'plan.dwg', '--layer', `${secret} `],
      ['texts', 'plan.dwg', '--match', `(${secret}`],
      ['create', '--spec', `${secret}.json`, '--out', 'n.dwg'],
      [secret],
    ]) {
      const r = await run(...args);
      assert.notEqual(r.code, 0, args.join(' '));
      assert.ok(!r.stdout.includes(secret), args.join(' '));
    }
  });

  it('7. with no arguments it shows live state, not help', async () => {
    const doc = body((await run()).stdout);
    assert.equal(typeof doc.bin, 'string');
    assert.equal(typeof doc.description, 'string');
    assert.equal(doc.folder, '~');
    assert.ok(rowsOf(doc, 'drawings').length >= 2);
    assert.equal(doc.commands, undefined);
  });

  it('8. hints are whole commands that exist', async () => {
    const names = new Set(COMMANDS.map((c) => c.name).filter(Boolean));
    let seen = 0;
    for (const args of [
      [],
      ...LISTS.map((l) => l[1]),
      ...RECORDS.filter((r) => r[0] !== 'version'),
    ]) {
      const r = await run(...args);
      const hints = helpLines(r.stdout);
      assert.ok(
        hints.length >= 1 && hints.length <= 3,
        `${args.join(' ')}: ${hints.length} hints`,
      );
      for (const hint of hints) {
        const found = /^Run `cad-axi ([a-z-]+)[^`]*`/.exec(hint);
        if (!found) continue;
        seen++;
        assert.ok(names.has(found[1] ?? ''), hint);
      }
    }
    assert.ok(seen > 10, `${seen} runnable hints`);
  });

  it('9. help is short, and every command has its own', async () => {
    const top = await run('--help');
    assert.equal(top.code, 0);
    const listed = rowsOf(body(top.stdout), 'commands').map((c) => c.command);
    assert.deepEqual(
      listed,
      COMMANDS.map((c) => (c.name ? `cad-axi ${c.name}` : 'cad-axi')),
    );
    assert.ok(top.stdout.length < 3000, `${top.stdout.length} characters`);
    for (const command of COMMANDS.filter((c) => c.name)) {
      const r = await run(command.name, '--help');
      assert.equal(r.code, 0, command.name);
      const help = body(r.stdout);
      assert.equal(help.command, `cad-axi ${command.name}`);
      assert.ok(r.stdout.length < 3000, `${command.name}: ${r.stdout.length}`);
      assert.deepEqual(
        body((await run('help', command.name)).stdout),
        help,
        command.name,
      );
    }
  });

  it('10. default output is bounded, and --full is bounded higher', async () => {
    for (const args of [
      [],
      ['info', 'plan.dwg'],
      ['layers', 'plan.dwg', '--limit', '999'],
      ['texts', 'plan.dwg', '--limit', '999'],
      ['query', 'plan.dwg', '--limit', '999'],
      ['runs', 'plan.dwg', '--layer', 'SAN', '--limit', '999'],
    ]) {
      const r = await run(...args);
      assert.equal(r.code, 0, args.join(' '));
      assert.ok(
        r.stdout.length <= OUTPUT_LIMIT,
        `${args.join(' ')}: ${r.stdout.length} characters`,
      );
    }
    const full = await run('texts', 'plan.dwg', '--full');
    assert.equal(full.code, 0);
    assert.ok(Buffer.byteLength(full.stdout) <= FULL_LIMIT);
  });

  it('text from the file cannot hide or reorder output', async () => {
    const { visibleString } = await import('../../src/output/text.ts');
    assert.equal(visibleString('a‮b'), 'a\\u202eb');
    assert.equal(visibleString('a\u0007b​c'), 'a\\u0007b\\u200bc');
    assert.equal(visibleString('צנרת'), 'צנרת');
  });
});
