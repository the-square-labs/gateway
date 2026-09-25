import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { installDockerRuntimeRoute, preflightDockerRuntimeRoute } from './docker.docs.js';
import { DockerManagementService } from './docker.service.js';

/**
 * Secure runtime setup is control of one node (it restarts that node's Docker daemon), so it needs nodes:manage for
 * the node. Broad admin:update, which used to gate it, keeps working for one release.
 */
export function canManageDockerRuntime(scopes: string[], nodeId: string): boolean {
  return hasScopeForResource(scopes, 'nodes:manage', nodeId) || hasScope(scopes, 'admin:update');
}

const requireDockerRuntimeAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nodeId = c.req.param('nodeId') ?? '';
  if (!nodeId || !canManageDockerRuntime(c.get('effectiveScopes') ?? [], nodeId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: nodes:manage:${nodeId}`);
  }
  await next();
};

export function registerDockerRuntimeRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi({ ...preflightDockerRuntimeRoute, middleware: requireDockerRuntimeAccess }, async (c) => {
    const status = await container.resolve(DockerManagementService).manageRunsc(c.req.param('nodeId')!, 'preflight');
    return c.json({ data: status });
  });

  router.openapi({ ...installDockerRuntimeRoute, middleware: requireDockerRuntimeAccess }, async (c) => {
    const status = await container.resolve(DockerManagementService).manageRunsc(c.req.param('nodeId')!, 'install');
    return c.json({ data: status });
  });
}
