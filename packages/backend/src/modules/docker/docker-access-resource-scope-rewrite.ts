import { eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  apiTokens,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  permissionGroups,
  users,
} from '@/db/schema/index.js';
import { extractBaseScope } from '@/lib/scopes.js';

const DOCKER_ACCESS_RESOURCE_SCOPE_PREFIXES = ['docker:containers:', 'docker:networks:'] as const;

function isDockerAccessResourceScope(scope: string): boolean {
  return DOCKER_ACCESS_RESOURCE_SCOPE_PREFIXES.some((prefix) => extractBaseScope(scope).startsWith(prefix));
}

export function rewriteDockerResourceScopes(
  scopes: readonly string[],
  fromResourceId: string,
  toResourceId: string | null
): string[] {
  let changed = false;
  const rewritten = scopes.flatMap((scope) => {
    if (!isDockerAccessResourceScope(scope)) return [scope];
    const base = extractBaseScope(scope);
    if (scope !== `${base}:${fromResourceId}`) return [scope];
    changed = true;
    return toResourceId ? [`${base}:${toResourceId}`] : [];
  });
  return changed ? [...new Set(rewritten)].sort() : [...scopes];
}

export async function rewritePersistedDockerResourceScopes(
  tx: DrizzleExecutor,
  fromResourceId: string,
  toResourceId: string | null
): Promise<void> {
  const groupRows = await tx
    .select({ id: permissionGroups.id, scopes: permissionGroups.scopes })
    .from(permissionGroups);
  for (const row of groupRows) {
    const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
    if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
      await tx.update(permissionGroups).set({ scopes, updatedAt: new Date() }).where(eq(permissionGroups.id, row.id));
    }
  }

  const userRows = await tx.select({ id: users.id, scopes: users.additionalScopes }).from(users);
  for (const row of userRows) {
    const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
    if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
      await tx.update(users).set({ additionalScopes: scopes, updatedAt: new Date() }).where(eq(users.id, row.id));
    }
  }

  const tokenRows = await tx.select({ id: apiTokens.id, scopes: apiTokens.scopes }).from(apiTokens);
  for (const row of tokenRows) {
    const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
    if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
      await tx.update(apiTokens).set({ scopes }).where(eq(apiTokens.id, row.id));
    }
  }

  const authorizationRows = await tx
    .select({
      id: oauthAuthorizationCodes.id,
      scopes: oauthAuthorizationCodes.scopes,
      requestedScopes: oauthAuthorizationCodes.requestedScopes,
    })
    .from(oauthAuthorizationCodes);
  for (const row of authorizationRows) {
    const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
    const requestedScopes = rewriteDockerResourceScopes(row.requestedScopes, fromResourceId, toResourceId);
    if (
      scopes.join('\u0000') !== row.scopes.join('\u0000') ||
      requestedScopes.join('\u0000') !== row.requestedScopes.join('\u0000')
    ) {
      await tx
        .update(oauthAuthorizationCodes)
        .set({ scopes, requestedScopes })
        .where(eq(oauthAuthorizationCodes.id, row.id));
    }
  }

  const refreshRows = await tx
    .select({ id: oauthRefreshTokens.id, scopes: oauthRefreshTokens.scopes })
    .from(oauthRefreshTokens);
  for (const row of refreshRows) {
    const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
    if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
      await tx.update(oauthRefreshTokens).set({ scopes }).where(eq(oauthRefreshTokens.id, row.id));
    }
  }

  const accessRows = await tx
    .select({ id: oauthAccessTokens.id, scopes: oauthAccessTokens.scopes })
    .from(oauthAccessTokens);
  for (const row of accessRows) {
    const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
    if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
      await tx.update(oauthAccessTokens).set({ scopes }).where(eq(oauthAccessTokens.id, row.id));
    }
  }
}
