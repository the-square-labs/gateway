import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { AuditExportSchema, exportAuditLogRoute } from './audit.docs.js';
import { AuditService } from './audit.service.js';
export const auditExportRouteRuntime = {
  OpenAPIHono,
  container,
  authMiddleware,
  requireScope,
  LicensePolicyService,
  AuditService,
  AuditExportSchema,
  exportAuditLogRoute,
};
