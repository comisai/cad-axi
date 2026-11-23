// The closed grammar of writing, the preflight and the verify step, without
// the engine: a deliberately wrong output must be caught.

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runEngine } from '../../src/bridge/engine.ts';
import { AxiError } from '../../src/errors.ts';
import {
  type Drawing,
  type Entity,
  emptyDrawing,
} from '../../src/model/drawing.ts';
import { preflight } from '../../src/write/preflight.ts';
import {
  checkOps,
  checkSpec,
  type Names,
  outsideCodepage,
} from '../../src/write/schema.ts';
import { verifyCreate, verifyEdit } from '../../src/write/verify.ts';
import { tempDir } from '../helpers.ts';

const base = (): Names => ({
  layers: new Set(['0', 'SAN']),
  linetypes: new Set(['ByLayer', 'ByBlock', 'Continuous']),
  styles: new Set(['Standard']),
  blocks: new Map([['HEAD', new Set(['SIZE'])]]),
  spaces: new Set(['Model', 'Sheet']),
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AxiError) return `${e.code}:${e.fields.field ?? ''}`;
    throw e;
  }
  return 'ok';
};

describe('the specification grammar', () => {
  it('accepts every kind', () => {
    const spec = checkSpec(
      {
        units: 'mm',
        layers: [{ name: 'NEW', color: 1 }],
        blocks: [
          {
            name: 'B',
            entities: [
              {
                kind: 'attdef',
                tag: 'T',
                prompt: 'p',
                value: '',
                at: [0, 0],
                height: 1,
              },
            ],
          },
        ],
        entities: [
          { kind: 'line', layer: 'NEW', from: [0, 0], to: [1, 1] },
          {
            kind: 'polyline',
            pts: [
              [0, 0],
              [1, 0],
            ],
            bulges: [0.5, 0],
            closed: false,
          },
          { kind: 'circle', center: [0, 0], radius: 1 },
          { kind: 'arc', center: [0, 0], radius: 1, start: 0, end: 90 },
          {
            kind: 'text',
            at: [0, 0],
            height: 1,
            value: '\u05e9\u05dc\u05d5\u05dd',
            rotation: 30,
          },
          { kind: 'mtext', at: [0, 0], height: 1, value: 'a\nb' },
          { kind: 'point', at: [0, 0, 0] },
          { kind: 'insert', block: 'B', at: [0, 0], attribs: { T: 'x' } },
          {
            kind: 'insert',
            block: 'HEAD',
            at: [0, 0],
            scale: [2, 2],
            space: 'Sheet',
          },
        ],
      },
      base(),
    );
    assert.equal(spec.entities.length, 9);
  });

  it('refuses what it has no word for, naming the field and never the value', () => {
    const one = (e: unknown) =>
      code(() => checkSpec({ entities: [e] }, base()));
    assert.equal(
      one({ kind: 'xref', path: 'C:/x.dwg' }),
      'invalid_spec:spec.entities[0].kind',
    );
    assert.equal(
      one({ kind: 'line', from: [0, 0], to: [1, 1], url: 'http://x' }),
      'invalid_spec:spec.entities[0].url',
    );
    assert.equal(
      one({ kind: 'text', at: [0, 0], height: 1, value: '%<\\AcVar Date>%' }),
      'invalid_spec:spec.entities[0].value',
    );
    assert.equal(
      one({ kind: 'text', at: [0, 0], height: 1, value: 'a\u0007' }),
      'invalid_spec:spec.entities[0].value',
    );
    assert.equal(
      one({ kind: 'text', at: [0, 0], height: 1, value: 'x'.repeat(2001) }),
      'invalid_spec:spec.entities[0].value',
    );
    assert.equal(
      one({ kind: 'line', from: [0, Number.NaN], to: [1, 1] }),
      'invalid_spec:spec.entities[0].from[1]',
    );
    assert.equal(
      one({ kind: 'line', from: [0, 2e9], to: [1, 1] }),
      'invalid_spec:spec.entities[0].from[1]',
    );
    assert.equal(
      one({ kind: 'line', layer: 'NOPE', from: [0, 0], to: [1, 1] }),
      'unknown_layer:spec.entities[0].layer',
    );
    assert.equal(
      one({ kind: 'insert', block: 'NOPE', at: [0, 0] }),
      'unknown_block:spec.entities[0].block',
    );
    assert.equal(
      one({
        kind: 'insert',
        block: 'HEAD',
        at: [0, 0],
        attribs: { NOPE: '1' },
      }),
      'invalid_spec:spec.entities[0].attribs',
    );
    assert.equal(
      one({ kind: 'attdef', tag: 'T', at: [0, 0], height: 1 }),
      'invalid_spec:spec.entities[0].kind',
    );
    assert.equal(
      code(() => checkSpec({ layers: [{ name: 'a/b' }] }, base())),
      'invalid_spec:spec.layers[0].name',
    );
    assert.equal(
      code(() =>
        checkSpec({ styles: [{ name: 'S', font: '../../etc/x.ttf' }] }, base()),
      ),
      'invalid_spec:spec.styles[0].font',
    );
    assert.equal(
      code(() =>
        checkSpec({ blocks: [{ name: '*U1', entities: [] }] }, base()),
      ),
      'invalid_spec:spec.blocks[0].name',
    );
    assert.equal(
      code(() =>
        checkSpec(
          {
            entities: Array.from({ length: 100_001 }, () => ({
              kind: 'point',
              at: [0, 0],
            })),
          },
          base(),
        ),
      ),
      'invalid_spec:spec.entities',
    );
  });

  it('the operations grammar checks handles, tags and layers against the source', () => {
    const targets = {
      kinds: new Map([
        ['1A', 'TEXT'],
        ['2B', 'INSERT'],
        ['3C', 'LINE'],
      ]),
      tags: new Map([['2B', new Set(['SIZE'])]]),
    };
    const ok = checkOps(
      {
        ops: [
          { op: 'set_text', h: '1a', value: 'x' },
          { op: 'set_attribute', h: '2B', tag: 'SIZE', value: '1"' },
          { op: 'add_layer', name: 'NEW', color: 2 },
          { op: 'set_layer', h: '3C', layer: 'NEW' },
          { op: 'add_line', layer: 'NEW', from: [0, 0], to: [1, 1] },
        ],
      },
      base(),
      targets,
    );
    assert.equal(ok[0]?.h, '1A');
    const bad = (op: unknown) =>
      code(() => checkOps({ ops: [op] }, base(), targets));
    assert.equal(
      bad({ op: 'set_text', h: 'FFFF', value: 'x' }),
      'unknown_handle:ops[0].h',
    );
    assert.equal(
      bad({ op: 'set_text', h: '3C', value: 'x' }),
      'invalid_spec:ops[0].h',
    );
    assert.equal(
      bad({ op: 'set_attribute', h: '2B', tag: 'NO', value: 'x' }),
      'invalid_spec:ops[0].tag',
    );
    assert.equal(
      bad({ op: 'set_layer', h: '3C', layer: 'NEW' }),
      'unknown_layer:ops[0].layer',
    );
    assert.equal(bad({ op: 'add_xref', path: 'x' }), 'invalid_spec:ops[0].op');
    assert.equal(
      bad({ op: 'move', h: '3C', by: [0, 0], extra: 1 }),
      'invalid_spec:ops[0].extra',
    );
    assert.equal(
      code(() =>
        checkOps(
          {
            ops: [
              { op: 'delete', h: '3C' },
              { op: 'move', h: '3C', by: [1, 1] },
            ],
          },
          base(),
          targets,
        ),
      ),
      'invalid_spec:ops[1].h',
    );
  });

  it('knows which text a code page cannot carry', () => {
    assert.equal(
      outsideCodepage(['\u05e9\u05dc\u05d5\u05dd'], 'ANSI_1255'),
      false,
    );
    assert.equal(outsideCodepage(['\u05e9'], 'ANSI_1252'), true);
    assert.equal(outsideCodepage(['\u00d8110'], 'ANSI_1255'), true);
  });
});

const e = (x: Partial<Entity>): Entity => ({
  h: '1',
  kind: 'LINE',
  layer: '0',
  owner: '*Model_Space',
  color: 256,
  lt: 'ByLayer',
  ...x,
});

function drawing(entities: Entity[]): Drawing {
  const d = emptyDrawing();
  d.layers = [
    {
      name: '0',
      on: true,
      frozen: false,
      locked: false,
      plot: true,
      color: 7,
      linetype: 'Continuous',
      entities: 0,
    },
  ];
  d.blocks.set('*Model_Space', {
    name: '*Model_Space',
    base: [0, 0, 0],
    layout: true,
    anonymous: false,
    external: false,
    overlay: false,
    dependent: false,
    path_present: false,
    attributes: [],
    entities: entities.length,
  });
  for (const x of entities) {
    d.entities.push(x);
    d.byOwner.set(x.owner, [...(d.byOwner.get(x.owner) ?? []), x]);
  }
  return d;
}

describe('the verify step', () => {
  const spec = checkSpec(
    {
      entities: [
        { kind: 'line', from: [0, 0], to: [10, 0] },
        { kind: 'text', at: [0, 0], height: 2, value: 'A' },
      ],
    },
    base(),
  );

  it('passes an output that matches the specification', () => {
    const out = drawing([
      e({ a: [0, 0, 0], b: [10, 0, 0] }),
      e({ h: '2', kind: 'TEXT', raw: 'A', at: [0, 0, 0], height: 2, rot: 0 }),
    ]);
    assert.deepEqual(verifyCreate(spec, out, '*Model_Space'), { entities: 2 });
  });

  it('catches a deliberately wrong output: moved, dropped or extra', () => {
    const moved = drawing([
      e({ a: [0, 0, 0], b: [10, 0.001, 0] }),
      e({ h: '2', kind: 'TEXT', raw: 'A', at: [0, 0, 0], height: 2, rot: 0 }),
    ]);
    assert.equal(
      code(() => verifyCreate(spec, moved, '*Model_Space')),
      'verify_failed:',
    );
    const dropped = drawing([e({ a: [0, 0, 0], b: [10, 0, 0] })]);
    assert.equal(
      code(() => verifyCreate(spec, dropped, '*Model_Space')),
      'verify_failed:',
    );
    const extra = drawing([
      e({ a: [0, 0, 0], b: [10, 0, 0] }),
      e({ h: '2', kind: 'TEXT', raw: 'A', at: [0, 0, 0], height: 2, rot: 0 }),
      e({ h: '3', a: [0, 0, 0], b: [1, 1, 0] }),
    ]);
    assert.equal(
      code(() => verifyCreate(spec, extra, '*Model_Space')),
      'verify_failed:',
    );
  });

  it('an edit: untouched entities unchanged, every operation present, nothing lost', () => {
    const src = drawing([
      e({ h: 'A', a: [0, 0, 0], b: [1, 0, 0] }),
      e({ h: 'B', kind: 'TEXT', raw: 'x', at: [0, 0, 0], height: 1, rot: 0 }),
      e({ h: 'C', a: [5, 5, 0], b: [6, 6, 0] }),
    ]);
    const ops = [
      { op: 'set_text', h: 'B', value: 'y' },
      { op: 'delete', h: 'C' },
    ];
    const good = drawing([
      e({ h: 'A', a: [0, 0, 0], b: [1, 0, 0] }),
      e({ h: 'B', kind: 'TEXT', raw: 'y', at: [0, 0, 0], height: 1, rot: 0 }),
    ]);
    assert.deepEqual(verifyEdit(src, good, ops, []), {
      kept: 1,
      changed: 1,
      deleted: 1,
      added: 0,
    });
    const dropped = drawing([
      e({ h: 'B', kind: 'TEXT', raw: 'y', at: [0, 0, 0], height: 1, rot: 0 }),
    ]);
    assert.equal(
      code(() => verifyEdit(src, dropped, ops, [])),
      'verify_failed:',
    );
    const touched = drawing([
      e({ h: 'A', a: [0, 0, 0], b: [1, 0, 0], color: 1 }),
      e({ h: 'B', kind: 'TEXT', raw: 'y', at: [0, 0, 0], height: 1, rot: 0 }),
    ]);
    assert.equal(
      code(() => verifyEdit(src, touched, ops, [])),
      'verify_failed:',
    );
    const notDone = drawing([
      e({ h: 'A', a: [0, 0, 0], b: [1, 0, 0] }),
      e({ h: 'B', kind: 'TEXT', raw: 'x', at: [0, 0, 0], height: 1, rot: 0 }),
    ]);
    assert.equal(
      code(() => verifyEdit(src, notDone, ops, [])),
      'verify_failed:',
    );
  });

  it('a lost class or layer fails the census', () => {
    const src = drawing([]);
    src.classes = [
      {
        name: 'SCALE',
        cpp: '',
        app: '',
        instances: 3,
        entity: false,
        unknown: 0,
      },
    ];
    assert.equal(
      code(() => verifyEdit(src, drawing([]), [], [])),
      'verify_failed:',
    );
  });

  it('the preflight names what would be lost', () => {
    const d = drawing([]);
    d.kinds = new Map([
      ['LINE', 3],
      ['ACAD_TABLE', 1],
    ]);
    d.objects = [{ name: 'XRECORD', count: 2, unknown: false }];
    const pf = preflight(d);
    assert.equal(pf.editable, false);
    assert.deepEqual(
      pf.losses.map((l) => l.name),
      ['XRECORD', 'ACAD_TABLE'],
    );
    d.kinds = new Map([['LINE', 3]]);
    d.objects = [{ name: 'DICTIONARY', count: 9, unknown: false }];
    assert.equal(preflight(d).editable, true);
  });
});

describe('the engine bridge', () => {
  const fake = (script: string): string => {
    const path = join(tempDir(), 'engine');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const run = (script: string, deadline?: number) =>
    runEngine(['read', 'x'], {
      engine: fake(script),
      now: () => Date.now(),
      ...(deadline ? { deadline } : {}),
    }).then(
      () => 'ok',
      (error: AxiError) => error.code,
    );

  it('maps garbage, an unknown protocol, a crash, a hang and an error record to codes', async () => {
    assert.equal(await run("echo 'not json'"), 'engine_failed');
    assert.equal(await run(`echo '{"p":2,"type":"end"}'`), 'engine_failed');
    assert.equal(
      await run(`echo '{"p":1,"type":"surprise"}'`),
      'engine_failed',
    );
    assert.equal(await run('kill -SEGV $$'), 'engine_failed');
    assert.equal(await run('exit 0'), 'engine_failed');
    assert.equal(
      await run(
        `echo '{"p":1,"type":"error","code":"damaged","exception":"EndOfStreamException"}'; exit 1`,
      ),
      'damaged',
    );
    assert.equal(
      await run(`echo '{"p":1,"type":"error","code":"weird"}'; exit 1`),
      'internal_error',
    );
    assert.equal(await run(`echo '{"p":1,"type":"end","entities":0}'`), 'ok');
    assert.equal(await run('exec sleep 30', Date.now() + 300), 'timed_out');
  });

  it('refuses a line over the limit', async () => {
    assert.equal(
      await run(`head -c 1100000 /dev/zero | tr '\\0' 'a'`),
      'engine_failed',
    );
  });

  it('names the missing glibc version without exposing loader stderr', async () => {
    const diagnostic = ['2.34', '2.38']
      .map(
        (version) =>
          `/invented/engine: /invented/libc.so.6: version \`GLIBC_${version}' not found (required by /invented/engine)`,
      )
      .join('\n');
    await assert.rejects(
      runEngine(['probe'], {
        engine: fake(`cat >&2 <<'LOADER'\n${diagnostic}\nLOADER\nexit 1`),
        now: () => Date.now(),
      }),
      (error: AxiError) =>
        error.code === 'unsupported_platform' &&
        /glibc 2\.38 or later/.test(error.message) &&
        !error.message.includes('/invented/'),
    );
    assert.equal(
      await run("echo 'random stderr' >&2; exit 1"),
      'engine_failed',
    );
  });
});
