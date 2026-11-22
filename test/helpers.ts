import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from '@toon-format/toon';
import { sampleDxf } from './fixtures/sample.ts';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cad-axi-test-'));
}

/** The binary under test: dist when CAD_AXI_BIN=dist, else the TypeScript source. */
export const BIN =
  process.env.CAD_AXI_BIN === 'dist'
    ? new URL('../dist/bin/cad-axi.js', import.meta.url).pathname
    : new URL('../src/bin/cad-axi.ts', import.meta.url).pathname;

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the binary as a separate process in `cwd`, with closed stdin. */
export function runBinary(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      {
        cwd,
        env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

let cached: string | null = null;

/**
 * A folder holding the sample drawing as DXF and, converted by the tool
 * itself, as DWG; and some files that are not drawings.
 */
export async function fixtureFolder(): Promise<string> {
  if (!cached) {
    const dir = tempDir();
    writeFileSync(join(dir, 'plan.dxf'), sampleDxf());
    const r = await runBinary(
      ['convert', 'plan.dxf', '--out', 'plan.dwg'],
      dir,
    );
    if (r.code !== 0)
      throw new Error(`the sample could not be converted: ${r.stdout}`);
    cached = dir;
  }
  const dir = tempDir();
  for (const f of ['plan.dxf', 'plan.dwg'])
    copyFileSync(join(cached, f), join(dir, f));
  writeFileSync(join(dir, 'notes.txt'), 'not a drawing\n');
  writeFileSync(join(dir, 'fake.dwg'), 'AC1032 but nothing else of a drawing');
  writeFileSync(
    join(dir, 'old.dwg'),
    Buffer.concat([Buffer.from('AC1012'), Buffer.alloc(256)]),
  );
  return dir;
}

/** The whole output, help footer included, as one TOON document. */
export function body(text: string): Record<string, unknown> {
  return decode(text) as Record<string, unknown>;
}

export function rowsOf(
  doc: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const rows = doc[key];
  if (!Array.isArray(rows)) throw new Error(`no ${key} in the output`);
  return rows as Array<Record<string, unknown>>;
}

/** Metres to the millimetre, as the tool prints them. */
export const m = (mm: number): number => Math.round(mm * 0.001 * 1000) / 1000;
