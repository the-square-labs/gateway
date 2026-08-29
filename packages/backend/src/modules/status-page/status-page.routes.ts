import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  createStatusPageIncidentRoute,
  createStatusPageIncidentUpdateRoute,
  createStatusPageServiceRoute,
  deleteStatusPageIncidentRoute,
  deleteStatusPageServiceRoute,
  getStatusPagePreviewRoute,
  getStatusPageSettingsRoute,
  listStatusPageIncidentsRoute,
  listStatusPageProxyTemplatesRoute,
  listStatusPageServicesRoute,
  promoteStatusPageIncidentRoute,
  publicStatusPageRoute,
  reorderStatusPageServicesRoute,
  resolveStatusPageIncidentRoute,
  updateStatusPageIncidentRoute,
  updateStatusPageServiceRoute,
  updateStatusPageSettingsRoute,
} from './status-page.docs.js';
import {
  CreateStatusPageIncidentSchema,
  CreateStatusPageIncidentUpdateSchema,
  CreateStatusPageServiceSchema,
  IncidentListQuerySchema,
  ReorderStatusPageServicesSchema,
  StatusPageSettingsSchema,
  UpdateStatusPageIncidentSchema,
  UpdateStatusPageServiceSchema,
} from './status-page.schemas.js';
import { StatusPageService } from './status-page.service.js';

export const statusPageRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
export const publicStatusPageRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

statusPageRoutes.use('*', authMiddleware);

statusPageRoutes.openapi({ ...getStatusPageSettingsRoute, middleware: requireScope('status-page:view') }, async (c) => {
  const service = container.resolve(StatusPageService);
  return c.json({ data: await service.getConfig() });
});

statusPageRoutes.openapi(
  { ...listStatusPageProxyTemplatesRoute, middleware: requireScope('status-page:view') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    return c.json({ data: await service.listProxyTemplates() });
  }
);

statusPageRoutes.openapi(
  { ...updateStatusPageSettingsRoute, middleware: requireScope('status-page:manage') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = StatusPageSettingsSchema.parse(await c.req.json());
    return c.json({ data: await service.updateSettings(input, user.id, c.get('effectiveScopes') || []) });
  }
);

statusPageRoutes.openapi(
  { ...listStatusPageServicesRoute, middleware: requireScope('status-page:view') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    return c.json({ data: await service.listServices() });
  }
);

statusPageRoutes.openapi(
  { ...createStatusPageServiceRoute, middleware: requireScope('status-page:manage') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = CreateStatusPageServiceSchema.parse(await c.req.json());
    return c.json({ data: await service.createService(input, user.id) }, 201);
  }
);

statusPageRoutes.openapi(
  { ...reorderStatusPageServicesRoute, middleware: requireScope('status-page:manage') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = ReorderStatusPageServicesSchema.parse(await c.req.json());
    return c.json({ data: await service.reorderServices(input.serviceIds, user.id) });
  }
);

statusPageRoutes.openapi(
  { ...updateStatusPageServiceRoute, middleware: requireScope('status-page:manage') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = UpdateStatusPageServiceSchema.parse(await c.req.json());
    return c.json({ data: await service.updateService(c.req.param('id')!, input, user.id) });
  }
);

statusPageRoutes.openapi(
  { ...deleteStatusPageServiceRoute, middleware: requireScope('status-page:manage') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    await service.deleteService(c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);

statusPageRoutes.openapi(
  { ...listStatusPageIncidentsRoute, middleware: requireScope('status-page:view') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const query = IncidentListQuerySchema.parse(c.req.query());
    return c.json({ data: await service.listIncidents(query) });
  }
);

statusPageRoutes.openapi(
  { ...createStatusPageIncidentRoute, middleware: requireScope('status-page:incidents:create') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = CreateStatusPageIncidentSchema.parse(await c.req.json());
    return c.json({ data: await service.createManualIncident(input, user.id) }, 201);
  }
);

statusPageRoutes.openapi(
  { ...updateStatusPageIncidentRoute, middleware: requireScope('status-page:incidents:update') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = UpdateStatusPageIncidentSchema.parse(await c.req.json());
    return c.json({ data: await service.updateIncident(c.req.param('id')!, input, user.id) });
  }
);

statusPageRoutes.openapi(
  { ...deleteStatusPageIncidentRoute, middleware: requireScope('status-page:incidents:delete') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    await service.deleteIncident(c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);

statusPageRoutes.openapi(
  { ...resolveStatusPageIncidentRoute, middleware: requireScope('status-page:incidents:resolve') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    return c.json({ data: await service.resolveIncident(c.req.param('id')!, user.id) });
  }
);

statusPageRoutes.openapi(
  { ...promoteStatusPageIncidentRoute, middleware: requireScope('status-page:incidents:create') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    return c.json({ data: await service.promoteIncident(c.req.param('id')!, user.id) });
  }
);

statusPageRoutes.openapi(
  { ...createStatusPageIncidentUpdateRoute, middleware: requireScope('status-page:incidents:update') },
  async (c) => {
    const service = container.resolve(StatusPageService);
    const user = c.get('user')!;
    const input = CreateStatusPageIncidentUpdateSchema.parse(await c.req.json());
    return c.json({ data: await service.createIncidentUpdate(c.req.param('id')!, input, user.id) }, 201);
  }
);

statusPageRoutes.openapi({ ...getStatusPagePreviewRoute, middleware: requireScope('status-page:view') }, async (c) => {
  const service = container.resolve(StatusPageService);
  return c.json({ data: await service.getPreviewDto() });
});

publicStatusPageRoutes.openapi(publicStatusPageRoute, async (c) => {
  const service = container.resolve(StatusPageService);
  if (!(await service.isStatusHost(c.req.header('host')))) {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }
  const dto = await service.getPublicDto();
  if (!dto) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return c.json({ data: dto });
});
