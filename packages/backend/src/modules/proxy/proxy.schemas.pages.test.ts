import { describe, expect, it } from 'vitest';
import { CreateProxyHostSchema } from './proxy.schemas.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const TAG_ID = '33333333-3333-4333-8333-333333333333';

const base = {
  type: 'proxy' as const,
  nodeId: NODE_ID,
  domainNames: ['docs.example.com'],
  upstreamKind: 'pages' as const,
  pageProjectId: PROJECT_ID,
  pageTagId: TAG_ID,
};

describe('Pages Route input contract', () => {
  it('accepts only a concrete Project and Tag target', () => {
    expect(CreateProxyHostSchema.safeParse(base).success).toBe(true);
    expect(CreateProxyHostSchema.safeParse({ ...base, pageTagId: undefined }).success).toBe(false);
    expect(CreateProxyHostSchema.safeParse({ ...base, pageProjectId: undefined }).success).toBe(false);
  });

  it.each([
    { rawConfigEnabled: true },
    { websocketSupport: true },
  ])('rejects incompatible managed-route settings: %o', (settings) => {
    expect(CreateProxyHostSchema.safeParse({ ...base, ...settings }).success).toBe(false);
  });

  it('accepts health checks and a compatible template for service-level validation', () => {
    expect(
      CreateProxyHostSchema.safeParse({
        ...base,
        healthCheckEnabled: true,
        nginxTemplateId: '44444444-4444-4444-8444-444444444444',
      }).success
    ).toBe(true);
  });
});
