import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { decodeComposeServiceTarget } from '@/modules/docker/compose/compose-managed-bindings.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { isGatewayInternalContainer } from '@/modules/docker/docker-internal-containers.js';

export interface WorkloadBindingTarget {
  targetNodeId: string;
  targetType: 'container' | 'deployment' | 'compose_service';
  targetResourceId: string;
}

function requireDockerScope(scopes: string[], baseScope: string, nodeId: string, resourceId: string) {
  if (!hasDockerResourceScope(scopes, baseScope, nodeId, resourceId)) {
    const target = resourceId ? `${nodeId}/${resourceId}` : nodeId;
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}:${target}`, {
      requiredScope: `${baseScope}:${target}`,
    });
  }
}

/**
 * Scope-based copy of the managed database/storage binding route check
 * (`assertManagedDatabaseBindingTargetAccess`). A binding writes credentials
 * into the target workload, so every target type has one requirement: environment
 * and secrets on the container or deployment, or docker:compose:manage for a
 * Compose service. No Docker network scopes: the Gateway attaches the managed
 * network itself as part of the binding.
 */
const BINDING_TARGET_SCOPES = ['docker:containers:environment', 'docker:containers:secrets'] as const;
/**
 * Every deployment binding change (link or unlink) attaches or detaches the managed network and rolls the
 * deployment out, which the deployment routes gate on manage (deploy). With `targetEnvironment` it also
 * replaces the deployment's desired environment, which they gate on edit (config).
 */
const DEPLOYMENT_ROLLOUT_SCOPES = ['docker:containers:manage'] as const;
const DEPLOYMENT_CONFIG_SCOPES = ['docker:containers:edit'] as const;

export async function assertWorkloadBindingTargetAccess(
  scopes: string[],
  target: WorkloadBindingTarget & { targetEnvironment?: Record<string, string> },
  /** false for reads such as a credential reveal, which change nothing. */
  options: { rollout?: boolean } = {}
): Promise<void> {
  if (target.targetType === 'compose_service') {
    const composeTarget = decodeComposeServiceTarget(target.targetResourceId);
    requireDockerScope(scopes, 'docker:compose:manage', target.targetNodeId, composeTarget.projectId);
    return;
  }
  if (target.targetType === 'deployment') {
    const required = [
      ...BINDING_TARGET_SCOPES,
      ...(options.rollout === false ? [] : DEPLOYMENT_ROLLOUT_SCOPES),
      ...(target.targetEnvironment === undefined ? [] : DEPLOYMENT_CONFIG_SCOPES),
    ];
    for (const scope of required) {
      requireDockerScope(scopes, scope, target.targetNodeId, target.targetResourceId);
    }
    return;
  }
  // Node- or globally-scoped callers do not need to inspect the target, which
  // keeps binding cleanup possible after the workload is gone.
  const canAccessNode = BINDING_TARGET_SCOPES.every(
    (scope) => hasScope(scopes, scope) || hasScope(scopes, `${scope}:${target.targetNodeId}`)
  );
  if (canAccessNode) return;
  const inspected = await container
    .resolve(DockerManagementService)
    .inspectContainer(target.targetNodeId, target.targetResourceId);
  if (isGatewayInternalContainer(inspected)) {
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  }
  const resourceId = String(inspected?.scopeResourceId ?? '');
  if (!resourceId) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  for (const scope of BINDING_TARGET_SCOPES) requireDockerScope(scopes, scope, target.targetNodeId, resourceId);
}

/**
 * Scope-based copy of `assertManagedDatabaseBindingTargetViewAccess`: reading a
 * binding's runtime needs view access to the target workload.
 */
export async function assertWorkloadBindingTargetViewAccess(
  scopes: string[],
  target: WorkloadBindingTarget
): Promise<void> {
  if (target.targetType === 'compose_service') {
    const composeTarget = decodeComposeServiceTarget(target.targetResourceId);
    requireDockerScope(scopes, 'docker:compose:view', target.targetNodeId, composeTarget.projectId);
    return;
  }
  const scope = 'docker:containers:view';
  if (hasScope(scopes, scope) || hasScope(scopes, `${scope}:${target.targetNodeId}`)) return;
  if (target.targetType === 'deployment') {
    requireDockerScope(scopes, scope, target.targetNodeId, target.targetResourceId);
    return;
  }
  const inspected = await container
    .resolve(DockerManagementService)
    .inspectContainer(target.targetNodeId, target.targetResourceId);
  if (isGatewayInternalContainer(inspected)) {
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  }
  const resourceId = String(inspected?.scopeResourceId ?? '');
  if (!resourceId) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  requireDockerScope(scopes, scope, target.targetNodeId, resourceId);
}
