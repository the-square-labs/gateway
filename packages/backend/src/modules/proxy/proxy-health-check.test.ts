import { afterEach, describe, expect, it, vi } from 'vitest';
import { runImmediateProxyHealthCheck } from './proxy-health-check.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runImmediateProxyHealthCheck', () => {
  it('persists and publishes the first health sample after enabling checks', async () => {
    vi.useFakeTimers();
    const host = {
      id: 'host-1',
      domainNames: ['example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthHistory: [],
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: null,
      healthCheckUrl: '/',
      forwardScheme: 'http',
      forwardHost: '127.0.0.1',
      forwardPort: 8080,
      upstreamKind: 'manual',
      secureLinkMigratedAt: null,
      nodeId: null,
    };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
          };
        }),
      })),
    } as any;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue('ok') }));
    const publish = vi.fn();

    runImmediateProxyHealthCheck({
      db,
      hostId: host.id,
      logger: { debug: vi.fn() },
      eventBus: { publish } as any,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.objectContaining({
        healthStatus: 'online',
        lastHealthCheckAt: expect.any(Date),
        healthHistory: [expect.objectContaining({ status: 'online' })],
      })
    );
    expect(publish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: host.id, action: 'health.online', health_status: 'online' })
    );
  });
});
