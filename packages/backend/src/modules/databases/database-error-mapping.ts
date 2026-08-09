import { AppError } from '@/middleware/error-handler.js';

export type DatabaseType = 'postgres' | 'redis' | 'clickhouse';
export type DatabaseOperation = 'connect' | 'query';

const DATABASE_CONNECTIVITY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EPIPE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const POSTGRES_CONNECTIVITY_CODES = new Set(['3D000']);
const POSTGRES_QUERY_CODES = new Set(['22007', '22P02', '42601', '42703', '42883', '42P01']);
const POSTGRES_QUERY_CODE_PREFIXES = ['22', '23'];
const POSTGRES_QUERY_MESSAGE_PATTERNS = [
  /invalid input/i,
  /syntax error/i,
  /violates .* constraint/i,
  /duplicate key/i,
  /null value .* violates/i,
  /does not exist/i,
  /cannot cast/i,
  /malformed/i,
];
const REDIS_QUERY_MESSAGES = [/unknown command/i, /wrong number of arguments/i, /wrongtype/i];
const CLICKHOUSE_AUTH_MESSAGES = [
  /authentication failed/i,
  /required password/i,
  /wrong password/i,
  /user .* not found/i,
];
const CLICKHOUSE_QUERY_MESSAGES = [
  /syntax error/i,
  /unknown (identifier|table|database|function)/i,
  /doesn'?t exist/i,
  /cannot parse/i,
  /type mismatch/i,
  /not enough privileges/i,
  /readonly/i,
];

export function mapDatabaseDriverError(
  error: unknown,
  provider: DatabaseType,
  operation: DatabaseOperation
): AppError | null {
  if (error instanceof AppError) return error;
  if (!(error instanceof Error)) return null;

  const driverError = error as Error & {
    code?: string;
    errno?: string | number;
    severity?: string;
    detail?: string;
    schema?: string;
    table?: string;
    column?: string;
    cause?: unknown;
  };
  const cause =
    driverError.cause instanceof Error
      ? (driverError.cause as Error & { code?: string | number; errno?: string | number })
      : undefined;
  const code =
    driverError.code != null
      ? String(driverError.code)
      : driverError.errno != null
        ? String(driverError.errno)
        : cause?.code != null
          ? String(cause.code)
          : cause?.errno != null
            ? String(cause.errno)
            : undefined;
  const message = driverError.message || `${provider} ${operation} failed`;
  const searchableMessage = cause?.message ? `${message}: ${cause.message}` : message;
  const lowerMessage = searchableMessage.toLowerCase();

  if (
    (provider === 'postgres' &&
      (code === '28P01' ||
        lowerMessage.includes('password authentication failed') ||
        lowerMessage.includes('no pg_hba.conf entry'))) ||
    (provider === 'redis' &&
      (lowerMessage.includes('wrongpass') ||
        lowerMessage.includes('authentication required') ||
        lowerMessage.includes('invalid username-password') ||
        lowerMessage.includes('auth <password> called without any password configured') ||
        lowerMessage.includes('noauth'))) ||
    (provider === 'clickhouse' &&
      (code === '516' || CLICKHOUSE_AUTH_MESSAGES.some((pattern) => pattern.test(searchableMessage))))
  ) {
    return new AppError(401, 'DATABASE_AUTH_FAILED', searchableMessage);
  }

  if (
    DATABASE_CONNECTIVITY_ERROR_CODES.has(code ?? '') ||
    (provider === 'postgres' && POSTGRES_CONNECTIVITY_CODES.has(code ?? '')) ||
    lowerMessage.includes('database does not exist') ||
    lowerMessage.includes('getaddrinfo') ||
    lowerMessage.includes('connect timeout') ||
    lowerMessage.includes('connection terminated unexpectedly') ||
    lowerMessage.includes('server does not support ssl') ||
    lowerMessage.includes('self signed certificate') ||
    lowerMessage.includes('certificate has expired') ||
    lowerMessage.includes('unable to verify the first certificate') ||
    lowerMessage.includes('connection is closed') ||
    lowerMessage.includes('fetch failed')
  ) {
    return new AppError(422, 'DATABASE_CONNECTION_FAILED', searchableMessage);
  }

  if (
    operation === 'query' &&
    ((provider === 'postgres' && POSTGRES_QUERY_CODES.has(code ?? '')) ||
      (provider === 'redis' && REDIS_QUERY_MESSAGES.some((pattern) => pattern.test(searchableMessage))) ||
      (provider === 'clickhouse' && CLICKHOUSE_QUERY_MESSAGES.some((pattern) => pattern.test(searchableMessage))))
  ) {
    return new AppError(400, 'DATABASE_QUERY_FAILED', searchableMessage);
  }

  if (
    operation === 'query' &&
    provider === 'postgres' &&
    ((typeof code === 'string' && POSTGRES_QUERY_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) ||
      ((typeof driverError.severity === 'string' ||
        typeof driverError.detail === 'string' ||
        typeof driverError.schema === 'string' ||
        typeof driverError.table === 'string' ||
        typeof driverError.column === 'string') &&
        POSTGRES_QUERY_MESSAGE_PATTERNS.some((pattern) => pattern.test(searchableMessage))))
  ) {
    return new AppError(400, 'DATABASE_QUERY_FAILED', searchableMessage);
  }

  // Console requests must preserve the driver's actionable error text. The
  // global production handler intentionally hides unknown exceptions, so any
  // remaining query error is normalized here before it reaches that boundary.
  if (operation === 'query') {
    return new AppError(400, 'DATABASE_QUERY_FAILED', searchableMessage);
  }

  return null;
}
