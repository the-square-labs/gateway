import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getResourceScopedIds, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { forceCancelTaskRoute, getTaskRoute, listTasksRoute } from './docker.docs.js';
import { DockerTaskService } from './docker-task.service.js';

export function registerTaskRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Task routes ──────────────────────────────────────────────────────

  // List tasks
  router.openapi({ ...listTasksRoute, middleware: requireScopeBase('docker:tasks') }, async (c) => {
    const service = container.resolve(DockerTaskService);
    const nodeId = c.req.query('nodeId');
    const status = c.req.query('status');
    const type = c.req.query('type');
    const scopes = c.get('effectiveScopes') || [];
    const data = await service.list({
      nodeId,
      status,
      type,
      allowedNodeIds: scopes.includes('docker:tasks') ? undefined : getResourceScopedIds(scopes, 'docker:tasks'),
    });
    return c.json({ data });
  });

  // Get single task
  router.openapi({ ...getTaskRoute, middleware: requireScopeBase('docker:tasks') }, async (c) => {
    const service = container.resolve(DockerTaskService);
    const id = c.req.param('id')!;
    const data = await service.get(id);
    if (!hasScopeForResource(c.get('effectiveScopes') || [], 'docker:tasks', data.nodeId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: docker:tasks:${data.nodeId}`);
    }
    return c.json({ data });
  });

  router.openapi({ ...forceCancelTaskRoute, middleware: requireScopeBase('docker:tasks:manage') }, async (c) => {
    const service = container.resolve(DockerTaskService);
    const id = c.req.param('id')!;
    const task = await service.get(id);
    if (!hasScopeForResource(c.get('effectiveScopes') || [], 'docker:tasks:manage', task.nodeId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: docker:tasks:manage:${task.nodeId}`);
    }
    const data = await service.forceCancel(id);
    return c.json({ data });
  });
}
