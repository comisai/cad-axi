// The closed set of error codes (design §8.10). Every error prints `message`,
// `code` and `usage` on stdout; a usage error exits 2 and any other error 1.
// A message never echoes a path, flag or value it was given.

export type ErrorCode =
  | 'usage'
  | 'not_found'
  | 'not_cad'
  | 'encrypted'
  | 'damaged'
  | 'unsupported'
  | 'unsupported_platform'
  | 'too_large'
  | 'units_unknown'
  | 'unknown_layer'
  | 'unknown_block'
  | 'unknown_handle'
  | 'invalid_spec'
  | 'would_lose'
  | 'exists'
  | 'verify_failed'
  | 'timed_out'
  | 'output_too_large'
  | 'engine_failed'
  | 'internal_error';

export type ErrorFields = Record<string, string | number>;

export class AxiError extends Error {
  readonly code: ErrorCode;
  readonly fields: ErrorFields;

  constructor(code: ErrorCode, message: string, fields: ErrorFields = {}) {
    super(message);
    this.name = 'AxiError';
    this.code = code;
    this.fields = fields;
  }

  get exitCode(): 1 | 2 {
    return this.code === 'usage' ? 2 : 1;
  }
}

export const usage = (message: string): AxiError =>
  new AxiError('usage', message);
