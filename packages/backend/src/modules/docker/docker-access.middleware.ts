import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import {
  dockerChildScopeResourceId,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from './docker-access-resource.service.js';

function deny(baseScope: string): never {
  throw new HTTPException(403, { message: `Missing required scope: ${baseScope}` });
}

export function assertDockerResourceScope(
  scopes: string[],
  baseScope: string,
  nodeId: string,
  resourceId: string
): void {
  if (!hasDockerResourceScope(scopes, baseScope, nodeId, resourceId)) deny(baseScope);
}

export function assertDockerNodeScope(scopes: string[], baseScope: string, nodeId: string): void {
  if (
    !hasDockerResourceScope(scopes, baseScope, nodeId, '') &&
    !dockerScopedNodeIds(scopes, [baseScope]).includes(nodeId)
  ) {
    deny(baseScope);
  }
}

export function requireDockerContainerScope(
  baseScope: string,
  identifierParam = 'containerId'
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const nodeId = c.req.param('nodeId');
    const identifier = c.req.param(identifierParam);
    if (!nodeId || !identifier) deny(baseScope);
    if (hasDockerResourceScope(scopes, baseScope, nodeId, '')) {
      await next();
      return;
    }

    const data = await container.resolve(DockerManagementService).inspectContainer(nodeId, identifier);
    const resourceId = String(data?.scopeResourceId ?? '');
    if (!resourceId || !hasDockerResourceScope(scopes, baseScope, nodeId, resourceId)) deny(baseScope);
    await next();
  };
}

export function requireDockerDeploymentScope(baseScope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const nodeId = c.req.param('nodeId');
    const deploymentId = c.req.param('deploymentId');
    if (!nodeId || !deploymentId) deny(baseScope);
    assertDockerResourceScope(scopes, baseScope, nodeId, deploymentId);
    await next();
  };
}

export function filterDockerResourcesForScope<T extends { scopeResourceId?: string | null }>(
  resources: T[],
  scopes: string[],
  baseScope: string,
  nodeId: string
): T[] {
  if (hasDockerResourceScope(scopes, baseScope, nodeId, '')) return resources;
  return resources.filter(
    (resource) =>
      !!resource.scopeResourceId && hasDockerResourceScope(scopes, baseScope, nodeId, resource.scopeResourceId)
  );
}

export function dockerResourceScope(baseScope: string, nodeId: string, resourceId: string): string {
  return `${baseScope}:${dockerChildScopeResourceId(nodeId, resourceId)}`;
}
