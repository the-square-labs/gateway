import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { listAuditLogRoute, listAuditUsersRoute } from './audit.docs.js';
import { AuditService } from './audit.service.js';

export const auditRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

auditRoutes.use('*', authMiddleware);

auditRoutes.openapi({ ...listAuditUsersRoute, middleware: requireScope('admin:audit') }, async (c) => {
  const auditService = container.resolve(AuditService);
  const data = await auditService.getAuditUsers();
  return c.json({ data });
});

auditRoutes.openapi({ ...listAuditLogRoute, middleware: requireScope('admin:audit') }, async (c) => {
  const auditService = container.resolve(AuditService);
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const actions = getQueryValues(c.req.url, 'action');
  const resourceTypes = getQueryValues(c.req.url, 'resourceType');
  const userIds = getQueryValues(c.req.url, 'userId');
  const excludedActions = getQueryValues(c.req.url, 'excludeAction');
  const excludedResourceTypes = getQueryValues(c.req.url, 'excludeResourceType');
  const from = parseDateQuery(c.req.query('from'));
  const to = parseDateQuery(c.req.query('to'));

  const result = await auditService.getAuditLog({
    actions,
    resourceTypes,
    userIds,
    excludedActions,
    excludedResourceTypes,
    from,
    to,
    page,
    limit: Math.min(limit, 100),
  });

  return c.json(result);
});

function getQueryValues(url: string, key: string): string[] {
  return new URL(url).searchParams
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseDateQuery(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
