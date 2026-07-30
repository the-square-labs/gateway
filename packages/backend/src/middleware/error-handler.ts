import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { logger } from '@/lib/logger.js';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { AppEnv } from '@/types.js';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');

  if (err instanceof AppError) {
    if (err.statusCode === 429 && err.details && typeof err.details === 'object') {
      const retryAfterSeconds = (err.details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      if (typeof retryAfterSeconds === 'number') {
        c.header('Retry-After', String(retryAfterSeconds));
      }
    }
    logger.warn('Application error', {
      requestId,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });

    return c.json<ApiError>(
      {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      err.statusCode as 400
    );
  }

  if (err instanceof HTTPException) {
    logger.warn('HTTP exception', {
      requestId,
      status: err.status,
      message: err.message,
    });

    return c.json<ApiError>(
      {
        code: 'HTTP_ERROR',
        message: err.message,
      },
      err.status
    );
  }

  if (err instanceof InferenceProtocolError) {
    logger.warn('Inference application error', {
      requestId,
      code: err.code,
      message: err.message,
      statusCode: err.status,
    });
    return c.json<ApiError>(
      {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      err.status as 400
    );
  }

  if (err instanceof ZodError) {
    logger.warn('Validation error', {
      requestId,
      errors: err.errors,
    });

    return c.json<ApiError>(
      {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
      400
    );
  }

  logger.error('Unhandled error', {
    requestId,
    error:
      err instanceof Error
        ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          }
        : err,
  });

  const isProduction = process.env.NODE_ENV === 'production';

  return c.json<ApiError>(
    {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : err instanceof Error ? err.message : 'Unknown error',
    },
    500
  );
};
