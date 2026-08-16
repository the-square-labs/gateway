import { AppError } from '@/middleware/error-handler.js';
import { LicenseServerRequestError } from './license.service.js';

export function toLicenseAppError(error: unknown): AppError | null {
  if (!(error instanceof LicenseServerRequestError)) return null;
  const statusCode = error.status === 429 ? 429 : error.status >= 500 ? 502 : error.status === 400 ? 400 : 409;
  return new AppError(statusCode, error.code, error.message, error.details);
}
