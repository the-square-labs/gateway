const FULL_SECRET_PATTERNS = [/\bgwi_[A-Za-z0-9._~-]+\b/g, /\bgwo_[A-Za-z0-9._~-]+\b/g, /\bgwr_[A-Za-z0-9._~-]+\b/g];

const PREFIXED_SECRET_PATTERNS = [
  /("?(?:access|refresh)?_?token"?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
  /(authorization\s*:\s*bearer\s+)[^\s,"'}]+/gi,
];

export function redactText(value: string): string {
  const withoutTokens = FULL_SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[REDACTED]'),
    value
  );
  return PREFIXED_SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '$1[REDACTED]'), withoutTokens);
}

const SECRET_KEYS = new Set(['token', 'access_token', 'refresh_token', 'accessToken', 'refreshToken', 'code_verifier']);

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEYS.has(key) ? '[REDACTED]' : key === 'prefix' ? child : redactValue(child),
      ])
    );
  }
  return value;
}

export class CliError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, options: { details?: unknown; exitCode?: number; cause?: unknown } = {}) {
    super(redactText(message), { cause: options.cause });
    this.name = 'CliError';
    this.code = code;
    this.details = redactValue(options.details);
    this.exitCode = options.exitCode ?? 1;
  }
}

export function errorPayload(error: unknown): {
  ok: false;
  error: { code: string; message: string; details?: unknown };
} {
  if (error instanceof CliError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'UNEXPECTED_ERROR', message: redactText(message) } };
}
