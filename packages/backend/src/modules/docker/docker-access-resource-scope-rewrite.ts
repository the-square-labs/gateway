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

const DOCKER_VOLUME_SCOPE_BASES = RESOURCE_SCOPABLE.filter((base) => base.startsWith('docker:volumes:'));

function dockerVolumeScopes(nodeId: string, name: string): string[] {
  return DOCKER_VOLUME_SCOPE_BASES.map((base) => `${base}:${nodeId}/${name}`);
}

/** `scopes` with the grants on volume `name` of `fromNodeId` granted on the same volume of `toNodeId` as well. */
export function copyDockerVolumeScopes(
  scopes: readonly string[],
  fromNodeId: string,
  toNodeId: string,
  name: string
): string[] {
  const from = `${fromNodeId}/${name}`;
  const copies = scopes.flatMap((scope) => {
    const base = extractBaseScope(scope);
    return DOCKER_VOLUME_SCOPE_BASES.includes(base) && scope === `${base}:${from}`
      ? [`${base}:${toNodeId}/${name}`]
      : [];
  });
  return copies.length ? [...new Set([...scopes, ...copies])].sort() : [...scopes];
}

/** `scopes` without the grants on volume `name` of `nodeId`. */
export function dropDockerVolumeScopes(scopes: readonly string[], nodeId: string, name: string): string[] {
  const named = new Set(dockerVolumeScopes(nodeId, name));
  return scopes.filter((scope) => !named.has(scope));
}

/** Grants on a migrated volume also apply to its copy on the target node. */
export async function copyPersistedDockerVolumeScopes(
  tx: DrizzleExecutor,
  fromNodeId: string,
  toNodeId: string,
  name: string
): Promise<void> {
  await rewritePersistedScopes(tx, dockerVolumeScopes(fromNodeId, name), (scopes) =>
    copyDockerVolumeScopes(scopes, fromNodeId, toNodeId, name)
  );
}

/** Drops the grants on a volume a migration removed from its node. */
export async function dropPersistedDockerVolumeScopes(
  tx: DrizzleExecutor,
  nodeId: string,
  name: string
): Promise<void> {
  await rewritePersistedScopes(tx, dockerVolumeScopes(nodeId, name), (scopes) =>
    dropDockerVolumeScopes(scopes, nodeId, name)
  );
}
