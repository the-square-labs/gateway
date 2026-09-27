import { container } from '@/container.js';
import { hasScopeBase } from '@/lib/permissions.js';
import {
  DockerAvailabilityByResourceQuerySchema,
  DockerAvailabilityDisableInputSchema,
  DockerAvailabilityOperationIdSchema,
  DockerAvailabilityOperationsQuerySchema,
  DockerAvailabilityPolicyIdSchema,
  DockerAvailabilityPolicyInputSchema,
  DockerAvailabilityPolicyUpdateSchema,
  dockerAvailabilityResourceFromQuery,
} from '@/modules/docker/availability/docker-availability.schemas.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import {
  applyAvailabilityPartitionMode,
  withAvailabilityLease,
  withOptionalAvailabilityLease,
  withPreflightAvailabilityLease,
} from '@/modules/docker/availability/docker-availability-lease-view.js';
import type { User } from '@/types.js';
import { pickDefinedArguments } from './ai.docker-tool-access.js';

const POLICY_FIELDS = [
  'mode',
  'desiredReplicaCount',
  'nodeSelectionMode',
  'selectedNodeIds',
  'rolloutPolicy',
  'offlineReplacementGraceSeconds',
  'priorityMode',
  'nodePriority',
  'failbackDelaySeconds',
  'partitionMode',
] as const;
const MANAGE_OPERATIONS = new Set(['enable', 'update', 'disable', 'retry_operation']);

/**
 * Mirrors the Docker Availability routes. Mutations need docker:availability:manage
 * like the route middleware; the service authorizes the workload, candidate
 * nodes and dependencies for every operation.
 */
export async function manageDockerAvailabilityTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  const operation = String(args.operation);
  if (MANAGE_OPERATIONS.has(operation) && !hasScopeBase(user.scopes, 'docker:availability:manage')) {
    throw new Error('PERMISSION_DENIED: Missing required scope docker:availability:manage');
  }
  const service = container.resolve(DockerAvailabilityService);
  switch (operation) {
    case 'preflight':
      return withPreflightAvailabilityLease(await service.preflight(policyInput(args), user.scopes));
    case 'enable': {
      const input = policyInput(args);
      const enabled = await service.enable(input, user.id, user.scopes);
      return withAvailabilityLease(await applyAvailabilityPartitionMode(enabled, input.partitionMode));
    }
    case 'get_by_resource': {
      const resource = (args.resource ?? {}) as Record<string, unknown>;
      const query = DockerAvailabilityByResourceQuerySchema.parse(
        pickDefinedArguments(resource, ['type', 'nodeId', 'containerName', 'deploymentId', 'composeProjectId'])
      );
      return withOptionalAvailabilityLease(
        await service.getByResource(dockerAvailabilityResourceFromQuery(query), user.scopes)
      );
    }
    case 'get':
      return withAvailabilityLease(
        await service.get(DockerAvailabilityPolicyIdSchema.parse(args.policyId), user.scopes)
      );
    case 'list_operations': {
      const query = DockerAvailabilityOperationsQuerySchema.parse(pickDefinedArguments(args, ['page', 'limit']));
      return service.listOperationsPage(
        DockerAvailabilityPolicyIdSchema.parse(args.policyId),
        user.scopes,
        query.page,
        query.limit
      );
    }
    case 'update': {
      const input = DockerAvailabilityPolicyUpdateSchema.parse(pickDefinedArguments(args, POLICY_FIELDS));
      const updated = await service.update(
        DockerAvailabilityPolicyIdSchema.parse(args.policyId),
        input,
        user.id,
        user.scopes
      );
      return withAvailabilityLease(await applyAvailabilityPartitionMode(updated, input.partitionMode));
    }
    case 'disable':
      return withAvailabilityLease(
        await service.disable(
          DockerAvailabilityPolicyIdSchema.parse(args.policyId),
          DockerAvailabilityDisableInputSchema.parse(
            pickDefinedArguments(args, ['survivingPlacementId', 'confirmation'])
          ),
          user.id,
          user.scopes
        )
      );
    case 'retry_operation':
      return service.retryOperation(
        DockerAvailabilityPolicyIdSchema.parse(args.policyId),
        DockerAvailabilityOperationIdSchema.parse(args.operationId),
        user.id,
        user.scopes
      );
    default:
      throw new Error(`Unsupported Docker availability operation: ${operation}`);
  }
}

function policyInput(args: Record<string, unknown>) {
  return DockerAvailabilityPolicyInputSchema.parse({
    resource: args.resource,
    ...pickDefinedArguments(args, POLICY_FIELDS),
  });
}
