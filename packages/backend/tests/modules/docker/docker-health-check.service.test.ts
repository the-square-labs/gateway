import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/middleware/error-handler.js';
import { healthAction, normalizePath, parseDispatchResult } from '@/modules/docker/docker-health-check.helpers.js';
import { DockerHealthCheckService } from '@/modules/docker/docker-health-check.service.js';

const HEALTH_INPUT = {
  enabled: true,
  scheme: 'http' as const,
  hostPort: 8080,
  containerPort: 80,
  path: '/',
  statusMin: 200,
  statusMax: 399,
  expectedBody: null,
  bodyMatchMode: 'includes' as const,
  intervalSeconds: 30,
  timeoutSeconds: 5,
  slowThreshold: 1000,
};

describe('DockerHealthCheckService', () => {
  it('rejects deployment health updates when the deployment is not on the requested node', async () => {
    const findDeployment = vi.fn().mockResolvedValue(null);
    const service = new DockerHealthCheckService(
      {
        query: {
          dockerDeployments: {
            findFirst: findDeployment,
          },
        },
      } as never,
      {} as never
    );

    await expect(
      service.upsertDeployment('node-a', '11111111-1111-4111-8111-111111111111', HEALTH_INPUT)
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'NOT_FOUND',
      statusCode: 404,
    } satisfies Partial<AppError>);

    expect(findDeployment).toHaveBeenCalledOnce();
  });

  it('limits stateful notification samples from Docker health checks to health events', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const observeStatefulEvent = vi.fn().mockResolvedValue(undefined);
    const service = new DockerHealthCheckService({ update } as never, {} as never);
    service.setEvaluator({ observeStatefulEvent } as never);
    (service as unknown as { probeRow: () => Promise<unknown> }).probeRow = vi
      .fn()
      .mockResolvedValue({ status: 'online', responseMs: 4 });

    await (service as unknown as { checkAndStore: (row: unknown) => Promise<void> }).checkAndStore({
      id: 'check-1',
      target: 'container',
      nodeId: 'node-1',
      containerName: 'api',
      deploymentId: null,
      healthStatus: 'offline',
      healthHistory: [],
    });

    expect(observeStatefulEvent).toHaveBeenCalledWith(
      'container',
      'health.online',
      { type: 'docker_container', id: 'api', name: 'api' },
      { health_status: 'online', nodeId: 'node-1', resource_type: 'docker_container' },
      ['health.online', 'health.degraded', 'health.offline']
    );
  });
});

describe('Docker health-check product helpers', () => {
  it.each([
    ['online', 'health.online'],
    ['degraded', 'health.degraded'],
    ['offline', 'health.offline'],
    ['unknown', 'health.unknown'],
    ['disabled', 'health.unknown'],
  ] as const)('maps %s status to %s notification action', (status, action) => {
    expect(healthAction(status)).toBe(action);
  });

  it.each([
    ['', '/'],
    ['   ', '/'],
    ['health', '/health'],
    ['/ready', '/ready'],
    ['  live  ', '/live'],
  ])('normalizes health endpoint %j to %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it('preserves successful daemon payloads and fails closed on daemon errors', () => {
    expect(parseDispatchResult({ success: true, detail: '{"ok":true}' })).toEqual({ ok: true });
    expect(parseDispatchResult({ success: true })).toBeNull();
    expect(() => parseDispatchResult({ success: false, error: 'probe unavailable' })).toThrowError(
      expect.objectContaining({ code: 'DISPATCH_ERROR', statusCode: 502, message: 'probe unavailable' })
    );
  });
});
