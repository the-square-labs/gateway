import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
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

  it('keeps a new Relay as a plain pending node until the supervisor enrolls', async () => {
    const insertedTables: unknown[] = [];
    const insertedValues: unknown[] = [];
    const pendingRelay = { id: 'relay-node-1', type: 'relay', hostname: 'pending', status: 'pending' };
    const db = {
      insert: vi.fn((table) => ({
        values: vi.fn((value) => {
          insertedTables.push(table);
          insertedValues.push(value);
          return { returning: vi.fn(async () => [pendingRelay]) };
        }),
      })),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn(async () => undefined) } as any,
      { getNode: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn(async () => `sha256:${'a'.repeat(64)}`) } as any,
      {} as any
    );
    service.setLicenseQuotaService({ run: vi.fn((_resource, _count, write) => write(db)) } as never);

    await service.create(
      {
        type: 'relay',
        hostname: 'pending',
        displayName: 'EU Relay',
        serviceAddresses: ['relay.example.com'],
        servicePort: 9443,
      },
      'user-1'
    );

    expect(insertedTables).toHaveLength(1);
    expect(insertedValues[0]).toEqual(
      expect.objectContaining({
        type: 'relay',
        status: 'pending',
        serviceAddresses: ['relay.example.com'],
      })
    );
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

  it('persists the canonical address list and synchronizes the legacy address columns', async () => {
    const existing = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: null,
      appearanceColor: null,
      slug: 'edge-local',
      serviceAddresses: ['9.9.9.9'],
      serviceAddress: '9.9.9.9',
      secondaryServiceAddress: null,
      lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['9.9.9.9'] },
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
    const serviceAddresses = ['9.9.9.9', '1.1.1.1', '8.8.8.8'];

    await expect(service.update(existing.id, { serviceAddresses }, 'user-1')).resolves.toMatchObject({
      serviceAddresses,
      serviceAddress: '9.9.9.9',
      secondaryServiceAddress: '1.1.1.1',
    });
    expect(updatedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceAddresses,
        serviceAddress: '9.9.9.9',
        secondaryServiceAddress: '1.1.1.1',
      })
    );
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
      { limit: vi.fn(async () => []) },
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

  it.each([
    'create',
    'install',
    'delete',
  ] as const)('rejects node deletion while a hosting %s operation is active', async (action) => {
    const existing = { id: 'node-1', type: 'docker', hostname: 'worker.local' };
    const active = { id: 'operation-1', action };
    const selections = [{ limit: vi.fn(async () => [existing]) }, { limit: vi.fn(async () => [active]) }];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
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
      code: 'NODE_HOSTING_OPERATION_ACTIVE',
      statusCode: 409,
      details: { hostingOperationId: active.id, action },
    });
    expect(registry.getNode).not.toHaveBeenCalled();
    expect(registry.deregister).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    'confirmed',
    'binding_changed',
    'other_operation',
  ] as const)('permits only transaction-guarded cleanup by the owning destroy worker: %s', async (scenario) => {
    const node = { id: 'node-1', type: 'docker', hostname: 'worker', status: 'offline' };
    const active = { id: 'destroy-1', action: 'delete' };
    const selections = [
      { limit: async () => [node] },
      { limit: async () => [active] },
      Promise.resolve([]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([]),
    ];
    const deleted = vi.fn(async () => {});
    let guarded = false;
    let selected = 0;
    const tx = {
      select: () => {
        expect(guarded).toBe(true);
        return {
          from: () => ({
            where: () => {
              selected += 1;
              if (selected === 1) return { for: async () => [node] };
              if (selected === 2) return Promise.resolve([]);
              return { limit: async () => [active] };
            },
          }),
        };
      },
      delete: () => ({ where: deleted }),
    };
    const db = {
      select: () => ({
        from: () => ({ where: () => selections.shift(), leftJoin: () => ({ where: () => selections.shift() }) }),
      }),
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const guard = vi.fn(async () => {
      guarded = true;
      if (scenario === 'binding_changed') throw new AppError(409, 'HOSTING_NODE_BINDING_CHANGED', 'Binding changed');
    });
    const service = new NodesService(
      db as never,
      { log: vi.fn() } as never,
      { getNode: vi.fn() } as never,
      {} as never,
      {} as never
    );
    const result = service.remove(node.id, 'user', {
      hostingDelete: { operationId: scenario === 'other_operation' ? 'another' : active.id, guard },
    });
    if (scenario === 'confirmed') {
      await result;
      expect(guard).toHaveBeenCalledWith(tx);
      expect(deleted).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toMatchObject({
        code: scenario === 'binding_changed' ? 'HOSTING_NODE_BINDING_CHANGED' : 'NODE_HOSTING_OPERATION_ACTIVE',
      });
      expect(deleted).not.toHaveBeenCalled();
    }
  });

  it.each([
    'online',
    'pending',
  ])('rechecks hosting work and node state under lock before removing an initially %s node', async (status) => {
    const existing = { id: 'node-1', type: 'docker', hostname: 'worker.local', status };
    const active = { id: 'operation-1', action: 'install' };
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      { limit: vi.fn(async () => []) },
      Promise.resolve([]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([]),
    ];
    const commandStream = { end: vi.fn() };
    let transactionSelect = 0;
    const deleteWhere = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
          where: vi.fn(() => selections.shift()),
        })),
      })),
      transaction: vi.fn(async (callback) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => {
                transactionSelect += 1;
                if (transactionSelect === 2) return Promise.resolve([]); // No hosting firewall binding.
                return transactionSelect === 1
                  ? { for: vi.fn(async () => [{ ...existing, status: 'online' }]) }
                  : { limit: vi.fn(async () => [active]) };
              }),
            })),
          })),
          delete: vi.fn(() => ({ where: deleteWhere })),
        })
      ),
    } as any;
    const registry = { getNode: vi.fn(() => ({ commandStream })), deregister: vi.fn() };
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      registry as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.remove(existing.id, 'user-1')).rejects.toMatchObject({
      code: 'NODE_HOSTING_OPERATION_ACTIVE',
      details: { hostingOperationId: active.id, action: 'install' },
    });
    expect(commandStream.end).not.toHaveBeenCalled();
    expect(registry.deregister).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('cascades assigned proxy hosts when an offline Nginx node removal is explicitly confirmed', async () => {
    const existing = { id: 'node-1', type: 'nginx', hostname: 'edge.local' };
    const assignedHosts = [{ id: 'proxy-1' }, { id: 'proxy-2' }];
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      { limit: vi.fn(async () => []) },
      Promise.resolve(assignedHosts),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([]),
    ];
    const nodeDeleteWhere = vi.fn(async () => undefined);
    let transactionSelect = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
          where: vi.fn(() => selections.shift()),
        })),
      })),
      transaction: vi.fn(async (callback) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => {
                transactionSelect += 1;
                if (transactionSelect === 2) return Promise.resolve([]); // No hosting firewall binding.
                return transactionSelect === 1
                  ? { for: vi.fn(async () => [existing]) }
                  : { limit: vi.fn(async () => []) };
              }),
            })),
          })),
          delete: vi.fn(() => ({ where: nodeDeleteWhere })),
        })
      ),
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
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      { limit: vi.fn(async () => []) },
      Promise.resolve([{ id: 'proxy-1' }]),
    ];
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

  it('removes a legacy pending Relay without requiring drain', async () => {
    const existing = {
      id: 'relay-node-1',
      type: 'relay',
      hostname: 'pending',
      status: 'pending',
      certificateSerial: null,
    };
    const relayInstance = {
      id: 'relay-instance-1',
      state: 'joining',
      health: null,
    };
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      { limit: vi.fn(async () => []) },
      { limit: vi.fn(async () => [relayInstance]) },
      Promise.resolve([]),
      Promise.resolve([]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([]),
    ];
    const deletedTables: unknown[] = [];
    let transactionSelect = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => selections.shift()),
          innerJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
          leftJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
        })),
      })),
      transaction: vi.fn(async (callback) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => {
                transactionSelect += 1;
                if (transactionSelect === 2) return Promise.resolve([]); // No hosting firewall binding.
                return transactionSelect === 1
                  ? { for: vi.fn(async () => [existing]) }
                  : { limit: vi.fn(async () => []) };
              }),
            })),
          })),
          delete: vi.fn((table) => {
            deletedTables.push(table);
            return { where: vi.fn(async () => undefined) };
          }),
          update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
        })
      ),
    } as any;
    const auditService = { log: vi.fn(async () => undefined) };
    const service = new NodesService(
      db,
      auditService as any,
      { getNode: vi.fn(() => undefined), deregister: vi.fn() } as any,
      { getGatewayCertSha256: vi.fn() } as any,
      {} as any
    );

    await expect(service.remove(existing.id, 'user-1')).resolves.toBeUndefined();

    expect(deletedTables).toHaveLength(4);
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'node.remove' }));
  });

  it.each(['create', 'install'])('removes a pending node and fences its active hosting %s worker', async (action) => {
    const existing = { id: 'node-1', type: 'docker', hostname: 'pending', status: 'pending' };
    const active = { id: 'operation-1', action };
    const selections = [
      { limit: vi.fn(async () => [existing]) },
      { limit: vi.fn(async () => [active]) },
      Promise.resolve([]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([{ count: 0 }]),
      Promise.resolve([]),
    ];
    let transactionSelect = 0;
    const set = vi.fn((_patch: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ connectorId: 'hosting-1' }]) })),
    }));
    const deleted = vi.fn(async () => undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => selections.shift()),
          leftJoin: vi.fn(() => ({ where: vi.fn(() => selections.shift()) })),
        })),
      })),
      transaction: vi.fn(async (callback) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => {
                ++transactionSelect;
                if (transactionSelect === 2) return Promise.resolve([]); // No hosting firewall binding.
                return transactionSelect === 1
                  ? { for: vi.fn(async () => [existing]) }
                  : { limit: vi.fn(async () => [active]) };
              }),
            })),
          })),
          update: vi.fn(() => ({ set })),
          delete: vi.fn(() => ({ where: deleted })),
        })
      ),
    } as any;
    const service = new NodesService(
      db,
      { log: vi.fn() } as any,
      { getNode: vi.fn(), deregister: vi.fn() } as any,
      {} as any,
      {} as any
    );
    const publish = vi.fn();
    service.setEventBus({ publish } as any);
    await service.remove(existing.id, 'user-1');
    expect(deleted).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'failed',
        errorCode: 'HOSTING_NODE_REMOVED',
        encryptedBootstrap: null,
        bootstrapExpiresAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        generation: expect.anything(),
        completedAt: expect.any(Date),
      })
    );
    expect(set.mock.calls[0][0]).not.toHaveProperty('providerOperation');
    expect(set.mock.calls[0][0]).not.toHaveProperty('dispatchStartedAt');
    expect(publish).toHaveBeenCalledWith('node.changed', { id: existing.id, action: 'deleted' });
    expect(publish).toHaveBeenCalledWith('integration.connector.changed', { id: 'hosting-1', provider: 'hosting' });
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
