import { AppError } from '@/middleware/error-handler.js';
export class InferenceProtocolError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 499 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'InferenceProtocolError';
  }
}

/** Normalize any thrown error into the public inference error contract. */
export function inferenceProtocolError(error: unknown): InferenceProtocolError {
  if (error instanceof InferenceProtocolError) return error;
  if (error instanceof AppError) {
    const status = error.statusCode as InferenceProtocolError['status'];
    return new InferenceProtocolError(status, error.code.toLowerCase(), error.message);
  }
  return new InferenceProtocolError(500, 'internal_error', error instanceof Error ? error.message : 'Internal error');
}
