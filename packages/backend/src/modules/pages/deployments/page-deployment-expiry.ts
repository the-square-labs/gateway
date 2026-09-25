import { AppError } from '@/middleware/error-handler.js';
import { PAGE_DEPLOYMENT_MAX_EXPIRY_HOURS } from './page-deployment.schemas.js';

/** An expiry closer than this is refused: the upload could not even finish. */
const PAGE_DEPLOYMENT_MIN_EXPIRY_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface PageDeploymentExpiryInput {
  expiresAt?: string | null;
  expiresInHours?: number;
}

/**
 * Resolves the optional expiry of an uploaded Deployment.
 *
 * - `undefined`: nothing was requested (keep the current value; none on create).
 * - `null`: an explicit `expiresAt: null` clears a previously declared expiry.
 * - `Date`: the absolute expiry.
 */
export function resolvePageDeploymentExpiry(
  input: PageDeploymentExpiryInput,
  now: Date = new Date()
): Date | null | undefined {
  const hasAbsolute = input.expiresAt !== undefined;
  const hasRelative = input.expiresInHours !== undefined;
  if (hasAbsolute && hasRelative) {
    throw new AppError(400, 'PAGES_DEPLOYMENT_EXPIRY_AMBIGUOUS', 'Use either expiresAt or expiresInHours, not both');
  }
  if (hasRelative) {
    const hours = input.expiresInHours as number;
    if (!Number.isInteger(hours) || hours < 1 || hours > PAGE_DEPLOYMENT_MAX_EXPIRY_HOURS) {
      throw new AppError(
        400,
        'PAGES_DEPLOYMENT_EXPIRY_INVALID',
        `expiresInHours must be a whole number from 1 to ${PAGE_DEPLOYMENT_MAX_EXPIRY_HOURS}`
      );
    }
    return new Date(now.getTime() + hours * HOUR_MS);
  }
  if (!hasAbsolute) return undefined;
  if (input.expiresAt === null) return null;
  const expiresAt = new Date(input.expiresAt as string);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new AppError(400, 'PAGES_DEPLOYMENT_EXPIRY_INVALID', 'expiresAt must be an ISO 8601 timestamp');
  }
  if (expiresAt.getTime() < now.getTime() + PAGE_DEPLOYMENT_MIN_EXPIRY_MS) {
    throw new AppError(400, 'PAGES_DEPLOYMENT_EXPIRY_INVALID', 'expiresAt must be at least 5 minutes in the future');
  }
  if (expiresAt.getTime() > now.getTime() + PAGE_DEPLOYMENT_MAX_EXPIRY_HOURS * HOUR_MS) {
    throw new AppError(400, 'PAGES_DEPLOYMENT_EXPIRY_INVALID', 'expiresAt must be within one year');
  }
  return expiresAt;
}
