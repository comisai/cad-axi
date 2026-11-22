// Damaged and hostile files, made from the sample with fixed seeds: each must
// end in a closed error, or a normal answer, within the limits. A crash
// without a record (`engine_failed`) or an internal error is a bug.

import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { body, fixtureFolder, runBinary } from '../helpers.ts';

let dir: string;
const ALLOWED = new Set([
  'damaged',
  'not_cad',
  'unsupported',
  'too_large',
  'timed_out',
]);

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

function cases(dwg: Buffer, dxf: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  for (const share of [0.02, 0.1, 0.5, 0.9, 0.99]) {
    out.push([
      `dwg-cut-${share}`,
      dwg.subarray(0, Math.floor(dwg.length * share)),
    ]);
    out.push([
      `dxf-cut-${share}`,
      dxf.subarray(0, Math.floor(dxf.length * share)),
    ]);
  }
  for (let k = 0; k < 24; k++) {
    const rand = random(1000 + k);
    const b = Buffer.from(dwg);
    const flips = k < 12 ? 1 : 64;
    for (let i = 0; i < flips; i++)
      b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    out.push([`dwg-flip-${k}`, b]);
  }
  for (let k = 0; k < 6; k++) {
    const rand = random(2000 + k);
    const text = dxf.toString('latin1').split('\r\n');
    for (let i = 0; i < 20; i++) {
      const at = Math.floor(rand() * text.length);
      text[at] = ['-1e308', 'NaN', '999999999999', 'x', '', '0'][
        Math.floor(rand() * 6)
      ] as string;
    }
    out.push([`dxf-garble-${k}`, Buffer.from(text.join('\r\n'), 'latin1')]);
  }
  out.push(['dwg-header-only', dwg.subarray(0, 128)]);
  out.push([
    'dwg-zeros',
    Buffer.concat([dwg.subarray(0, 6), Buffer.alloc(dwg.length)]),
  ]);
  out.push([
    'dxf-deep',
    Buffer.from(
      `  0\r\nSECTION\r\n  2\r\nENTITIES\r\n${'  0\r\nPOLYLINE\r\n  8\r\n0\r\n 66\r\n1\r\n'.repeat(5000)}  0\r\nENDSEC\r\n  0\r\nEOF\r\n`,
    ),
  ]);
  out.push(['empty', Buffer.alloc(0)]);
  return out;
}

before(async () => {
  dir = realpathSync(await fixtureFolder());
});

describe('hostile files', () => {
  it('every one ends in a closed error or an answer, quickly', async () => {
    const dwg = readFileSync(join(dir, 'plan.dwg'));
    const dxf = readFileSync(join(dir, 'plan.dxf'));
    const seen = new Map<string, number>();
    for (const [name, bytes] of cases(dwg, dxf)) {
      const file = `${name}.${name.startsWith('dxf') ? 'dxf' : 'dwg'}`;
      writeFileSync(join(dir, file), bytes);
      for (const command of ['info', 'measure']) {
        const start = Date.now();
        const r = await runBinary([command, file, '--units', 'mm'], dir);
        const ms = Date.now() - start;
        assert.ok(ms < 30_000, `${file} ${command}: ${ms} ms`);
        assert.equal(r.stderr, '', file);
        const doc = body(r.stdout);
        if (r.code === 0) continue;
        assert.equal(r.code, 1, `${file} ${command}: ${r.stdout}`);
        assert.ok(
          ALLOWED.has(String(doc.code)),
          `${file} ${command}: ${doc.code} ${doc.exception ?? ''}`,
        );
        seen.set(String(doc.code), (seen.get(String(doc.code)) ?? 0) + 1);
      }
    }
    assert.ok((seen.get('damaged') ?? 0) > 0, 'some files are damaged');
  });
});
