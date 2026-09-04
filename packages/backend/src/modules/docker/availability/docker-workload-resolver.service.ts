import { and, eq, ne } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { dockerAvailabilityPlacements, dockerAvailabilityPolicies } from '@/db/schema/index.js';
import type { DockerAvailabilityResource } from './docker-availability.types.js';

type PolicyRow = typeof dockerAvailabilityPolicies.$inferSelect;
type PlacementRow = typeof dockerAvailabilityPlacements.$inferSelect;
type Reader = Pick<DrizzleClient, 'select'> | DrizzleTransaction;

export interface DockerResolvedWorkloadPlacement {
  id: string;
  nodeId: string;
  generation: number;
  serving: boolean;
  actualState: PlacementRow['actualState'];
  dependencyState: PlacementRow['dependencyState'];
  applicationHealth: PlacementRow['applicationHealth'];
  runtimeIdentity: Record<string, unknown>;
}

export interface DockerResolvedWorkload {
  policy: PolicyRow;
  logicalResource: DockerAvailabilityResource;
  managementTarget: {
    nodeId: string;
    resourceId: string;
  };
  placements: DockerResolvedWorkloadPlacement[];
  servingPlacements: DockerResolvedWorkloadPlacement[];
}

export interface DockerResolvedRuntimeOwner {
  workload: DockerResolvedWorkload;
  composeServiceName?: string;
}

export interface DockerResolvedContainerRuntimeTarget {
  workload: DockerResolvedWorkload;
  placementId: string;
  nodeId: string;
  containerId: string;
  containerName?: string;
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^\/+/, '') : '';
}

function dockerIdentifierMatches(candidate: unknown, requested: string): boolean {
  const value = normalized(candidate);
  const identifier = normalized(requested);
  if (!value || !identifier) return false;
  if (value === identifier) return true;
  return identifier.length >= 12 && /^[0-9a-f]+$/i.test(identifier) && value.startsWith(identifier);
}

export function matchRuntimeIdentity(
  runtimeIdentity: Record<string, unknown>,
  identifier: string
): { matches: boolean; composeServiceName?: string } {
  if (
    dockerIdentifierMatches(runtimeIdentity.containerId, identifier) ||
    dockerIdentifierMatches(runtimeIdentity.containerName, identifier)
  ) {
    return { matches: true };
  }

  const slots = runtimeIdentity.slots;
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const matches = Object.values(slots as Record<string, unknown>).some((slot) =>
      dockerIdentifierMatches(slot, identifier)
    );
    if (matches) return { matches: true };
  }

  const containers = Array.isArray(runtimeIdentity.containers)
    ? (runtimeIdentity.containers as Array<Record<string, unknown>>)
    : [];
  const composeContainer = containers.find(
    (container) =>
      dockerIdentifierMatches(container.containerId, identifier) ||
      dockerIdentifierMatches(container.containerName, identifier)
  );
  if (!composeContainer) return { matches: false };
  return {
    matches: true,
    composeServiceName: normalized(composeContainer.serviceName) || undefined,
  };
}

export class DockerWorkloadResolverService {
  constructor(private readonly db: DrizzleClient) {}

  async findPolicy(resource: DockerAvailabilityResource, reader: Reader = this.db): Promise<PolicyRow | null> {
    const directWhere =
      resource.type === 'container'
        ? and(
            eq(dockerAvailabilityPolicies.resourceKind, 'container'),
            eq(dockerAvailabilityPolicies.sourceNodeId, resource.nodeId),
            eq(dockerAvailabilityPolicies.containerName, resource.containerName)
          )
        : resource.type === 'deployment'
          ? eq(dockerAvailabilityPolicies.deploymentId, resource.deploymentId)
          : eq(dockerAvailabilityPolicies.composeProjectId, resource.composeProjectId);
    const [direct] = await reader.select().from(dockerAvailabilityPolicies).where(directWhere).limit(1);
    if (direct || resource.type !== 'container') return direct ?? null;

    return (await this.findRuntimePolicy(resource.nodeId, resource.containerName, reader))?.policy ?? null;
  }

  async resolve(
    resource: DockerAvailabilityResource,
    reader: Reader = this.db
  ): Promise<DockerResolvedWorkload | null> {
    const policy = await this.findPolicy(resource, reader);
    if (!policy || policy.mode === 'single') return null;
    return this.resolvePolicy(policy, reader);
  }

  async findRuntimeOwner(
    nodeId: string,
    identifier: string,
    reader: Reader = this.db
  ): Promise<DockerResolvedRuntimeOwner | null> {
    const matched = await this.findRuntimePolicy(nodeId, identifier, reader);
    if (!matched || matched.policy.mode === 'single') return null;
    return {
      workload: await this.resolvePolicy(matched.policy, reader),
      composeServiceName: matched.composeServiceName,
    };
  }

  async resolveContainerRuntimeTarget(
    nodeId: string,
    identifier: string
  ): Promise<DockerResolvedContainerRuntimeTarget | null> {
    const owner = await this.findRuntimeOwner(nodeId, identifier);
    const workload = owner?.workload ?? (await this.resolve({ type: 'container', nodeId, containerName: identifier }));
    if (!workload || workload.policy.resourceKind !== 'container') return null;
    const logicalRequest =
      identifier === workload.policy.containerName &&
      (nodeId === workload.policy.sourceNodeId || nodeId === workload.policy.originNodeId);
    // The logical URL often shares the original container's physical name.
    // It must follow a serving replica, not pin reads to a failed origin.
    // Explicit physical IDs/names retain their placement selection semantics.
    const requestedPlacements =
      owner && !logicalRequest
        ? workload.placements.filter((placement) => matchRuntimeIdentity(placement.runtimeIdentity, identifier).matches)
        : [];
    const candidates = [
      ...requestedPlacements,
      ...workload.servingPlacements,
      ...workload.placements.filter(
        (placement) =>
          !requestedPlacements.some((requested) => requested.id === placement.id) &&
          !workload.servingPlacements.some((serving) => serving.id === placement.id)
      ),
    ].filter((placement, index, all) => all.findIndex((candidate) => candidate.id === placement.id) === index);
    for (const placement of candidates) {
      const containerId = normalized(placement.runtimeIdentity.containerId);
      const containerName = normalized(placement.runtimeIdentity.containerName);
      if (!containerId && !containerName) continue;
      return {
        workload,
        placementId: placement.id,
        nodeId: placement.nodeId,
        containerId: containerId || containerName,
        containerName: containerName || undefined,
      };
    }
    return null;
  }

  private async findRuntimePolicy(
    nodeId: string,
    identifier: string,
    reader: Reader
  ): Promise<{ policy: PolicyRow; composeServiceName?: string } | null> {
    const rows = await reader
      .select({
        policy: dockerAvailabilityPolicies,
        runtimeIdentity: dockerAvailabilityPlacements.runtimeIdentity,
      })
      .from(dockerAvailabilityPolicies)
      .innerJoin(dockerAvailabilityPlacements, eq(dockerAvailabilityPlacements.policyId, dockerAvailabilityPolicies.id))
      .where(
        and(eq(dockerAvailabilityPlacements.nodeId, nodeId), ne(dockerAvailabilityPlacements.actualState, 'removed'))
      );
    const matched = rows.find(
      ({ policy, runtimeIdentity }) =>
        normalized(policy.containerName) === normalized(identifier) ||
        matchRuntimeIdentity(runtimeIdentity, identifier).matches
    );
    if (!matched) return null;
    const match = matchRuntimeIdentity(matched.runtimeIdentity, identifier);
    return {
      policy: matched.policy,
      composeServiceName: match.composeServiceName,
    };
  }

  private async resolvePolicy(policy: PolicyRow, reader: Reader): Promise<DockerResolvedWorkload> {
    const placements = await reader
      .select()
      .from(dockerAvailabilityPlacements)
      .where(
        and(
          eq(dockerAvailabilityPlacements.policyId, policy.id),
          ne(dockerAvailabilityPlacements.actualState, 'removed')
        )
      );
    const normalizedPlacements = placements.map((placement) => ({
      id: placement.id,
      nodeId: placement.nodeId,
      generation: placement.generation,
      serving: placement.serving,
      actualState: placement.actualState,
      dependencyState: placement.dependencyState,
      applicationHealth: placement.applicationHealth,
      runtimeIdentity: placement.runtimeIdentity,
    }));
    const logicalResource = this.logicalResource(policy);
    return {
      policy,
      logicalResource,
      managementTarget: {
        nodeId: policy.sourceNodeId ?? policy.originNodeId ?? '',
        resourceId:
          policy.resourceKind === 'container'
            ? policy.containerName!
            : policy.resourceKind === 'deployment'
              ? policy.deploymentId!
              : policy.composeProjectId!,
      },
      placements: normalizedPlacements,
      servingPlacements: normalizedPlacements
        .filter((placement) => placement.serving && placement.actualState === 'serving')
        .sort((left, right) => right.generation - left.generation || left.nodeId.localeCompare(right.nodeId)),
    };
  }

  private logicalResource(policy: PolicyRow): DockerAvailabilityResource {
    if (policy.resourceKind === 'container') {
      return {
        type: 'container',
        nodeId: policy.sourceNodeId!,
        containerName: policy.containerName!,
      };
    }
    if (policy.resourceKind === 'deployment') {
      return { type: 'deployment', deploymentId: policy.deploymentId! };
    }
    return { type: 'compose', composeProjectId: policy.composeProjectId! };
  }
}
