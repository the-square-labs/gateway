import type { DrizzleExecutor } from '@/db/client.js';
import { rewritePersistedScopes } from '@/lib/persisted-scopes.js';
import { extractBaseScope, RESOURCE_SCOPABLE } from '@/lib/scopes.js';

const DOCKER_ACCESS_RESOURCE_SCOPE_PREFIXES = ['docker:containers:', 'docker:networks:'] as const;
const DOCKER_ACCESS_RESOURCE_BASES = RESOURCE_SCOPABLE.filter((base) =>
  DOCKER_ACCESS_RESOURCE_SCOPE_PREFIXES.some((prefix) => base.startsWith(prefix))
);

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
  await rewritePersistedScopes(
    tx,
    DOCKER_ACCESS_RESOURCE_BASES.map((base) => `${base}:${fromResourceId}`),
    (scopes) => rewriteDockerResourceScopes(scopes, fromResourceId, toResourceId)
  );
}
