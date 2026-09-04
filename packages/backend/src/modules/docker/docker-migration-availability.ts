import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAvailabilityPlacements, dockerAvailabilityPolicies } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  DockerWorkloadResolverService,
  matchRuntimeIdentity,
} from './availability/docker-workload-resolver.service.js';
import type { DockerMigrationPreflightInput } from './docker-migration.schemas.js';
import type { MigrationRow } from './docker-migration-runtime.js';

export const MIGRATION_AVAILABILITY_ENABLED = 'MIGRATION_AVAILABILITY_ENABLED';

export async function migrationAvailabilityBlocker(
  db: DrizzleClient,
  input: Pick<DockerMigrationPreflightInput, 'sourceNodeId' | 'resource'>
): Promise<{ code: string; message: string } | null> {
  const resource =
    input.resource.type === 'container'
      ? {
          ...input.resource,
          nodeId: input.sourceNodeId,
          containerName: input.resource.containerName.replace(/^\/+/, ''),
        }
      : input.resource;
  const policy = await new DockerWorkloadResolverService(db).findPolicy(resource);
  let managed = policy?.mode === 'replicated' || policy?.mode === 'failover';
  if (!managed) {
    // The shared resolver handles containers, slots and Compose members. Also
    // cover physical deployment IDs and routers, which are not logical IDs.
    const placements = await db
      .select({ runtimeIdentity: dockerAvailabilityPlacements.runtimeIdentity })
      .from(dockerAvailabilityPlacements)
      .innerJoin(dockerAvailabilityPolicies, eq(dockerAvailabilityPolicies.id, dockerAvailabilityPlacements.policyId))
      .where(
        and(
          eq(dockerAvailabilityPlacements.nodeId, input.sourceNodeId),
          ne(dockerAvailabilityPlacements.actualState, 'removed'),
          inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover'])
        )
      );
    managed = placements.some(({ runtimeIdentity }) =>
      resource.type === 'deployment'
        ? runtimeIdentity.deploymentId === resource.deploymentId
        : matchRuntimeIdentity(runtimeIdentity, resource.containerName).matches ||
          String(runtimeIdentity.routerName ?? '').replace(/^\/+/, '') === resource.containerName
    );
  }
  return managed
    ? {
        code: MIGRATION_AVAILABILITY_ENABLED,
        message:
          'Migration is unavailable while replicated or failover Availability is enabled. Disable Availability first.',
      }
    : null;
}

export async function assertMigrationAvailabilityAllowed(db: DrizzleClient, row: MigrationRow): Promise<void> {
  const blocker = await migrationAvailabilityBlocker(db, {
    sourceNodeId: row.sourceNodeId,
    resource:
      row.resourceType === 'container'
        ? { type: 'container', containerName: row.resourceName }
        : { type: 'deployment', deploymentId: row.deploymentId! },
  });
  if (blocker) throw new AppError(409, blocker.code, blocker.message);
}
