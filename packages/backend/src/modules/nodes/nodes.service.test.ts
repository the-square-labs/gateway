import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { NodesService } from './nodes.service.js';

describe('NodesService enrollment token creation', () => {
  function createService(options?: {
    gatewayGrpcPublicTarget?: string | null;
    gatewayGrpcLocalIp?: string | null;
    grpcPort?: number;
  }) {
    const insertedValues = vi.fn();
    const node = { id: 'node-1', type: 'docker', hostname: 'node.local', status: 'pending' };
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value) => {
          insertedValues(value);
          return {
            returning: vi.fn(async () => [node]),
          };
        }),
      })),
    } as any;
    const auditService = { log: vi.fn(async () => undefined) } as any;
    const registry = { getNode: vi.fn() } as any;
    const grpcIdentityService = {
      getGatewayCertSha256: vi.fn(
        async () => 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      ),
    } as any;
    const nodeDispatch = {} as any;
    const service = new NodesService(db, auditService, registry, grpcIdentityService, nodeDispatch);
    service.setLicenseQuotaService({ run: vi.fn((_resource, _count, write) => write(db)) } as never);
    if (options) {
      service.setGeneralSettingsService(
        {
          getGatewayEndpointSettings: vi.fn(async () => ({
            gatewayGrpcPublicTarget: options.gatewayGrpcPublicTarget ?? null,
            gatewayGrpcLocalIp: options.gatewayGrpcLocalIp ?? null,
          })),
        } as any,
        options.grpcPort ?? 9443
      );
    }
    return { service, insertedValues, grpcIdentityService };
  }

  it('returns a v2 enrollment token and persists its selector with the hashed token', async () => {
    const { service, insertedValues } = createService();

    const result = await service.create({ type: 'docker', hostname: 'node.local' }, 'user-1');

    expect(result.enrollmentToken).toMatch(/^gw_node_v2_[0-9a-f]{16}_[0-9a-f]{48}$/);
    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'docker',
        hostname: 'node.local',
        slug: 'node-local',
        enrollmentTokenSelector: result.enrollmentToken.split('_')[3],
        status: 'pending',
      })
    );

    const persistedHash = insertedValues.mock.calls[0]?.[0]?.enrollmentTokenHash;
    expect(await bcrypt.compare(result.enrollmentToken, persistedHash)).toBe(true);
    expect(result.gatewayCertSha256).toBe('sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  it('keeps the slug when an appearance save repeats the current display name', async () => {
    const existing = {
      id: 'node-1',
      type: 'docker',
      hostname: 'node.local',
      displayName: 'Primary node',
      appearanceColor: null,
      slug: 'primary-node-2',
    };
    const updatedValues = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [existing]) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values) => {
          updatedValues(values);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...existing, ...values }]),
            })),
          };
        }),
      })),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn(async () => undefined) } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    const result = await service.update(
      existing.id,
      { displayName: existing.displayName, appearanceColor: 'blue' },
      'user-1'
    );

    expect(updatedValues).toHaveBeenCalledWith(expect.not.objectContaining({ slug: expect.anything() }));
    expect(result.slug).toBe(existing.slug);
  });

  it('rejects hostname and private Nginx service addresses', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddress: null,
      lastHealthReport: {
        localIpAddresses: ['192.168.1.20'],
        publicIpAddresses: ['8.8.8.8', '1.1.1.1'],
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [existing]) })),
        })),
      })),
      update: vi.fn(),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.update(existing.id, { serviceAddress: 'edge.example.com' }, 'user-1')).rejects.toMatchObject({
      code: 'INVALID_NGINX_SERVICE_ADDRESS',
    });
    await expect(service.update(existing.id, { serviceAddress: '192.168.1.20' }, 'user-1')).rejects.toMatchObject({
      code: 'INVALID_NGINX_SERVICE_ADDRESS',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('accepts a custom publicly routable Nginx service address', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddress: null,
      lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['8.8.8.8'] },
    };
    let selection = 0;
    const updatedValues = vi.fn((values) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...existing, ...values }]) })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selection += 1;
            return selection === 1 ? { limit: vi.fn(async () => [existing]) } : Promise.resolve([]);
          }),
        })),
      })),
      update: vi.fn(() => ({ set: updatedValues })),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.update(existing.id, { serviceAddress: '9.9.9.9' }, 'user-1')).resolves.toMatchObject({
      serviceAddress: '9.9.9.9',
    });
    expect(updatedValues).toHaveBeenCalledWith(expect.objectContaining({ serviceAddress: '9.9.9.9' }));
  });

  it('rejects a secondary Nginx address that matches the effective primary address', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddress: null,
      secondaryServiceAddress: null,
      lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['1.1.1.1', '8.8.8.8'] },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [existing]) })) })),
      })),
      update: vi.fn(),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.update(existing.id, { secondaryServiceAddress: '1.1.1.1' }, 'user-1')).rejects.toMatchObject({
      code: 'DUPLICATE_NGINX_SERVICE_ADDRESSES',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('adds a secondary Nginx address without retargeting domains that still use the primary', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddress: '1.1.1.1',
      secondaryServiceAddress: null,
      lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['1.1.1.1', '8.8.8.8'] },
    };
    let selection = 0;
    const updatedValues = vi.fn((values) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...existing, ...values }]) })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selection += 1;
            return selection === 1
              ? { limit: vi.fn(async () => [existing]) }
              : Promise.resolve([{ id: 'domain-1', dnsTargetIps: ['1.1.1.1'] }]);
          }),
        })),
      })),
      update: vi.fn(() => ({ set: updatedValues })),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.update(existing.id, { secondaryServiceAddress: '8.8.8.8' }, 'user-1')).resolves.toMatchObject({
      secondaryServiceAddress: '8.8.8.8',
    });
    expect(updatedValues).toHaveBeenCalledWith(expect.objectContaining({ secondaryServiceAddress: '8.8.8.8' }));
  });

  it('requires confirmation before changing DNS targets for domains assigned to an Nginx node', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddress: '8.8.8.8',
      lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['8.8.8.8', '1.1.1.1'] },
    };
    let selection = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selection += 1;
            return selection === 1
              ? { limit: vi.fn(async () => [existing]) }
              : Promise.resolve([{ id: 'domain-1', domain: 'app.example.com', dnsTargetIps: ['8.8.8.8'] }]);
          }),
        })),
      })),
      update: vi.fn(),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.update(existing.id, { serviceAddress: '1.1.1.1' }, 'user-1')).rejects.toMatchObject({
      code: 'NODE_SERVICE_ADDRESS_DOMAINS_AFFECTED',
      details: { domainCount: 1, previousAddress: '8.8.8.8', nextAddress: '1.1.1.1' },
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('updates the Nginx address and durable domain target intent in one transaction', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddress: '8.8.8.8',
      lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['8.8.8.8', '1.1.1.1'] },
    };
    let selection = 0;
    const nodeSet = vi.fn((values) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...existing, ...values }]) })),
    }));
    const domainSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    let updateCall = 0;
    const tx = {
      update: vi.fn(() => ({ set: ++updateCall === 1 ? nodeSet : domainSet })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selection += 1;
            return selection === 1
              ? { limit: vi.fn(async () => [existing]) }
              : Promise.resolve([{ id: 'domain-1', domain: 'app.example.com', dnsTargetIps: ['8.8.8.8'] }]);
          }),
        })),
      })),
      update: vi.fn(),
      transaction: vi.fn(async (write) => write(tx)),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(
      service.update(existing.id, { serviceAddress: '1.1.1.1', confirmDomainDnsUpdate: true }, 'user-1')
    ).resolves.toMatchObject({ serviceAddress: '1.1.1.1' });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(nodeSet).toHaveBeenCalledWith(expect.objectContaining({ serviceAddress: '1.1.1.1' }));
    expect(domainSet).toHaveBeenCalledWith(expect.objectContaining({ pendingDnsTargetIp: '1.1.1.1' }));
  });

  it('blocks deletion of a node with assigned domains before disconnecting it', async () => {
    const existing = { id: 'node-1', type: 'nginx', hostname: 'edge.local' };
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      Promise.resolve([]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ id: 'domain-1', domain: 'app.example.com' }]),
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
          where: vi.fn(() => selections.shift()),
        })),
      })),
      transaction: vi.fn(),
    } as any;
    const registry = { getNode: vi.fn(), deregister: vi.fn() };
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      registry as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.remove(existing.id, 'user-1')).rejects.toMatchObject({
      code: 'NODE_HAS_DOMAINS',
      statusCode: 409,
      details: { domainCount: 1 },
    });
    expect(registry.getNode).not.toHaveBeenCalled();
    expect(registry.deregister).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('cascades assigned proxy hosts when an offline Nginx node removal is explicitly confirmed', async () => {
    const existing = { id: 'node-1', type: 'nginx', hostname: 'edge.local' };
    const assignedHosts = [{ id: 'proxy-1' }, { id: 'proxy-2' }];
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      Promise.resolve(assignedHosts),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([]),
    ];
    const nodeDeleteWhere = vi.fn(async () => undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
          where: vi.fn(() => selections.shift()),
        })),
      })),
      transaction: vi.fn(async (callback) => callback({ delete: vi.fn(() => ({ where: nodeDeleteWhere })) })),
    } as any;
    const auditService = { log: vi.fn(async () => undefined) };
    const registry = { getNode: vi.fn(() => undefined), deregister: vi.fn() };
    const proxyService = { deleteProxyHost: vi.fn(async () => undefined) };
    const service = new NodesService(
      db,
      auditService as any,
      registry as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );
    service.setProxyService(proxyService as any);

    await service.remove(existing.id, 'user-1', { cascadeOfflineProxyHosts: true });

    expect(proxyService.deleteProxyHost).toHaveBeenCalledTimes(2);
    expect(proxyService.deleteProxyHost).toHaveBeenNthCalledWith(1, 'proxy-1', 'user-1', {
      abandonOfflineNode: true,
    });
    expect(proxyService.deleteProxyHost).toHaveBeenNthCalledWith(2, 'proxy-2', 'user-1', {
      abandonOfflineNode: true,
    });
    expect(nodeDeleteWhere).toHaveBeenCalledOnce();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'node.remove',
        details: expect.objectContaining({ cascadedProxyHostCount: 2 }),
      })
    );
  });

  it('does not cascade proxy hosts while the Nginx node is connected', async () => {
    const existing = { id: 'node-1', type: 'nginx', hostname: 'edge.local' };
    const selections = [{ limit: vi.fn(async () => [existing]) }, Promise.resolve([{ id: 'proxy-1' }])];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
      })),
    } as any;
    const proxyService = { deleteProxyHost: vi.fn() };
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn(() => ({ commandStream: { end: vi.fn() } })) } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );
    service.setProxyService(proxyService as any);

    await expect(service.remove(existing.id, 'user-1', { cascadeOfflineProxyHosts: true })).rejects.toMatchObject({
      code: 'NODE_CONNECTED',
      statusCode: 409,
    });
    expect(proxyService.deleteProxyHost).not.toHaveBeenCalled();
  });

  it('returns only the public enrollment target when local gRPC IP is not configured', async () => {
    const { service } = createService({
      gatewayGrpcPublicTarget: 'gateway.example.com:9443',
      gatewayGrpcLocalIp: null,
    });

    const result = await service.create({ type: 'docker', hostname: 'node.local' }, 'user-1');

    expect(result.gatewayEnrollmentTargets).toEqual({
      public: { label: 'Public node', gateway: 'gateway.example.com:9443' },
    });
  });

  it('returns local and public enrollment targets when local gRPC IP is configured', async () => {
    const { service } = createService({
      gatewayGrpcPublicTarget: 'gateway.example.com',
      gatewayGrpcLocalIp: '10.0.0.5',
      grpcPort: 9443,
    });

    const result = await service.create({ type: 'docker', hostname: 'node.local' }, 'user-1');

    expect(result.gatewayEnrollmentTargets).toEqual({
      public: { label: 'Public node', gateway: 'gateway.example.com:9443' },
      local: { label: 'Local node', gateway: '10.0.0.5:9443' },
    });
  });
});
