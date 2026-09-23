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
 * into the target workload and attaches it to a network, so the caller needs
 * the workload's own scopes and network scopes on the target node, not only
 * access to the database or storage.
 */
export async function assertWorkloadBindingTargetAccess(
  scopes: string[],
  target: WorkloadBindingTarget
): Promise<void> {
  if (target.targetType === 'compose_service') {
    const composeTarget = decodeComposeServiceTarget(target.targetResourceId);
    requireDockerScope(scopes, 'docker:compose:manage', target.targetNodeId, composeTarget.projectId);
  } else if (target.targetType === 'deployment') {
    for (const scope of ['docker:containers:edit', 'docker:containers:manage', 'docker:containers:secrets']) {
      requireDockerScope(scopes, scope, target.targetNodeId, target.targetResourceId);
    }
  } else {
    const targetScopes = ['docker:containers:environment', 'docker:containers:secrets'];
    // Node- or globally-scoped callers do not need to inspect the target, which
    // keeps binding cleanup possible after the workload is gone.
    const canAccessNode = targetScopes.every(
      (scope) => hasScope(scopes, scope) || hasScope(scopes, `${scope}:${target.targetNodeId}`)
    );
    if (!canAccessNode) {
      const inspected = await container
        .resolve(DockerManagementService)
        .inspectContainer(target.targetNodeId, target.targetResourceId);
      if (isGatewayInternalContainer(inspected)) {
        throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
      }
      const resourceId = String(inspected?.scopeResourceId ?? '');
      if (!resourceId) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
      for (const scope of targetScopes) requireDockerScope(scopes, scope, target.targetNodeId, resourceId);
    }
  }
  for (const scope of ['docker:networks:create', 'docker:networks:edit', 'docker:networks:delete']) {
    requireDockerScope(scopes, scope, target.targetNodeId, '');
  }
}
