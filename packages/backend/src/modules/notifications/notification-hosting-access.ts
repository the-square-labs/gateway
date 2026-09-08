import { AppError } from '@/middleware/error-handler.js';
import { assertHostingScope } from '@/modules/hosting/hosting-permissions.js';
import { ALERT_CATEGORIES } from './notification-catalog.js';

interface HostingRule {
  category: string;
  type: string;
  metric?: string | null;
  metricTarget?: string | null;
  thresholdValue?: number | null;
  eventPattern?: string | null;
  resourceIds: string[] | null;
}

/** Notifications are an administrative delivery surface; creating a rule must not bypass source access. */
export function assertHostingAlertAccess(scopes: string[], rule: HostingRule): void {
  if (rule.category !== 'hosting_account' && rule.category !== 'hosting_vm') return;
  const catalog = ALERT_CATEGORIES.find((category) => category.id === rule.category)!;
  const valid =
    rule.type === 'threshold'
      ? catalog.metrics.some((metric) => metric.id === rule.metric) &&
        /^[A-Z]{3}$/.test(rule.metricTarget ?? '') &&
        Number.isFinite(rule.thresholdValue)
      : catalog.events.some((event) => event.id === rule.eventPattern);
  if (!valid)
    throw new AppError(
      400,
      'INVALID_HOSTING_ALERT',
      'Select a supported hosting event or a monetary metric with an explicit three-letter currency.'
    );
  const ids = rule.resourceIds?.length ? rule.resourceIds : [undefined];
  for (const id of ids) {
    assertHostingScope(
      scopes,
      rule.category === 'hosting_vm' ? 'hosting:resources:view' : 'integrations:hosting:view',
      id
    );
    if (rule.category === 'hosting_account' && rule.type === 'threshold') {
      assertHostingScope(scopes, 'hosting:billing:view', id);
    }
  }
}
