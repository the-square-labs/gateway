import { and, eq, inArray, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuilds, dockerRegistryNodeBindings } from '@/db/schema/index.js';

/** Revoked bindings are kept this long (a reactivated context reuses its row), then deleted. */
const REVOKED_BINDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_BUILD_STATUSES = new Set(['claimed', 'checking_out', 'building', 'scanning', 'pushing']);

/** Active build bindings whose build no longer runs on the bound node. */
export async function abandonedBuildBindings(db: DrizzleClient): Promise<Array<{ id: string; nodeId: string }>> {
  const bindings = await db
    .select({
      id: dockerRegistryNodeBindings.id,
      nodeId: dockerRegistryNodeBindings.nodeId,
      buildId: dockerRegistryNodeBindings.contextId,
    })
    .from(dockerRegistryNodeBindings)
    .where(and(eq(dockerRegistryNodeBindings.contextKind, 'build'), eq(dockerRegistryNodeBindings.status, 'active')));
  if (!bindings.length) return [];
  const buildIds = bindings.map(({ buildId }) => buildId).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const builds = buildIds.length
    ? await db
        .select({ id: dockerBuilds.id, status: dockerBuilds.status, builderNodeId: dockerBuilds.builderNodeId })
        .from(dockerBuilds)
        .where(inArray(dockerBuilds.id, buildIds))
    : [];
  const active = new Map(builds.map((build) => [build.id, build]));
  return bindings.filter((binding) => {
    const build = active.get(binding.buildId);
    return !build || !ACTIVE_BUILD_STATUSES.has(build.status) || build.builderNodeId !== binding.nodeId;
  });
}

/**
 * Every rollout and build binds new rows and nothing deleted revoked ones. Their routes are gone (a revocation that
 * failed is swept by removeOrphanedRelayState), so past the retention they are only history.
 */
export async function purgeRevokedRegistryBindings(db: DrizzleClient, now = Date.now()): Promise<void> {
  await db
    .delete(dockerRegistryNodeBindings)
    .where(
      and(
        eq(dockerRegistryNodeBindings.status, 'revoked'),
        lt(dockerRegistryNodeBindings.updatedAt, new Date(now - REVOKED_BINDING_RETENTION_MS))
      )
    );
}
