import { describe, expect, it, vi } from 'vitest';
import { NotificationAlertRuleService } from './notification-alert-rule.service.js';

function harness(existing: Record<string, unknown> | null = null) {
  const written: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          written.push(values);
          return [{ id: 'rule-1', ...values }];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            written.push(values);
            return [{ ...existing, ...values }];
          },
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (existing ? [existing] : []) }) }) }),
  };
  const service = new NotificationAlertRuleService(db as any, { log: vi.fn() } as any);
  return { service, written };
}

const certificateRule = {
  name: 'Certificate expiry',
  enabled: true,
  type: 'threshold' as const,
  category: 'certificate' as const,
  severity: 'warning' as const,
  metric: 'days_until_expiry',
  operator: '<=' as const,
  thresholdValue: 14,
  durationSeconds: 300,
  fireThresholdPercent: 80,
  resolveAfterSeconds: 60,
  resolveThresholdPercent: 100,
  resourceIds: [],
  webhookIds: [],
  cooldownSeconds: 900,
};

describe('NotificationAlertRuleService once-a-day windows', () => {
  it('drops fire/resolve windows a daily certificate check can never cover (API, AI and MCP defaults)', async () => {
    const { service, written } = harness();

    await service.create(certificateRule, 'user-1');

    expect(written[0]).toMatchObject({
      durationSeconds: 0,
      fireThresholdPercent: 100,
      resolveAfterSeconds: 0,
      resolveThresholdPercent: 100,
    });
  });

  it('normalizes stored windows when a certificate expiry rule is edited', async () => {
    const { service, written } = harness({ id: 'rule-1', ...certificateRule });

    await service.update('rule-1', { resolveAfterSeconds: 3600, thresholdValue: 7 }, 'user-1');

    expect(written[0]).toMatchObject({
      thresholdValue: 7,
      durationSeconds: 0,
      fireThresholdPercent: 100,
      resolveAfterSeconds: 0,
    });
    // Already-normal fields are not rewritten, so the audit trail lists only real changes.
    expect(written[0]).not.toHaveProperty('resolveThresholdPercent');
  });

  it('keeps windows for continuously sampled rules', async () => {
    const { service, written } = harness();

    await service.create({ ...certificateRule, category: 'node', metric: 'cpu' }, 'user-1');

    expect(written[0]).toMatchObject({ durationSeconds: 300, resolveAfterSeconds: 60, fireThresholdPercent: 80 });
  });
});
