import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';

/** Scopes that let a caller look at logging resources; any resource or folder variant counts. */
export const LOGGING_VIEW_SCOPE_BASES = [
  'logs:environments:view',
  'logs:schemas:view',
  'logs:tokens:view',
  'logs:read',
] as const;

/** Folder grants that make a logging environment folder visible (and usable as a create destination). */
export const LOGGING_ENVIRONMENT_FOLDER_SCOPE_BASES = [
  'logs:environments:view',
  'logs:environments:edit',
  'logs:environments:delete',
  'logs:environments:create',
  'logs:read',
  'logs:tokens:view',
  'logs:tokens:create',
  'logs:tokens:delete',
] as const;

/** Folder grants that make a logging schema folder visible (and usable as a create destination). */
export const LOGGING_SCHEMA_FOLDER_SCOPE_BASES = [
  'logs:schemas:view',
  'logs:schemas:edit',
  'logs:schemas:delete',
  'logs:schemas:create',
] as const;

/**
 * The logging storage health snapshot (ClickHouse reachability and maintenance state) is shown to
 * anyone who works with logging, not only to housekeeping operators. REST, the dashboard and the
 * `logging.health.changed` channel all use this one rule.
 */
export function hasLoggingHealthAccess(scopes: readonly string[]): boolean {
  const granted = [...scopes];
  return hasScope(granted, 'housekeeping:view') || LOGGING_VIEW_SCOPE_BASES.some((base) => hasScopeBase(granted, base));
}

/**
 * Who may call the environment list. A granted but empty folder, or a creator with nothing visible
 * yet, gets an empty list instead of a refusal. Shared by REST and the AI/MCP tool.
 */
export function hasLoggingEnvironmentListAccess(scopes: readonly string[]): boolean {
  const granted = [...scopes];
  return (
    hasScopeBase(granted, 'logs:environments:view') ||
    hasScopeBase(granted, 'logs:read') ||
    hasScopeBase(granted, 'logs:environments:create') ||
    getFolderScopedIds(granted, LOGGING_ENVIRONMENT_FOLDER_SCOPE_BASES).length > 0
  );
}

/**
 * Environment ids the caller may see, or `undefined` for all. Reading logs needs the environment in
 * the list, so logs:read counts as environment visibility. Folder grants arrive expanded to
 * per-environment grants; the folder ids themselves are not rows.
 */
export function visibleLoggingEnvironmentIds(scopes: readonly string[]): string[] | undefined {
  const granted = [...scopes];
  if (hasScope(granted, 'logs:environments:view') || hasScope(granted, 'logs:read')) return undefined;
  return [
    ...new Set([
      ...getResourceScopedIds(granted, 'logs:environments:view'),
      ...getResourceScopedIds(granted, 'logs:read'),
    ]),
  ];
}

/** Who may call the schema list; see {@link hasLoggingEnvironmentListAccess}. */
export function hasLoggingSchemaListAccess(scopes: readonly string[]): boolean {
  const granted = [...scopes];
  return (
    hasScopeBase(granted, 'logs:schemas:view') ||
    hasScopeBase(granted, 'logs:schemas:create') ||
    getFolderScopedIds(granted, LOGGING_SCHEMA_FOLDER_SCOPE_BASES).length > 0
  );
}

/** Schema ids the caller may see, or `undefined` for all. */
export function visibleLoggingSchemaIds(scopes: readonly string[]): string[] | undefined {
  const granted = [...scopes];
  return hasScope(granted, 'logs:schemas:view') ? undefined : getResourceScopedIds(granted, 'logs:schemas:view');
}

/**
 * Attaching a schema to an environment exposes the schema (name and fields) through that environment,
 * so the caller must be able to view the schema. Keeping the schema an environment already has is
 * always allowed, so editors can save other settings of an environment whose schema they cannot see.
 */
export function canAttachLoggingSchema(
  scopes: readonly string[],
  schemaId: string | null | undefined,
  currentSchemaId?: string | null
): boolean {
  if (!schemaId || schemaId === currentSchemaId) return true;
  return hasScopeForResource([...scopes], 'logs:schemas:view', schemaId);
}
