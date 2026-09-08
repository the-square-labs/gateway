import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { ALERT_CATEGORIES } from './notification.constants.js';
import {
  createNotificationAlertRuleRoute,
  deleteNotificationAlertRuleRoute,
  getNotificationAlertRuleRoute,
  listNotificationAlertRulesRoute,
  listNotificationCategoriesRoute,
  updateNotificationAlertRuleRoute,
} from './notification.docs.js';
import {
  AlertRuleListQuerySchema,
  CreateAlertRuleSchema,
  UpdateAlertRuleSchema,
} from './notification-alert-rule.schemas.js';
import { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';
import { assertHostingAlertAccess } from './notification-hosting-access.js';

export const alertRuleRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

alertRuleRoutes.use('*', authMiddleware);

function invalidateCache() {
  try {
    container.resolve(NotificationEvaluatorService).invalidateRuleCache();
  } catch {
    /* not yet registered */
  }
}

function triggerCertificateExpiryEvaluation(rule: { category: string; type: string; metric: string | null }) {
  if (rule.category !== 'certificate' || rule.type !== 'threshold' || rule.metric !== 'days_until_expiry') return;
  try {
    const evaluator = container.resolve(NotificationEvaluatorService);
    void evaluator.evaluateCertificateExpiry().catch(() => {});
  } catch {
    /* not yet registered */
  }
}

function triggerMaintenanceEvaluation(rule: { category: string; type: string; eventPattern: string | null }) {
  if (rule.category !== 'proxy' || rule.type !== 'event' || rule.eventPattern !== 'maintenance.active') return;
  try {
    const evaluator = container.resolve(NotificationEvaluatorService);
    void evaluator.reconcileProxyMaintenance().catch(() => {});
  } catch {
    /* not yet registered */
  }
}

// GET /categories — list alert categories with their metrics, events, and variables
alertRuleRoutes.openapi(
  {
    ...listNotificationCategoriesRoute,
    middleware: requireAnyScope(
      'notifications:alerts:view',
      'notifications:alerts:view',
      'notifications:alerts:create',
      'notifications:alerts:edit',
      'notifications:alerts:delete',
      'notifications:view',
      'notifications:manage'
    ),
  },
  async (c) => {
    return c.json({ data: ALERT_CATEGORIES });
  }
);

// GET / — list alert rules
alertRuleRoutes.openapi(
  {
    ...listNotificationAlertRulesRoute,
    middleware: requireAnyScope(
      'notifications:alerts:view',
      'notifications:alerts:view',
      'notifications:view',
      'notifications:manage'
    ),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const query = AlertRuleListQuerySchema.parse(c.req.query());
    const result = await service.list(query);
    return c.json(result);
  }
);

// GET /:id — get alert rule
alertRuleRoutes.openapi(
  {
    ...getNotificationAlertRuleRoute,
    middleware: requireAnyScope(
      'notifications:alerts:view',
      'notifications:alerts:view',
      'notifications:view',
      'notifications:manage'
    ),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const rule = await service.getById(c.req.param('id')!);
    return c.json({ data: rule });
  }
);

// POST / — create alert rule
alertRuleRoutes.openapi(
  {
    ...createNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:create', 'notifications:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const body = CreateAlertRuleSchema.parse(await c.req.json());
    const user = c.get('user')!;
    assertHostingAlertAccess(c.get('effectiveScopes') ?? user.scopes, body);
    const rule = await service.create(body, user.id);
    invalidateCache();
    triggerCertificateExpiryEvaluation(rule);
    triggerMaintenanceEvaluation(rule);
    return c.json({ data: rule }, 201);
  }
);

// PUT /:id — update alert rule
alertRuleRoutes.openapi(
  {
    ...updateNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:edit', 'notifications:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const body = UpdateAlertRuleSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const previous = await service.getById(c.req.param('id')!);
    assertHostingAlertAccess(c.get('effectiveScopes') ?? user.scopes, { ...previous, ...body });
    const update = () => service.update(c.req.param('id')!, body, user.id);
    const rule =
      previous.category === 'hosting_account' || previous.category === 'hosting_vm'
        ? await container.resolve(NotificationEvaluatorService).updateHostingRule(previous, update)
        : await update();
    invalidateCache();
    triggerCertificateExpiryEvaluation(rule);
    triggerMaintenanceEvaluation(rule);
    return c.json({ data: rule });
  }
);

// DELETE /:id — delete alert rule
alertRuleRoutes.openapi(
  {
    ...deleteNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:delete', 'notifications:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const user = c.get('user')!;
    await service.delete(c.req.param('id')!, user.id);
    invalidateCache();
    return c.body(null, 204);
  }
);
