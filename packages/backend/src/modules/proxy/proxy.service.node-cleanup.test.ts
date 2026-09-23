import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';

function manualHost(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'proxy',
    nodeId: 'nginx-node',
    enabled: true,
    isSystem: false,
    systemKind: null,
    domainNames: [`${id}.example.com`],
    upstreamKind: 'manual',
    forwardHost: '10.0.0.2',
    forwardPort: 8080,
    forwardScheme: 'http',
    upstreamIpv6Enabled: false,
    secureLinkGeneration: 0,
    secureLinkMigratedAt: null,
    secureLinkStatus: null,
    sslEnabled: false,
    sslForced: false,
    http2Support: false,
    websocketSupport: false,
    rawConfigEnabled: false,
    rawConfig: null,
    maintenanceEnabled: false,
    accessListId: null,
    advancedConfig: null,
    customHeaders: [],
    customRewrites: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitMode: 'inherit',
    rateLimitOptions: null,
    templateVariables: {},
    nginxTemplateId: null,
    redirectUrl: null,
    redirectStatusCode: 301,
    ...overrides,
  };
}

function selectReturning(...results: unknown[][]) {
  const queue = [...results];
  return vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => queue.shift() ?? [],
      }),
    }),
  }));
}

function makeService(options: {
  hosts: ReturnType<typeof manualHost>[];
  currentHosts?: { id: string }[];
  migrationSource?: boolean;
  applyConfig?: ReturnType<typeof vi.fn>;
}) {
  const byId = new Map(options.hosts.map((host) => [host.id, host]));
  const findMany = vi
    .fn()
    .mockResolvedValueOnce(options.hosts)
    .mockResolvedValueOnce(options.currentHosts ?? options.hosts.map((host) => ({ id: host.id })));
  const db = {
    query: {
      proxyHosts: { findMany, findFirst: vi.fn() },
      accessLists: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: selectReturning(
      [{ type: 'nginx', configVersionHash: 'hash-1' }],
      options.migrationSource ? [{ id: 'domain-1' }] : []
    ),
  } as any;
  // Each host re-read under its lock returns that host (hosts are resynced in order).
  let reads = 0;
  db.query.proxyHosts.findFirst = vi.fn(async () => {
    const host = [...byId.values()][reads % byId.size];
    reads += 1;
    return host ?? null;
  });
  const applyConfig = options.applyConfig ?? vi.fn().mockResolvedValue({ success: true });
  const fullSync = vi.fn().mockResolvedValue({ success: true });
  const nodeDispatch = {
    resolveNodeId: vi.fn(async (nodeId: string) => nodeId),
    applyConfig,
    fullSync,
    isNodeConnected: vi.fn().mockReturnValue(true),
  };
  const service = new ProxyService(
    db,
    { renderForHost: vi.fn(async (config: { id: string }) => `config ${config.id}`) } as any,
    { log: vi.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    nodeDispatch as any,
    { supportsNode: vi.fn().mockResolvedValue(false) } as any,
    undefined,
    {
      getActiveAdditional: vi.fn().mockResolvedValue([]),
      assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
    } as any
  );
  return { service, applyConfig, fullSync };
}

describe('node reconnect stale proxy config cleanup', () => {
  it('removes configs of hosts that no longer serve on the node with the exact configs just applied', async () => {
    const { service, applyConfig, fullSync } = makeService({ hosts: [manualHost('host-a')] });

    await service.resyncAllHostsOnNode('nginx-node');

    expect(applyConfig).toHaveBeenCalledWith('nginx-node', 'host-a', 'config host-a', false, 'user_owned');
    expect(fullSync).toHaveBeenCalledWith(
      'nginx-node',
      [{ hostId: 'host-a', configContent: 'config host-a', configOwnership: 'user_owned' }],
      [],
      '',
      [],
      'hash-1'
    );
    expect(fullSync.mock.invocationCallOrder[0]).toBeGreaterThan(applyConfig.mock.invocationCallOrder[0]!);
  });

  it('removes every proxy-host config from a node that has no enabled hosts left', async () => {
    const { service, fullSync } = makeService({ hosts: [] });

    await service.resyncAllHostsOnNode('nginx-node');

    expect(fullSync).toHaveBeenCalledWith('nginx-node', [], [], '', [], 'hash-1');
  });

  it('keeps existing configs when any host failed to resync', async () => {
    const { service, fullSync } = makeService({
      hosts: [manualHost('host-a')],
      applyConfig: vi.fn().mockResolvedValue({ success: false, error: 'nginx -t failed' }),
    });

    await service.resyncAllHostsOnNode('nginx-node');

    expect(fullSync).not.toHaveBeenCalled();
  });

  it('keeps former-node configs while an ingress migration is still in progress', async () => {
    const { service, fullSync } = makeService({ hosts: [manualHost('host-a')], migrationSource: true });

    await service.resyncAllHostsOnNode('nginx-node');

    expect(fullSync).not.toHaveBeenCalled();
  });

  it('skips cleanup when the enabled host set changed during the resync', async () => {
    const { service, fullSync } = makeService({
      hosts: [manualHost('host-a')],
      currentHosts: [{ id: 'host-a' }, { id: 'host-created-meanwhile' }],
    });

    await service.resyncAllHostsOnNode('nginx-node');

    expect(fullSync).not.toHaveBeenCalled();
  });
});
