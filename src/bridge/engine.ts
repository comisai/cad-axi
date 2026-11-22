// The engine bridge: which binary, how it is started, and how its output is
// read. The engine runs once per command as a child process, with arguments
// only, a heap cap, a time limit and a hard kill at the deadline. Its stdout
// is newline-delimited JSON; every line is checked against the protocol.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxiError, type ErrorCode } from '../errors.ts';

export const PROTOCOL = 1;
/** An engine line longer than this is refused. */
export const MAX_LINE = 1024 * 1024;
/** The engine's own time limit when the deadline is later or unset. */
export const ENGINE_TIME_MS = 120_000;

const RECORD_TYPES = new Set([
  'probe',
  'header',
  'linetype',
  'style',
  'layer',
  'block',
  'external',
  'entity',
  'kind',
  'class',
  'object',
  'end',
  'error',
]);

export type EngineRecord = { p: number; type: string } & Record<
  string,
  unknown
>;

const PLATFORMS: Record<string, string> = {
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

/** The engine binary for this platform, or `unsupported_platform`. */
export function enginePath(): string {
  const rid = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!rid)
    throw new AxiError(
      'unsupported_platform',
      'There is no cad-axi engine for this operating system and processor. It runs on Linux on x64 and arm64.',
    );
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');
  // In the package the engines sit in dist/engine/<platform>/; in a source
  // checkout they are built into engine/out/<platform>/.
  const built = here.split(/[\\/]/).includes('dist');
  const path = built
    ? join(root, 'dist', 'engine', rid, 'cad-axi-engine')
    : join(root, 'engine', 'out', rid, 'cad-axi-engine');
  if (!existsSync(path))
    throw new AxiError(
      'unsupported_platform',
      built
        ? 'The engine for this platform is missing from the package. Reinstall cad-axi.'
        : 'The engine is not built. Build it with `dotnet publish` (CONTRIBUTING.md).',
    );
  return path;
}

/**
 * The heap cap for the engine, in bytes: most of the container's memory
 * limit, leaving room for Node. Without a limit, most of the machine's memory.
 */
export function heapLimit(): number {
  let limit = totalmem();
  for (const file of [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (/^\d+$/.test(text)) {
        const n = Number(text);
        if (n > 0 && n < limit) limit = n;
        break;
      }
    } catch {
      // No such control file.
    }
  }
  return Math.max(256 * 1024 * 1024, Math.floor(limit * 0.6));
}

export interface RunOptions {
  /** Tests only: another engine binary. Never taken from the environment. */
  engine?: string;
  /** Epoch milliseconds after which the engine is stopped. */
  deadline?: number | undefined;
  now: () => number;
  onRecord?: (record: EngineRecord) => void;
}

export interface EngineResult {
  records: EngineRecord[];
  last: EngineRecord;
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  not_found: 'No file at that path.',
  not_cad:
    'The file is not a DWG or DXF drawing. cad-axi reads DWG files from AutoCAD R14 to 2018 and later, and DXF files; for a drawing plotted to PDF use drawing-axi.',
  damaged:
    'The drawing could not be read: it is damaged or uses a structure the engine does not handle. Ask for a copy saved again from the CAD program, or run AUDIT and RECOVER there.',
  unsupported:
    'The drawing uses a version or feature the engine does not handle, such as DWG from R13 or older. Ask for a copy saved as AutoCAD 2000 or later.',
  too_large:
    'The drawing is larger than this tool reads at once: over the size, entity or memory limit.',
  timed_out:
    'The engine ran out of time before it finished. Run the command again with more time, or in a worker.',
  exists: 'The output file is already there. Name a new file with --out.',
  unknown_handle:
    'An operation names a handle the drawing does not hold. Take handles from `cad-axi query`.',
  unknown_layer: 'An operation names a layer the drawing does not hold.',
  unknown_block: 'An insert names a block the drawing does not define.',
  invalid_spec:
    'The specification or operations could not be applied to this drawing.',
};

const ENGINE_CODES = new Set<ErrorCode>([
  'not_found',
  'not_cad',
  'damaged',
  'unsupported',
  'too_large',
  'timed_out',
  'exists',
  'unknown_handle',
  'unknown_layer',
  'unknown_block',
  'invalid_spec',
]);

function engineError(record: EngineRecord): AxiError {
  const code = String(record.code);
  const exception =
    typeof record.exception === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.]{0,80}$/.test(record.exception)
      ? record.exception
      : undefined;
  if (ENGINE_CODES.has(code as ErrorCode)) {
    const fields: Record<string, string> = exception ? { exception } : {};
    return new AxiError(
      code as ErrorCode,
      MESSAGES[code as ErrorCode] ?? 'The engine refused the drawing.',
      fields,
    );
  }
  return new AxiError(
    'internal_error',
    'The engine failed on this drawing. Run `cad-axi check <file>`; if it fails again, report it with a made-up drawing that shows the problem.',
    exception ? { exception } : {},
  );
}

/** Run one engine verb and collect its records. */
export function runEngine(
  args: string[],
  options: RunOptions,
): Promise<EngineResult> {
  const engine = options.engine ?? enginePath();
  const now = options.now();
  const remaining =
    options.deadline === undefined
      ? ENGINE_TIME_MS
      : Math.min(ENGINE_TIME_MS, options.deadline - now);
  if (remaining <= 0)
    return Promise.reject(
      new AxiError(
        'timed_out',
        'The command reached its deadline before the engine could start.',
      ),
    );
  const limit = Math.max(1, Math.floor(remaining));
  return new Promise((resolve, reject) => {
    const child = spawn(engine, [...args, '--time-limit-ms', String(limit)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      // Only what the engine needs: never the caller's environment.
      env: {
        DOTNET_GCHeapHardLimit: heapLimit().toString(16),
        DOTNET_gcServer: '0',
      },
    });
    const records: EngineRecord[] = [];
    let buffer = '';
    let failure: AxiError | null = null;
    let killed = false;
    const fail = (error: AxiError) => {
      if (!failure) failure = error;
      if (!killed) {
        killed = true;
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      fail(
        new AxiError(
          'timed_out',
          'The engine ran out of time before it finished. Run the command again with more time, or in a worker.',
        ),
      );
    }, limit + 1500);
    const line = (text: string) => {
      if (!text) return;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        fail(
          new AxiError(
            'engine_failed',
            'The engine printed output this tool does not read.',
          ),
        );
        return;
      }
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        typeof (record as EngineRecord).type !== 'string'
      ) {
        fail(
          new AxiError(
            'engine_failed',
            'The engine printed a record this tool does not read.',
          ),
        );
        return;
      }
      const r = record as EngineRecord;
      if (r.p !== PROTOCOL) {
        fail(
          new AxiError(
            'engine_failed',
            'The engine speaks a protocol version this tool does not know. Reinstall cad-axi.',
          ),
        );
        return;
      }
      if (!RECORD_TYPES.has(r.type)) {
        fail(
          new AxiError(
            'engine_failed',
            'The engine printed a record of a kind this tool does not know.',
          ),
        );
        return;
      }
      records.push(r);
      options.onRecord?.(r);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at >= 0 && !failure) {
        if (at > MAX_LINE) {
          fail(
            new AxiError(
              'engine_failed',
              'The engine printed a line longer than this tool reads.',
            ),
          );
          return;
        }
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE)
        fail(
          new AxiError(
            'engine_failed',
            'The engine printed a line longer than this tool reads.',
          ),
        );
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(
        new AxiError(
          'unsupported_platform',
          'The engine could not be started on this machine.',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      if (buffer.trim()) line(buffer.trim());
      const last = records.at(-1);
      if (last?.type === 'error') {
        reject(engineError(last));
        return;
      }
      if (code !== 0 || !last) {
        reject(
          new AxiError(
            'engine_failed',
            'The engine stopped without saying why. This is treated as a bug: report it with a made-up drawing that shows it.',
          ),
        );
        return;
      }
      resolve({ records, last });
    });
  });
}
