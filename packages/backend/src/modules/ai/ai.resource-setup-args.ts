import { hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';

// Argument and scope helpers shared by the resource setup AI tools.

export function ensureScope(user: User, scope: string) {
  if (!hasScope(user.scopes, scope)) throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
}

export function ensureResourceScope(user: User, scope: string, resourceId: string) {
  if (!hasScopeForResource(user.scopes, scope, resourceId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}:${resourceId}`);
  }
}

export function ensureAnyScopeBase(user: User, scopes: string[]) {
  if (!scopes.some((scope) => hasScopeBase(user.scopes, scope))) {
    throw new AppError(403, 'FORBIDDEN', `Missing one of required scopes: ${scopes.join(', ')}`);
  }
}

export function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required value is missing');
  return text;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function requiredNumber(value: unknown): number {
  const number = optionalNumber(value);
  if (number === undefined) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required number is missing');
  return number;
}

export function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required boolean is missing');
  return value;
}

export function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required value is missing');
  return value;
}

export function requiredEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `Expected one of: ${values.join(', ')}`);
  }
  return value as T[number];
}
