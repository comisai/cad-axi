// Every command in docs/recipes.md runs, on the sample drawing.

import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { body, fixtureFolder, rowsOf, runBinary } from '../helpers.ts';

const text = readFileSync(
  new URL('../../docs/recipes.md', import.meta.url),
  'utf8',
);
const commands = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
  (m[1] as string).split('\n').filter((l) => l.startsWith('cad-axi ')),
);
const json = [
  ...text.matchAll(/with `([a-z]+\.json)`[^\n]*\n\n```json\n([\s\S]*?)```/g),
].map((m) => [m[1] as string, m[2] as string]);

/** Split a command line as a shell would, for the simple quoting the recipes use. */
const words = (line: string) =>
  [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? (m[2] as string));

let dir: string;
before(async () => {
  dir = realpathSync(await fixtureFolder());
  const cw = rowsOf(
    body((await runBinary(['query', 'plan.dwg', '--layer', 'CW'], dir)).stdout),
    'entities',
  )[0];
  for (const [name, content] of json)
    writeFileSync(
      join(dir, name),
      content.replace('<handle from query>', String(cw?.h)),
    );
});

describe('recipes', () => {
  it('finds the recipes', () => {
    assert.ok(commands.length >= 14, `${commands.length} commands`);
    assert.deepEqual(json.map((j) => j[0]).sort(), ['markup.json', 'ops.json']);
  });
  for (const line of commands)
    it(line, async () => {
      const r = await runBinary(words(line).slice(1), dir);
      assert.equal(r.code, 0, r.stdout);
    });
});
