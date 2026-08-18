import { z } from '@hono/zod-openapi';
import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';

const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  action: z.union([z.string(), z.array(z.string())]).optional(),
  resourceType: z.union([z.string(), z.array(z.string())]).optional(),
  userId: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  excludeAction: z.union([z.string(), z.array(z.string())]).optional(),
  excludeResourceType: z.union([z.string(), z.array(z.string())]).optional(),
});

export const AuditExportSchema = z.object({
  actions: z.array(z.string()).max(100).optional(),
  resourceTypes: z.array(z.string()).max(100).optional(),
  userIds: z.array(z.string()).max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  excludedActions: z.array(z.string()).max(100).optional(),
  excludedResourceTypes: z.array(z.string()).max(100).optional(),
});

export const listAuditLogRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Audit'],
  summary: 'List audit log entries',
  request: { query: AuditQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listAuditUsersRoute = appRoute({
  method: 'get',
  path: '/users',
  tags: ['Audit'],
  summary: 'List users present in audit log entries',
  responses: okJson(UnknownDataResponseSchema),
});

export const exportAuditLogRoute = appRoute({
  method: 'post',
  path: '/export',
  tags: ['Audit'],
  summary: 'Prepare a filtered audit log export',
  request: jsonBody(AuditExportSchema),
  responses: okJson(UnknownDataResponseSchema),
});
