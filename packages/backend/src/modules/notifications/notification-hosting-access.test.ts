import { describe, expect, it } from 'vitest';
import { CreateAlertRuleSchema } from './notification-alert-rule.schemas.js';
import { assertHostingAlertAccess } from './notification-hosting-access.js';

const balance = {
  category: 'hosting_account',
  type: 'threshold',
  metric: 'balance',
  metricTarget: 'USD',
  thresholdValue: 10,
  resourceIds: ['account-1'],
};
describe('hosting alert admission', () => {
  it('requires account visibility and billing access for monetary alerts', () => {
    expect(() => assertHostingAlertAccess(['notifications:manage'], balance)).toThrow();
    expect(() => assertHostingAlertAccess(['integrations:hosting:view'], balance)).toThrow();
    expect(() =>
      assertHostingAlertAccess(['integrations:hosting:view:account-1', 'hosting:billing:view:account-1'], balance)
    ).not.toThrow();
  });
  it('does not let a scoped grant subscribe to every account', () => {
    expect(() =>
      assertHostingAlertAccess(['integrations:hosting:view:account-1', 'hosting:billing:view:account-1'], {
        ...balance,
        resourceIds: [],
      })
    ).toThrow();
  });
  it('validates the merged configuration on update and rejects unsupported events', () => {
    expect(() => assertHostingAlertAccess(['*'], { ...balance, metricTarget: null })).toThrow();
    expect(() => assertHostingAlertAccess(['*'], { ...balance, metric: 'arbitrary' })).toThrow();
    expect(() => assertHostingAlertAccess(['*'], { ...balance, type: 'event', eventPattern: '*' })).toThrow();
    expect(() => assertHostingAlertAccess(['*'], { ...balance, thresholdValue: Infinity })).toThrow();
  });
  it('accepts scoped VM events without billing privileges', () => {
    expect(() =>
      assertHostingAlertAccess(['hosting:resources:view:vm-1'], {
        category: 'hosting_vm',
        type: 'event',
        eventPattern: 'power.stopped',
        resourceIds: ['vm-1'],
      })
    ).not.toThrow();
  });
  it('requires an explicit currency at schema admission', () => {
    expect(CreateAlertRuleSchema.safeParse({ ...balance, name: 'Low balance', operator: '<' }).success).toBe(true);
    expect(
      CreateAlertRuleSchema.safeParse({ ...balance, name: 'Low balance', operator: '<', metricTarget: null }).success
    ).toBe(false);
  });
});
