import type { ContainerLinkWorkloadType } from '@/db/schema/container-links.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { decodeComposeServiceTarget } from '@/modules/docker/compose/compose-managed-bindings.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { resolveBindingTargetContainerIdentity } from '@/modules/docker/docker-binding-target-identity.js';

/** One end of a container link: a container (by name), a deployment (by id) or a Compose service (`<project>:<service>`). */
export interface ContainerLinkWorkloadRef {
  nodeId: string;
  type: ContainerLinkWorkloadType;
  resourceId: string;
}

function requireScope(scopes: string[], baseScope: string, nodeId: string, resourceId: string): void {
  if (hasDockerResourceScope(scopes, baseScope, nodeId, resourceId)) return;
  const target = resourceId ? `${nodeId}/${resourceId}` : nodeId;
  throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}:${target}`, {
    requiredScope: `${baseScope}:${target}`,
  });
}

/**
 * Checks Docker scopes on one workload. A node- or globally-scoped caller needs no lookup (a link stays removable after
 * its container is gone); a resource-scoped caller is judged by the container's access identity, a deployment by its
 * id and a Compose service by its project.
 */
async function requireWorkloadScopes(scopes: string[], ref: ContainerLinkWorkloadRef, baseScopes: string[]) {
  if (ref.type === 'compose_service') {
    const { projectId } = decodeComposeServiceTarget(ref.resourceId);
    for (const scope of baseScopes) requireScope(scopes, scope, ref.nodeId, projectId);
    return;
  }
  if (ref.type === 'deployment') {
    for (const scope of baseScopes) requireScope(scopes, scope, ref.nodeId, ref.resourceId);
    return;
  }
  if (baseScopes.every((scope) => hasScope(scopes, scope) || hasScope(scopes, `${scope}:${ref.nodeId}`))) return;
  const resourceId = await resolveBindingTargetContainerIdentity(ref.nodeId, ref.resourceId);
  for (const scope of baseScopes) requireScope(scopes, scope, ref.nodeId, resourceId);
}

/**
 * The consumer of a link is changed by it (a network joins it; variables recreate it): it needs
 * `docker:containers:edit` (a Compose service `docker:compose:manage`), and `docker:containers:environment` when the
 * link sets variables (D11).
 */
export async function assertContainerLinkSourceAccess(
  scopes: string[],
  source: ContainerLinkWorkloadRef,
  options: { environment: boolean }
): Promise<void> {
  if (source.type === 'compose_service') {
    await requireWorkloadScopes(scopes, source, ['docker:compose:manage']);
    return;
  }
  await requireWorkloadScopes(scopes, source, [
    'docker:containers:edit',
    ...(options.environment ? ['docker:containers:environment'] : []),
  ]);
}

/**
 * The target of a link lets another workload reach one of its ports: `docker:containers:link` on a container or
 * deployment, `docker:compose:manage` on a Compose service (D11).
 */
export async function assertContainerLinkTargetAccess(
  scopes: string[],
  target: ContainerLinkWorkloadRef
): Promise<void> {
  await requireWorkloadScopes(scopes, target, [
    target.type === 'compose_service' ? 'docker:compose:manage' : 'docker:containers:link',
  ]);
}

/** Reading a workload's links (outgoing or incoming) and their runtime needs view access to that workload. */
export async function assertContainerLinkViewAccess(scopes: string[], ref: ContainerLinkWorkloadRef): Promise<void> {
  await requireWorkloadScopes(scopes, ref, [
    ref.type === 'compose_service' ? 'docker:compose:view' : 'docker:containers:view',
  ]);
}

/** Viewing one link (or its runtime) needs view access to either of its ends. */
export async function assertContainerLinkEitherEndViewAccess(
  scopes: string[],
  link: { source: ContainerLinkWorkloadRef; target: ContainerLinkWorkloadRef }
): Promise<void> {
  try {
    await assertContainerLinkViewAccess(scopes, link.source);
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
    await assertContainerLinkViewAccess(scopes, link.target);
  }
}
