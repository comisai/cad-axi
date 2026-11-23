// Dispatch: home view with no command, help and version, then one command.
// Everything goes to stdout. Exit codes: 0 ok, 1 error, 2 usage.

import { encode } from '@toon-format/toon';
import {
  ALL_FLAG,
  FULL_FLAG,
  LAYER_FLAG,
  LIMIT_FLAG,
  MAX_BYTES_FLAG,
  REGION_FLAG,
  SAVE_FLAG,
  SPACE_FLAG,
  UNITS_FLAG,
} from '../commands/common.ts';
import { check, diff, renderCommand } from '../commands/compare.ts';
import { DESCRIPTION, home, info, version } from '../commands/info.ts';
import { measure, runs } from '../commands/measure.ts';
import { blocks, layers, query, texts } from '../commands/tables.ts';
import { convert, create, edit } from '../commands/write.ts';
import { AxiError, usage } from '../errors.ts';
import { errorText, helpBlock } from '../output/toon.ts';
import { VERSION } from '../version.ts';
import { parseCommand } from './parse.ts';
import {
  BIN,
  type CommandSpec,
  commandName,
  type FlagSpec,
  type Io,
  usageLine,
} from './table.ts';

const FILE = [{ name: '<file>', required: true }];
const MATCH: FlagSpec = {
  type: 'string',
  value: '<regex>',
  summary: 'Only texts that match, ignoring case',
};
const GROUP: FlagSpec = {
  type: 'string',
  multiple: true,
  value: '<name>=<layer>',
  summary: 'Layers measured as one system, joined by +: sewer=SAN+VENT',
};
const GAP: FlagSpec = {
  type: 'string',
  value: '<units>',
  summary: 'Ends this close, in drawing units, join; default 10 mm',
};
const REACH: FlagSpec = {
  type: 'string',
  value: '<n>',
  summary:
    'A size label may sit this many of its text heights from its run, default 3',
};
const OUT: FlagSpec = {
  type: 'string',
  required: true,
  value: '<new.dwg|new.dxf>',
  summary: 'The new file to write; never replaced',
};
const AS: FlagSpec = {
  type: 'string',
  value: '<2018|2013|2010|2004|2000>',
  summary: 'Output version, default 2018',
};
const READ = { 'max-bytes': MAX_BYTES_FLAG };
const THREE_D: FlagSpec = {
  type: 'boolean',
  summary: 'Measure 3D length in XYZ. The default is plan length in XY.',
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: '',
    args: [],
    flags: {},
    summary: 'Home view: the DWG and DXF drawings in this folder',
    run: home,
  },
  {
    name: 'info',
    args: FILE,
    flags: { units: UNITS_FLAG, full: FULL_FLAG, ...READ },
    summary:
      'Drawing version, units, layouts, counts, reference locations and whether it can be edited',
    run: info,
  },
  {
    name: 'layers',
    args: FILE,
    flags: {
      match: {
        type: 'string',
        value: '<text>',
        summary: 'Only layers whose name contains this',
      },
      space: SPACE_FLAG,
      region: REGION_FLAG,
      units: UNITS_FLAG,
      '3d': THREE_D,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Layers with their state, colour, entity count and the length drawn on each',
    run: layers,
  },
  {
    name: 'blocks',
    args: FILE,
    flags: {
      match: {
        type: 'string',
        value: '<text>',
        summary: 'Only blocks whose name contains this',
      },
      all: { type: 'boolean', summary: 'Include anonymous blocks' },
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Blocks with insert counts and attribute tags. Use --full for reference locations',
    run: blocks,
  },
  {
    name: 'texts',
    args: FILE,
    flags: {
      layer: LAYER_FLAG,
      match: MATCH,
      region: REGION_FLAG,
      space: {
        ...SPACE_FLAG,
        summary: 'Model space, the default, a layout by name, or all',
      },
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Decoded TEXT, MTEXT and attributes. Use --full for raw text and the decoding rule',
    run: texts,
  },
  {
    name: 'query',
    args: FILE,
    flags: {
      type: {
        type: 'string',
        multiple: true,
        value: '<kind>',
        summary: 'An entity kind: LINE, LWPOLYLINE, INSERT, TEXT…',
      },
      layer: LAYER_FLAG,
      block: {
        type: 'string',
        multiple: true,
        value: '<name>',
        summary: 'Inserts of this block',
      },
      count: {
        type: 'boolean',
        summary:
          'Count inserts per named block and region, including zero counts',
      },
      handle: {
        type: 'string',
        multiple: true,
        value: '<h>',
        summary: 'One entity by its handle',
      },
      region: {
        ...REGION_FLAG,
        multiple: true,
        summary: 'A box in drawing units. Repeat for several regions',
      },
      '3d': THREE_D,
      space: {
        ...SPACE_FLAG,
        summary: 'Model space, the default, a layout by name, or all',
      },
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Entities by kind, layer, block, region or handle, or counts of named blocks',
    run: query,
  },
  {
    name: 'measure',
    args: FILE,
    flags: {
      by: {
        type: 'string',
        value: '<layer|linetype|color|size>',
        summary: 'Group lengths by this, default layer',
      },
      group: GROUP,
      layer: LAYER_FLAG,
      gap: GAP,
      reach: REACH,
      region: REGION_FLAG,
      space: SPACE_FLAG,
      units: UNITS_FLAG,
      '3d': THREE_D,
      all: ALL_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Length by layer, linetype, colour, named group or pipe size, with the part in blocks shown apart',
    run: measure,
  },
  {
    name: 'runs',
    args: FILE,
    flags: {
      layer: LAYER_FLAG,
      group: GROUP,
      gap: GAP,
      reach: REACH,
      min: {
        type: 'string',
        value: '<units>',
        summary: 'Leave out runs shorter than this, in drawing units',
      },
      region: REGION_FLAG,
      space: SPACE_FLAG,
      units: UNITS_FLAG,
      '3d': THREE_D,
      all: ALL_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Connected runs on chosen layers, joined end to end, with the size labels beside them',
    run: runs,
  },
  {
    name: 'render',
    args: FILE,
    flags: {
      out: {
        type: 'string',
        required: true,
        value: '<file.svg>',
        summary: 'The picture to write',
      },
      layer: LAYER_FLAG,
      region: REGION_FLAG,
      space: SPACE_FLAG,
      width: {
        type: 'string',
        value: '<px>',
        summary: 'Picture width in pixels, default 1600',
      },
      'no-text': { type: 'boolean', summary: 'Leave the text out' },
      all: ALL_FLAG,
      force: {
        type: 'boolean',
        summary: 'Replace the --out picture if it exists',
      },
      ...READ,
    },
    summary:
      'Write a picture of a space, a region or some layers as SVG, to look at',
    run: renderCommand,
  },
  {
    name: 'diff',
    args: [
      { name: '<a>', required: true },
      { name: '<b>', required: true },
    ],
    flags: {
      each: {
        type: 'boolean',
        summary: 'One row per entity that differs, instead of counts by layer',
      },
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
      ...READ,
    },
    summary:
      'Entities added, removed and changed between two drawings, by layer',
    run: diff,
  },
  {
    name: 'check',
    args: FILE,
    flags: { full: FULL_FLAG, ...READ },
    summary:
      'Read a drawing again and check it holds together: handles, owners, layers, blocks, counts',
    run: check,
  },
  {
    name: 'create',
    args: [],
    flags: {
      spec: {
        type: 'string',
        required: true,
        value: '<spec.json>',
        summary: 'The drawing to create, in the closed specification grammar',
      },
      out: OUT,
      like: {
        type: 'string',
        value: '<file>',
        summary:
          "Copy this drawing's units, layers, linetypes and text styles: an overlay",
      },
      as: AS,
      ...READ,
    },
    summary:
      'A new drawing from a specification, read again and checked before it is written',
    run: create,
  },
  {
    name: 'edit',
    args: FILE,
    flags: {
      ops: {
        type: 'string',
        required: true,
        value: '<ops.json>',
        summary: 'The operations, by handles from `query`',
      },
      out: OUT,
      as: AS,
      ...READ,
    },
    summary:
      'A copy with a closed list of operations applied; refuses a drawing it cannot carry',
    run: edit,
  },
  {
    name: 'convert',
    args: FILE,
    flags: { out: OUT, as: AS, ...READ },
    summary:
      'A copy in another version or format, under the same refusal and checks',
    run: convert,
  },
  {
    name: 'version',
    args: [],
    flags: {},
    summary: 'The package, engine and ACadSharp versions',
    run: version,
  },
  {
    name: 'help',
    args: [{ name: '<command>', required: false }],
    flags: {},
    summary: 'Show help for a command',
    run: async () => '',
  },
];

const HOME = COMMANDS[0] as CommandSpec;
const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V']);

export function topHelp(): string {
  return `${encode({
    description: DESCRIPTION,
    usage: `${BIN} [command] [flags]`,
    commands: COMMANDS.map((c) => ({
      command: commandName(c),
      summary: c.summary,
    })),
    coordinates:
      'drawing units in world coordinates, as the CAD program shows them; lengths are printed in metres when the units are known',
    files:
      'reads only the files named; writes only --out and --save, and never replaces a drawing',
    settings: 'COMIS_DEADLINE (epoch ms): stop and say so before this time',
  })}\n${helpBlock([`Run \`${BIN} help <command>\` for its flags`])}`;
}

export function commandHelp(spec: CommandSpec): string {
  const flags = Object.entries(spec.flags).map(([name, f]) => ({
    flag:
      f.type === 'string' ? `--${name} ${f.value ?? '<value>'}` : `--${name}`,
    summary: f.multiple ? `${f.summary} (repeatable)` : f.summary,
  }));
  return `${encode({
    command: commandName(spec),
    summary: spec.summary,
    usage: usageLine(spec),
    ...(flags.length ? { flags } : {}),
  })}\n`;
}

function find(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name && c.name !== '');
}

function unknownCommand(name: string): AxiError {
  const shown = /^[a-z][a-z-]{0,30}$/.test(name)
    ? `\`${name}\``
    : 'that command';
  const names = COMMANDS.filter((c) => c.name).map((c) => c.name);
  return usage(`Unknown command ${shown}. Commands: ${names.join(', ')}.`);
}

export async function main(argv: string[], io: Io): Promise<number> {
  let spec: CommandSpec = HOME;
  let usageText = `${BIN} [command] [flags]`;
  try {
    const first = argv[0];
    if (argv.length === 1 && first && VERSION_FLAGS.has(first)) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (argv.length === 1 && first && HELP_FLAGS.has(first)) {
      io.stdout(topHelp());
      return 0;
    }
    let rest = argv;
    if (first && !first.startsWith('-')) {
      const found = find(first);
      if (!found) throw unknownCommand(first);
      spec = found;
      rest = argv.slice(1);
    }
    usageText = usageLine(spec);
    const beforeTerminator = rest.includes('--')
      ? rest.slice(0, rest.indexOf('--'))
      : rest;
    if (beforeTerminator.some((a) => HELP_FLAGS.has(a))) {
      io.stdout(commandHelp(spec));
      return 0;
    }
    const parsed = parseCommand(spec, rest);
    for (const [name, f] of Object.entries(spec.flags))
      if (f.required && parsed.values[name] === undefined)
        throw usage(`--${name} is required for \`${commandName(spec)}\`.`);
    if (spec.name === 'help') {
      const target = parsed.positionals[0];
      if (!target) {
        io.stdout(topHelp());
        return 0;
      }
      const found = find(target);
      if (!found) throw unknownCommand(target);
      io.stdout(commandHelp(found));
      return 0;
    }
    io.stdout(await spec.run({ ...parsed, io }));
    return 0;
  } catch (thrown) {
    const axi =
      thrown instanceof AxiError
        ? thrown
        : new AxiError(
            'internal_error',
            'cad-axi failed unexpectedly. Run the command once more; if it fails again, report it with a made-up drawing.',
          );
    io.stdout(errorText(axi, usageText));
    return axi.exitCode;
  }
}
