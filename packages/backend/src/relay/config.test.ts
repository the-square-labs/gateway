import { describe, expect, it } from 'vitest';
import { loadRelayConfig } from './config.js';

describe('loadRelayConfig', () => {
  it('keeps the existing public gRPC port by default', () => {
    expect(loadRelayConfig({ RELAY_DATABASE_URL: 'postgres://relay@postgres/gateway' }).port).toBe(9443);
  });

  it('requires a dedicated relay database URL', () => {
    expect(() => loadRelayConfig({})).toThrow('RELAY_DATABASE_URL is required');
  });

  it('rejects invalid timing configuration', () => {
    expect(() => loadRelayConfig({ RELAY_DATABASE_URL: 'postgres://relay@postgres/gateway', RELAY_PORT: '0' })).toThrow(
      'RELAY_PORT must be a positive integer'
    );
  });
});
