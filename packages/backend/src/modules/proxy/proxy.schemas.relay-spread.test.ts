import { describe, expect, it } from 'vitest';
import { CreateProxyHostSchema, UpdateProxyHostSchema } from './proxy.schemas.js';

const base = {
  type: 'proxy' as const,
  nodeId: '11111111-1111-4111-8111-111111111111',
  domainNames: ['app.example.com'],
  upstreamKind: 'manual' as const,
  forwardHost: '127.0.0.1',
  forwardPort: 8080,
};

describe('proxy workload Relay spread schema', () => {
  it('defaults new workloads to the Relay Pool setting', () => {
    expect(CreateProxyHostSchema.parse(base).relaySpreadMode).toBeUndefined();
  });

  it('accepts fixed and all workload overrides within bounds', () => {
    expect(CreateProxyHostSchema.safeParse({ ...base, relaySpreadMode: 'fixed', relaySpreadCount: 10 }).success).toBe(
      true
    );
    expect(CreateProxyHostSchema.safeParse({ ...base, relaySpreadMode: 'all' }).success).toBe(true);
    expect(UpdateProxyHostSchema.safeParse({ relaySpreadMode: 'inherit', relaySpreadCount: null }).success).toBe(true);
  });

  it('rejects missing, unrelated, or out-of-range fixed counts on create', () => {
    expect(CreateProxyHostSchema.safeParse({ ...base, relaySpreadMode: 'fixed' }).success).toBe(false);
    expect(CreateProxyHostSchema.safeParse({ ...base, relaySpreadMode: 'all', relaySpreadCount: 2 }).success).toBe(
      false
    );
    expect(CreateProxyHostSchema.safeParse({ ...base, relaySpreadMode: 'fixed', relaySpreadCount: 65 }).success).toBe(
      false
    );
  });
});
