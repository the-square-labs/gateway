import { describe, expect, it, vi } from 'vitest';
import { NODE_METRIC_SUSTAINED_REPORTS, NotificationEvaluatorService } from './notification-evaluator.service.js';

function setup(rule: Record<string, unknown>) {
  const service = new NotificationEvaluatorService({} as any, {} as any, {} as any, {} as any, null, {} as any);
  const internals = service as any;
  internals.getThresholdRules = async () => [
    { id: 'rule-1', category: 'node', operator: '>', thresholdValue: 90, resourceIds: [], ...rule },
  ];
  internals.recordProbeOutcome = async () => undefined;
  const breach = vi.fn(async () => undefined);
  const clear = vi.fn(async () => undefined);
  internals.handleThresholdBreach = breach;
  internals.handleThresholdClear = clear;
  return { service, breach, clear };
}

const report = (cpuPercent: number) => ({
  cpuPercent,
  systemMemoryTotalBytes: 1000,
  systemMemoryUsedBytes: 100,
  diskMounts: [{ mountPoint: '/', usagePercent: 10 }],
});

describe('node metric alerts need a sustained value by default', () => {
  it('a single CPU spike does not fire; consecutive breaching reports do', async () => {
    const t = setup({ metric: 'cpu', durationSeconds: 0 });
    await t.service.evaluateHealthReport('node-1', report(99));
    await t.service.evaluateHealthReport('node-1', report(10));
    expect(t.breach).not.toHaveBeenCalled();
    expect(t.clear).toHaveBeenCalledTimes(1);

    for (let i = 0; i < NODE_METRIC_SUSTAINED_REPORTS; i++) {
      await t.service.evaluateHealthReport('node-1', report(99));
    }
    expect(t.breach).toHaveBeenCalledTimes(1);
  });

  it('keeps a rule with an explicit duration on its own window', async () => {
    const t = setup({ metric: 'cpu', durationSeconds: 60 });
    await t.service.evaluateHealthReport('node-1', report(99));
    expect(t.breach).toHaveBeenCalledTimes(1);
  });
});
