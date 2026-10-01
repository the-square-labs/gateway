import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups } from '@/db/schema/index.js';
import { logger } from './logger.js';
import { rewritePersistedScopesNaming } from './persisted-scopes.js';
import {
  canonicalizeScopes,
  getBootstrapBuiltinGroups,
  isRetiredScope,
  isValidInboundScope,
  PLATFORM_HARDENING_GROUP_ADDITIONS,
  RETIRED_SCOPE_REPLACEMENTS,
  SCOPE_CLEANUP_MIGRATION_ADDITIONS,
  withRetiredScopeReplacements,
} from './scopes.js';

/**
 * Upsert the built-in groups (creates on fresh install, syncs scopes on upgrade) and sanitize every group's scopes.
 *
 * Retired scope names a release before v2.11 can read stay in custom groups: an updater that rolls back to that
 * release does not restore the database, and that release drops every scope it does not know from custom groups
 * and rewrites the built-in groups with its own catalog on each start. A built-in group holding a retired name
 * therefore means such a release (or migration 0200 itself) wrote the grants since this release last started, and
 * every stored grant is converted again the way migrations 0197 and 0200 did, restoring what the rollback stripped.
 * Everything runs in one transaction, so that signal is never lost before the conversion committed.
 */
export async function syncPermissionGroupsAtStartup(
  db: DrizzleClient,
  deploymentMode: 'standard' | 'demo'
): Promise<void> {
  const builtinGroups = getBootstrapBuiltinGroups(deploymentMode);
  await db.transaction(async (tx) => {
    const storedBuiltins = await tx
      .select({ scopes: permissionGroups.scopes })
      .from(permissionGroups)
      .where(
        and(
          eq(permissionGroups.isBuiltin, true),
          inArray(
            permissionGroups.name,
            builtinGroups.map((group) => group.name)
          )
        )
      )
      .for('update');
    const writtenByOlderRelease = storedBuiltins.some(
      (group) => Array.isArray(group.scopes) && group.scopes.some((scope) => isRetiredScope(scope))
    );

    // Before the built-in groups are rewritten, so they end up exactly this release's set.
    if (writtenByOlderRelease) {
      const changes = await rewritePersistedScopesNaming(
        tx,
        [...Object.keys(RETIRED_SCOPE_REPLACEMENTS), ...Object.keys(SCOPE_CLEANUP_MIGRATION_ADDITIONS)],
        withRetiredScopeReplacements
      );
      logger.info('Converted permissions written by a release before v2.11', {
        users: changes.userIds.length,
        groups: changes.groupIds.length,
      });
    }

    for (const bg of builtinGroups) {
      await tx
        .insert(permissionGroups)
        .values({
          name: bg.name,
          description: bg.description,
          isBuiltin: true,
          scopes: [...bg.scopes],
        })
        .onConflictDoUpdate({
          target: permissionGroups.name,
          set: { scopes: [...bg.scopes], description: bg.description, isBuiltin: true },
        });
    }

    const groups = await tx.select().from(permissionGroups).orderBy(permissionGroups.id).for('update');
    for (const group of groups) {
      const originalScopes = Array.isArray(group.scopes) ? group.scopes : [];
      const canonicalScopes = sanitizeGroupScopes(originalScopes, writtenByOlderRelease && !group.isBuiltin);
      const originalKey = [...originalScopes].sort().join('\0');
      const canonicalKey = [...canonicalScopes].sort().join('\0');
      if (originalKey === canonicalKey) continue;
      await tx
        .update(permissionGroups)
        .set({ scopes: canonicalScopes, updatedAt: new Date() })
        .where(eq(permissionGroups.id, group.id));
      const removedScopes = originalScopes.filter((scope) => !canonicalScopes.includes(scope));
      logger.info('Sanitized permission group scopes', { groupId: group.id, groupName: group.name, removedScopes });
    }
  });
}

/**
 * A group's scopes on the current catalog, plus the retired names an older release still reads (never granting
 * anything here). `platformHardening` re-applies migration 0197's custom-group additions.
 */
function sanitizeGroupScopes(scopes: readonly string[], platformHardening = false): string[] {
  const hardened = platformHardening
    ? [
        ...scopes,
        ...scopes.flatMap((scope) =>
          Object.hasOwn(PLATFORM_HARDENING_GROUP_ADDITIONS, scope) ? [PLATFORM_HARDENING_GROUP_ADDITIONS[scope]] : []
        ),
      ]
    : scopes;
  const retired = scopes
    .map((scope) => scope.trim())
    .filter((scope) => isRetiredScope(scope) && isValidInboundScope(scope));
  return [...new Set([...canonicalizeScopes(hardened), ...retired])].sort();
}
