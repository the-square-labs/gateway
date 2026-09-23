import { container } from '@/container.js';
import { CreateSiemDestinationSchema, UpdateSiemDestinationSchema } from '@/modules/audit/siem.schemas.js';
import { assertHostingAlertAccess } from '@/modules/notifications/notification-hosting-access.js';
import { buildSampleEvent } from '@/modules/notifications/notification-templates.js';
import type { User } from '@/types.js';
import { agentPageLimit } from './ai.service-helpers.js';

export const SIEM_NOTIFICATION_TOOL_NAMES = new Set([
  'list_siem_destinations',
  'get_siem_destination',
  'create_siem_destination',
  'update_siem_destination',
  'delete_siem_destination',
  'test_siem_destination',
  'list_siem_deliveries',
  'get_siem_delivery',
  'requeue_siem_delivery',
]);

export const NOTIFICATION_TOOL_NAMES = new Set([
  'list_alert_rules',
  'get_alert_rule',
  'create_alert_rule',
  'update_alert_rule',
  'delete_alert_rule',
  'list_webhooks',
  'create_webhook',
  'update_webhook',
  'delete_webhook',
  'test_webhook',
  'list_webhook_deliveries',
  'get_delivery_stats',
  ...SIEM_NOTIFICATION_TOOL_NAMES,
]);

export interface NotificationToolContext {
  notifRuleService?: import('@/modules/notifications/notification-alert-rule.service.js').NotificationAlertRuleService;
  notifWebhookService?: import('@/modules/notifications/notification-webhook.service.js').NotificationWebhookService;
  notifDeliveryService?: import('@/modules/notifications/notification-delivery.service.js').NotificationDeliveryService;
  notifDispatcherService?: import('@/modules/notifications/notification-dispatcher.service.js').NotificationDispatcherService;
  siemDestinationService?: import('@/modules/audit/siem-destination.service.js').SiemDestinationService;
  siemDeliveryService?: import('@/modules/audit/siem-delivery.service.js').SiemDeliveryService;
  generalSettingsService?: import('@/modules/settings/general-settings.service.js').GeneralSettingsService;
}

export async function executeNotificationTool(
  context: NotificationToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  if (SIEM_NOTIFICATION_TOOL_NAMES.has(toolName)) {
    try {
      if (!context.generalSettingsService || !(await context.generalSettingsService.isFeatureEnabled('siemEnabled'))) {
        return { error: 'SIEM feature is disabled' };
      }
    } catch {
      return { error: 'SIEM feature is disabled' };
    }
  }

  switch (toolName) {
    case 'list_alert_rules':
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      return context.notifRuleService.list({ page: 1, limit: 100, category: a.category, enabled: a.enabled });
    case 'get_alert_rule':
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      return context.notifRuleService.getById(a.ruleId);
    case 'create_alert_rule': {
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      const input = {
        name: a.name,
        type: a.type,
        category: a.category,
        severity: a.severity,
        metric: a.metric,
        metricTarget: a.metricTarget,
        operator: a.operator,
        thresholdValue: a.thresholdValue,
        durationSeconds: a.durationSeconds ?? 0,
        fireThresholdPercent: a.fireThresholdPercent ?? 100,
        resolveAfterSeconds: a.resolveAfterSeconds ?? 60,
        resolveThresholdPercent: a.resolveThresholdPercent ?? 100,
        eventPattern: a.eventPattern,
        resourceIds: a.resourceIds ?? [],
        messageTemplate: a.messageTemplate,
        webhookIds: a.webhookIds ?? [],
        cooldownSeconds: a.cooldownSeconds ?? 900,
        enabled: a.enabled ?? true,
      };
      // Same source-access rule as the alert rule routes.
      assertHostingAlertAccess(user.scopes, input);
      return context.notifRuleService.create(input, user.id);
    }
    case 'update_alert_rule': {
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      const ruleService = context.notifRuleService;
      const input = Object.fromEntries(
        Object.entries({
          name: a.name,
          enabled: a.enabled,
          severity: a.severity,
          metric: a.metric,
          metricTarget: a.metricTarget,
          operator: a.operator,
          thresholdValue: a.thresholdValue,
          durationSeconds: a.durationSeconds,
          fireThresholdPercent: a.fireThresholdPercent,
          resolveAfterSeconds: a.resolveAfterSeconds,
          resolveThresholdPercent: a.resolveThresholdPercent,
          eventPattern: a.eventPattern,
          resourceIds: a.resourceIds,
          messageTemplate: a.messageTemplate,
          webhookIds: a.webhookIds,
          cooldownSeconds: a.cooldownSeconds,
        }).filter(([, value]) => value !== undefined)
      );
      // Mirrors the update route: the merged rule must stay within the caller's
      // hosting access, hosting rules update behind the evaluator barrier and
      // other rules reconcile firing states.
      const previous = await ruleService.getById(a.ruleId);
      assertHostingAlertAccess(user.scopes, { ...previous, ...input } as Parameters<
        typeof assertHostingAlertAccess
      >[1]);
      const update = () => ruleService.update(a.ruleId, input, user.id);
      const hostingRule = previous.category === 'hosting_account' || previous.category === 'hosting_vm';
      const { NotificationEvaluatorService } = await import(
        '@/modules/notifications/notification-evaluator.service.js'
      );
      const evaluator = container.isRegistered(NotificationEvaluatorService)
        ? container.resolve(NotificationEvaluatorService)
        : null;
      const rule = hostingRule && evaluator ? await evaluator.updateHostingRule(previous, update) : await update();
      if (!hostingRule && evaluator) {
        await evaluator.reconcileRuleUpdate(previous, rule).catch(() => {
          // The periodic sweep retries; the rule update itself already succeeded.
        });
      }
      return rule;
    }
    case 'delete_alert_rule':
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      return context.notifRuleService.delete(a.ruleId, user.id);
    case 'list_webhooks':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.list({ page: 1, limit: 100 });
    case 'create_webhook':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.create(
        {
          name: a.name,
          url: a.url,
          method: a.method ?? 'POST',
          templatePreset: a.templatePreset,
          bodyTemplate: a.bodyTemplate,
          signingSecret: a.signingSecret,
          signingHeader: a.signingHeader ?? 'X-Signature-256',
          enabled: true,
          headers: {},
        },
        user.id
      );
    case 'update_webhook':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.update(
        a.webhookId,
        {
          name: a.name,
          url: a.url,
          method: a.method,
          enabled: a.enabled,
          templatePreset: a.templatePreset,
          bodyTemplate: a.bodyTemplate,
          signingSecret: a.signingSecret,
          signingHeader: a.signingHeader,
        },
        user.id
      );
    case 'delete_webhook':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.delete(a.webhookId, user.id);
    case 'test_webhook': {
      if (!context.notifWebhookService || !context.notifDispatcherService) {
        return { error: 'Notification service not available' };
      }
      const webhook = await context.notifWebhookService.getRaw(a.webhookId);
      return context.notifDispatcherService.dispatch(webhook, buildSampleEvent(), true);
    }
    case 'list_webhook_deliveries':
      if (!context.notifDeliveryService) return { error: 'Notification service not available' };
      return context.notifDeliveryService.list({
        page: 1,
        limit: agentPageLimit(a.limit),
        webhookId: a.webhookId,
        status: a.status,
      });
    case 'get_delivery_stats':
      if (!context.notifDeliveryService) return { error: 'Notification service not available' };
      return context.notifDeliveryService.getStats(a.webhookId);
    case 'list_siem_destinations':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.list({
        page: 1,
        limit: agentPageLimit(a.limit),
        enabled: a.enabled,
        search: a.search,
      });
    case 'get_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.getById(a.destinationId);
    case 'create_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.create(
        CreateSiemDestinationSchema.parse({
          name: a.name,
          url: a.url,
          authType: a.authType,
          ...(a.customHeaderName !== undefined ? { customHeaderName: a.customHeaderName } : {}),
          secret: a.secret,
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        }),
        user.id
      );
    case 'update_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.update(
        a.destinationId,
        UpdateSiemDestinationSchema.parse({
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.url !== undefined ? { url: a.url } : {}),
          ...(a.authType !== undefined ? { authType: a.authType } : {}),
          ...(a.customHeaderName !== undefined ? { customHeaderName: a.customHeaderName } : {}),
          ...(a.secret !== undefined ? { secret: a.secret } : {}),
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        }),
        user.id
      );
    case 'delete_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.delete(a.destinationId, user.id);
    case 'test_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.test(a.destinationId);
    case 'list_siem_deliveries':
      if (!context.siemDeliveryService) return { error: 'SIEM service not available' };
      return context.siemDeliveryService.list({
        page: 1,
        limit: agentPageLimit(a.limit),
        destinationId: a.destinationId,
        status: a.status,
      });
    case 'get_siem_delivery':
      if (!context.siemDeliveryService) return { error: 'SIEM service not available' };
      return context.siemDeliveryService.getById(a.deliveryId);
    case 'requeue_siem_delivery':
      if (!context.siemDeliveryService) return { error: 'SIEM service not available' };
      return context.siemDeliveryService.requeue(a.deliveryId);
    default:
      throw new Error(`Unsupported notification tool: ${toolName}`);
  }
}
