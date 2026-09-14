import { AppError } from '@/middleware/error-handler.js';

export type ObjectStorageOperation = 'connect' | 'object';

/**
 * Errors a managed cluster produces while it is still coming up: the daemon
 * has published the port but the server behind it is not accepting requests
 * yet. Distinguished from the rest because they are worth retrying, whereas a
 * bad certificate or a refused credential will fail identically forever.
 */
const WARMUP_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

export function isStorageWarmupError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && WARMUP_ERROR_CODES.has(code);
}

const CONNECTIVITY_ERROR_CODES = new Set([
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
  'NetworkingError',
  'TimeoutError',
]);

const AUTH_ERROR_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'InvalidToken',
  'ExpiredToken',
  'AccountProblem',
]);

const NOT_FOUND_NAMES = new Set(['NoSuchBucket', 'NoSuchKey', 'NotFound']);

interface AwsLikeError extends Error {
  code?: string;
  name: string;
  $metadata?: { httpStatusCode?: number };
}

/**
 * Map an AWS SDK / networking error to an AppError. Returns null when the caller
 * should keep its own generic handling.
 */
export function mapObjectStorageError(error: unknown, operation: ObjectStorageOperation): AppError | null {
  if (error instanceof AppError) return error;
  if (!(error instanceof Error)) return null;

  const err = error as AwsLikeError;
  const name = err.name || '';
  const code = typeof err.code === 'string' ? err.code : '';
  const message = err.message || `object storage ${operation} failed`;
  const lower = message.toLowerCase();

  if (AUTH_ERROR_NAMES.has(name) || lower.includes('access denied') || lower.includes('signature')) {
    return new AppError(401, 'STORAGE_AUTH_FAILED', message);
  }

  if (NOT_FOUND_NAMES.has(name) || lower.includes('does not exist')) {
    return new AppError(404, 'STORAGE_NOT_FOUND', message);
  }

  if (
    CONNECTIVITY_ERROR_CODES.has(code) ||
    CONNECTIVITY_ERROR_CODES.has(name) ||
    lower.includes('getaddrinfo') ||
    lower.includes('connect timeout') ||
    lower.includes('socket hang up') ||
    lower.includes('self signed certificate') ||
    lower.includes('unable to verify the first certificate')
  ) {
    return new AppError(422, 'STORAGE_CONNECTION_FAILED', message);
  }

  return null;
}
