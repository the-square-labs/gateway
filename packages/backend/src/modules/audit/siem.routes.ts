import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireGatewayFeature } from '@/middleware/feature-flags.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  createSiemDestinationRoute,
  deleteSiemDestinationRoute,
  getSiemDeliveryRoute,
  getSiemDestinationRoute,
  listSiemDeliveriesRoute,
  listSiemDestinationsRoute,
  requeueSiemDeliveryRoute,
  testSiemDestinationRoute,
  updateSiemDestinationRoute,
} from './siem.docs.js';
import {
  CreateSiemDestinationSchema,
  SiemDeliveryListQuerySchema,
  SiemDestinationListQuerySchema,
  UpdateSiemDestinationSchema,
} from './siem.schemas.js';
import { SiemDeliveryService } from './siem-delivery.service.js';
import { SiemDestinationService } from './siem-destination.service.js';

const SIEM_VIEW_SCOPES = ['audit:siem:view', 'audit:siem:manage'] as const;

export const siemRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

siemRoutes.use('*', authMiddleware);
siemRoutes.use('*', requireGatewayFeature('siemEnabled', 'SIEM'));

siemRoutes.openapi({ ...listSiemDestinationsRoute, middleware: requireAnyScope(...SIEM_VIEW_SCOPES) }, async (c) => {
  const service = container.resolve(SiemDestinationService);
  return c.json(await service.list(SiemDestinationListQuerySchema.parse(c.req.query())));
});

siemRoutes.openapi({ ...getSiemDestinationRoute, middleware: requireAnyScope(...SIEM_VIEW_SCOPES) }, async (c) => {
  const service = container.resolve(SiemDestinationService);
  return c.json({ data: await service.getById(c.req.param('id')!) });
});

siemRoutes.openapi({ ...createSiemDestinationRoute, middleware: requireAnyScope('audit:siem:manage') }, async (c) => {
  const service = container.resolve(SiemDestinationService);
  const destination = await service.create(CreateSiemDestinationSchema.parse(await c.req.json()), c.get('user')!.id);
  return c.json({ data: destination }, 201);
});

siemRoutes.openapi({ ...updateSiemDestinationRoute, middleware: requireAnyScope('audit:siem:manage') }, async (c) => {
  const service = container.resolve(SiemDestinationService);
  const destination = await service.update(
    c.req.param('id')!,
    UpdateSiemDestinationSchema.parse(await c.req.json()),
    c.get('user')!.id
  );
  return c.json({ data: destination });
});

siemRoutes.openapi({ ...deleteSiemDestinationRoute, middleware: requireAnyScope('audit:siem:manage') }, async (c) => {
  const service = container.resolve(SiemDestinationService);
  return c.json({ data: await service.delete(c.req.param('id')!, c.get('user')!.id) });
});

siemRoutes.openapi({ ...testSiemDestinationRoute, middleware: requireAnyScope('audit:siem:manage') }, async (c) => {
  const service = container.resolve(SiemDestinationService);
  return c.json({ data: await service.test(c.req.param('id')!) });
});

siemRoutes.openapi({ ...listSiemDeliveriesRoute, middleware: requireAnyScope(...SIEM_VIEW_SCOPES) }, async (c) => {
  const service = container.resolve(SiemDeliveryService);
  return c.json(await service.list(SiemDeliveryListQuerySchema.parse(c.req.query())));
});

siemRoutes.openapi({ ...getSiemDeliveryRoute, middleware: requireAnyScope(...SIEM_VIEW_SCOPES) }, async (c) => {
  const service = container.resolve(SiemDeliveryService);
  const delivery = await service.getById(c.req.param('id')!);
  if (!delivery) throw new AppError(404, 'SIEM_DELIVERY_NOT_FOUND', 'SIEM delivery not found');
  return c.json({ data: delivery });
});

siemRoutes.openapi({ ...requeueSiemDeliveryRoute, middleware: requireAnyScope('audit:siem:manage') }, async (c) => {
  const service = container.resolve(SiemDeliveryService);
  return c.json({ data: await service.requeue(c.req.param('id')!) });
});
