import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { AuditExportSchema, exportAuditLogRoute, listAuditLogRoute, listAuditUsersRoute } from './audit.docs.js';
import { AuditService } from './audit.service.js';
import { siemRoutes } from './siem.routes.js';

export const auditRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

auditRoutes.use('*', authMiddleware);

auditRoutes.route('/siem', siemRoutes);

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

auditRoutes.openapi({ ...exportAuditLogRoute, middleware: requireScope('admin:audit') }, async (c) => {
  // LICENSE ENFORCEMENT: The official audit export operation requires Business under the project license/TOS.
  await container.resolve(LicensePolicyService).requireFeature('audit-export');
  const input = AuditExportSchema.parse(await c.req.json());
  const data = await container.resolve(AuditService).getAuditExport({
    actions: input.actions,
    resourceTypes: input.resourceTypes,
    userIds: input.userIds,
    excludedActions: input.excludedActions,
    excludedResourceTypes: input.excludedResourceTypes,
    from: parseDateQuery(input.from),
    to: parseDateQuery(input.to),
  });
  return c.json({ data });
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
