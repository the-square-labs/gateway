import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';

describe('ProxyService create rollback', () => {
  it('removes a partially applied Nginx config before deleting the failed route row', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      nodeId: '22222222-2222-4222-8222-222222222222',
      domainNames: ['failed-create.example.com'],
      upstreamKind: 'manual',
      forwardHost: 'upstream.internal',
      forwardPort: 8080,
      forwardScheme: 'http',
      rawConfigEnabled: false,
      sslEnabled: false,
      accessListId: null,
      healthCheckEnabled: false,
    } as any;
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: host.nodeId, type: 'nginx', serviceCreationLocked: false }]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        }),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([host]) })),
      })),
      delete: vi.fn(() => ({ where: deleteWhere })),
    } as any;
    const service = new ProxyService(db, {} as any, { log: vi.fn() } as any, {} as any, {} as any, {} as any);
    vi.spyOn(service as any, 'buildNginxConfig').mockResolvedValue('server {}');
    vi.spyOn(service as any, 'applyConfigToNode').mockRejectedValue(new Error('post-persist validation failed'));
    const removeConfig = vi.spyOn(service as any, 'removeConfigFromNode').mockResolvedValue(undefined);

    await expect(
      service.createProxyHost(
        {
          type: 'proxy',
          nodeId: host.nodeId,
          domainNames: host.domainNames,
          upstreamKind: 'manual',
          forwardHost: host.forwardHost,
          forwardPort: host.forwardPort,
          forwardScheme: 'http',
          sslEnabled: false,
          sslForced: false,
          http2Support: true,
          websocketSupport: false,
          customHeaders: [],
          cacheEnabled: false,
          rateLimitEnabled: false,
          rateLimitMode: 'inherit',
          customRewrites: [],
          healthCheckEnabled: false,
        },
        '33333333-3333-4333-8333-333333333333'
      )
    ).rejects.toMatchObject({ code: 'NGINX_CONFIG_FAILED' });

    expect(removeConfig).toHaveBeenCalledWith(host.id, host.nodeId);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(removeConfig.mock.invocationCallOrder[0]).toBeLessThan(deleteWhere.mock.invocationCallOrder[0]!);
  });
});
