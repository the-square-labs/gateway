import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  getNotificationDeliveryRoute,
  listNotificationDeliveriesRoute,
  notificationDeliveryStatsRoute,
} from './notification.docs.js';
import { DeliveryListQuerySchema } from './notification-delivery.schemas.js';
import { NotificationDeliveryService } from './notification-delivery.service.js';

export const deliveryRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

deliveryRoutes.use('*', authMiddleware);

function canRevealDeliveryPayloads(c: { get(key: 'effectiveScopes'): string[] | undefined }): boolean {
  return hasScope(c.get('effectiveScopes') ?? [], 'notifications:webhooks:manage');
}

// GET / — list deliveries
deliveryRoutes.openapi(
  {
    ...listNotificationDeliveriesRoute,
    middleware: requireAnyScope('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationDeliveryService);
    const query = DeliveryListQuerySchema.parse(c.req.query());
    const result = await service.list(query, { revealSensitive: canRevealDeliveryPayloads(c) });
    return c.json(result);
  }
);

// GET /stats — delivery stats
deliveryRoutes.openapi(
  {
    ...notificationDeliveryStatsRoute,
    middleware: requireAnyScope('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationDeliveryService);
    const webhookId = c.req.query('webhookId');
    const stats = await service.getStats(webhookId);
    return c.json({ data: stats });
  }
);

// GET /:id — get delivery detail
deliveryRoutes.openapi(
  {
    ...getNotificationDeliveryRoute,
    middleware: requireAnyScope('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationDeliveryService);
    const delivery = await service.getById(c.req.param('id')!, {
      revealSensitive: canRevealDeliveryPayloads(c),
    });
    if (!delivery) throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Not found');
    return c.json({ data: delivery });
  }
);
