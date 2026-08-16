import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { installDockerRuntimeRoute, preflightDockerRuntimeRoute } from './docker.docs.js';
import { DockerManagementService } from './docker.service.js';

export function registerDockerRuntimeRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi({ ...preflightDockerRuntimeRoute, middleware: requireScope('admin:update') }, async (c) => {
    const status = await container.resolve(DockerManagementService).manageRunsc(c.req.param('nodeId')!, 'preflight');
    return c.json({ data: status });
  });

  router.openapi({ ...installDockerRuntimeRoute, middleware: requireScope('admin:update') }, async (c) => {
    const status = await container.resolve(DockerManagementService).manageRunsc(c.req.param('nodeId')!, 'install');
    return c.json({ data: status });
  });
}
