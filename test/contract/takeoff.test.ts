import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { type DxfDrawing, writeDxf } from '../fixtures/dxf.ts';
import { takeoffBays } from '../fixtures/takeoff.ts';
import { body, rowsOf, runBinary, tempDir } from '../helpers.ts';

function fixture(drawing: DxfDrawing) {
  const dir = tempDir();
  writeFileSync(join(dir, 'example.dxf'), writeDxf(drawing));
  return async (command: string, ...args: string[]) => {
    const result = await runBinary([command, 'example.dxf', ...args], dir);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, '');
    return body(result.stdout);
  };
}

it('takeoffs measure world XY and expose the Z span and explicit 3D length', async () => {
  const run = fixture({
    units: 6,
    layers: [{ name: 'PIPE', color: 2 }],
    blocks: [
      {
        name: 'PIPE_PART',
        entities: [
          { kind: 'LINE', layer: '0', from: [0, 0, 0], to: [3, 0, 4] },
        ],
      },
    ],
    model: [
      { kind: 'LINE', layer: 'PIPE', from: [0, 0, 0], to: [3, 4, 12] },
      {
        kind: 'INSERT',
        layer: 'PIPE',
        block: 'PIPE_PART',
        at: [3, 4, 12],
        scale: [2, 1, 2],
      },
      { kind: 'LINE', layer: 'PIPE', from: [3, 4, 12], to: [3, 4, 72] },
      { kind: 'TEXT', layer: '0', at: [4, 4.1], height: 0.5, value: 'DN80' },
    ],
  });
  const plan = await run('measure', '--layer', 'PIPE');
  assert.equal(rowsOf(plan, 'groups')[0]?.length, 11);
  assert.equal(rowsOf(plan, 'groups')[0]?.in_blocks, 6);
  assert.equal(plan.length_mode, 'plan (XY)');
  assert.equal(plan.z_dominant_entities, 1);
  assert.equal(plan.z_span, 72);

  const spatial = await run('measure', '--layer', 'PIPE', '--3d');
  assert.equal(rowsOf(spatial, 'groups')[0]?.length, 83);
  assert.equal(spatial.length_mode, '3D (XYZ)');
  const clipped = await run(
    'measure',
    '--layer',
    'PIPE',
    '--region',
    '0,0,1.5,2',
  );
  assert.equal(rowsOf(clipped, 'groups')[0]?.length, 2.5);
  const layers = await run('layers', '--match', 'PIPE');
  assert.equal(rowsOf(layers, 'layers')[0]?.length, 11);
  assert.equal(layers.length_mode, 'plan (XY)');
  const runs = await run('runs', '--layer', 'PIPE');
  assert.deepEqual(
    rowsOf(runs, 'runs').map((r) => [r.length, r.size]),
    [[11, 'DN80']],
  );
  const sized = await run('measure', '--by', 'size', '--layer', 'PIPE');
  assert.deepEqual(
    rowsOf(sized, 'sizes').map((r) => [r.length, r.size]),
    [[11, 'DN80']],
  );
  const spatialRuns = await run('runs', '--layer', 'PIPE', '--3d');
  assert.equal(
    rowsOf(spatialRuns, 'runs').reduce((sum, r) => sum + Number(r.length), 0),
    83,
  );
  assert.ok(rowsOf(spatialRuns, 'runs').every((r) => r.ends !== 'closed loop'));
  const queried = await run('query', '--type', 'LINE');
  assert.match(
    String(rowsOf(queried, 'entities')[0]?.detail),
    /length 5\b.*Z span 12\b/,
  );
  assert.match(
    String(rowsOf(queried, 'entities')[1]?.detail),
    /length 0\b.*Z span 60\b.*Z-dominant/,
  );
  const queried3d = await run('query', '--type', 'LINE', '--3d');
  assert.match(String(rowsOf(queried3d, 'entities')[0]?.detail), /length 13\b/);
  assert.equal(queried3d.length_mode, '3D (XYZ)');
});

it('info and query expose header, dimension, viewport and reference unit evidence', async () => {
  const run = fixture({
    units: 0,
    measurement: 1,
    layers: [],
    xrefs: [{ name: 'GRID', path: 'never-opened.dwg', units: 6 }],
    model: [
      {
        kind: 'DIMENSION',
        layer: '0',
        from: [0, 0],
        to: [350, 0],
        text: '3.5 m',
      },
      {
        kind: 'DIMENSION',
        layer: '0',
        from: [0, 0],
        to: [200, 0],
        text: '<> cm',
      },
      {
        kind: 'INSERT',
        layer: '0',
        block: 'GRID',
        at: [0, 0],
        scale: [100, 100, 100],
      },
    ],
    paper: [
      {
        kind: 'VIEWPORT',
        layer: '0',
        center: [30, 30],
        width: 60,
        height: 50,
        viewHeight: 50,
        id: 1,
      },
      {
        kind: 'VIEWPORT',
        layer: '0',
        center: [30, 30],
        width: 60,
        height: 50,
        viewHeight: 1000,
      },
    ],
  });
  const info = await run('info', '--units', 'mm');
  assert.equal(info.units, 'mm');
  assert.equal(info.declared_units, 'not stated');
  assert.deepEqual(info.unit_header, {
    insunits: 0,
    measurement_code: 1,
    measurement: 'metric',
  });
  const evidence = info.unit_evidence as Record<string, unknown>;
  assert.equal(evidence.suggested_units, 'cm');
  assert.match(String(evidence.suggestion_basis), /dimension/);
  assert.equal(rowsOf(evidence, 'references')[0]?.reference_units, 'm');
  assert.equal(rowsOf(evidence, 'viewports')[0]?.paper_per_model, 0.05);
  assert.equal(evidence.viewport_count, 1);
  const result = await run(
    'query',
    '--space',
    'all',
    '--type',
    'DIMENSION',
    '--type',
    'INSERT',
    '--type',
    'VIEWPORT',
  );
  const rows = rowsOf(result, 'entities');
  assert.match(
    String(rows.find((r) => r.kind === 'DIMENSION')?.detail),
    /drawn 350.*text 3.5 m/,
  );
  assert.match(
    String(rows.find((r) => r.kind === 'INSERT')?.detail),
    /scale 100,100,100/,
  );
  assert.match(
    String(rows.filter((r) => r.kind === 'VIEWPORT')[1]?.detail),
    /Sheet.*paper\/model 0.05/,
  );
  assert.doesNotMatch(JSON.stringify(info), /never-opened\.dwg/);
});

it('makes the unit behind an unlabelled reference scale conditional', async () => {
  const run = fixture({
    units: 0,
    layers: [],
    xrefs: [{ name: 'GRID', path: 'grid.dwg' }],
    model: [
      {
        kind: 'INSERT',
        layer: '0',
        block: 'GRID',
        at: [0, 0],
        scale: [100, 100, 100],
      },
      {
        kind: 'INSERT',
        layer: '0',
        block: 'GRID',
        at: [0, 0],
        scale: [100, 10, 1],
      },
    ],
  });
  const info = await run('info');
  assert.equal(info.units, 'not stated');
  const evidence = info.unit_evidence as Record<string, unknown>;
  assert.equal(evidence.suggested_units, undefined);
  const refs = rowsOf(evidence, 'references');
  assert.equal(refs[0]?.host_units_if_reference_is_metres, 'cm');
  assert.equal(refs[1]?.host_units_if_reference_is_metres, undefined);
});

it('reports conflicting unit evidence and keeps unitless takeoffs explicit', async () => {
  const run = fixture({
    units: 0,
    layers: [],
    model: [
      {
        kind: 'DIMENSION',
        layer: '0',
        from: [0, 0],
        to: [100, 0],
        text: '1 m',
      },
      {
        kind: 'DIMENSION',
        layer: '0',
        from: [0, 0],
        to: [100, 0],
        text: '100 mm',
      },
    ],
  });
  const info = await run('info');
  assert.equal(info.units, 'not stated');
  const evidence = info.unit_evidence as Record<string, unknown>;
  assert.equal(evidence.suggested_units, undefined);
  assert.match(String(evidence.suggestion_basis), /conflict/i);
});

it('sizes spaced runs with nearby non-pipe curves present', async () => {
  const run = fixture(takeoffBays(200));
  const sized = await run('measure', '--by', 'size', '--layer', 'PIPE');
  assert.deepEqual(rowsOf(sized, 'sizes'), [
    { group: 'PIPE', size: 'DN80', length: 20, runs: 200, basis: 'label' },
  ]);
});
