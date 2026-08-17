import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/middleware/error-handler.js';
import { probeDnsRecords } from './dns.utils.js';
import { DomainsService, selectBackfillNginxNode } from './domain.service.js';

vi.mock('@/db/schema/proxy-hosts.js', () => ({
  proxyHosts: {
    id: 'proxyHosts.id',
    slug: 'proxyHosts.slug',
    domainNames: 'proxyHosts.domainNames',
    enabled: 'proxyHosts.enabled',
    nodeId: 'proxyHosts.nodeId',
    upstreamKind: 'proxyHosts.upstreamKind',
  },
}));

vi.mock('@/db/schema/ssl-certificates.js', () => ({
  sslCertificates: {
    id: 'sslCertificates.id',
    domainNames: 'sslCertificates.domainNames',
    status: 'sslCertificates.status',
    notAfter: 'sslCertificates.notAfter',
  },
}));

vi.mock('./dns.utils.js', () => ({
  computeDnsStatus: vi.fn(() => 'unknown'),
  getPublicIPs: vi.fn(() => ({ ipv4: [], ipv6: [] })),
  probeDnsRecords: vi.fn(),
  resolveDnsRecords: vi.fn(),
}));

function createInsertDb(row: Record<string, unknown>) {
  const values = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([row]),
  }));
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values })),
    values,
  };
}

function createConflictDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: vi.fn(),
  };
}

function createService(db: Record<string, unknown>, records: Array<Record<string, unknown>>) {
  const service = new DomainsService(db as never, { log: vi.fn() } as never);
  const client = {
    listDnsRecords: vi.fn().mockResolvedValue(records),
    createDnsRecord: vi.fn(async (_zoneId: string, record: Record<string, unknown>) => ({
      id: `record-${record.type}`,
      ...record,
    })),
    deleteDnsRecord: vi.fn(),
  };
  service.setIntegrationsService({
    resolveCloudflareDnsContext: vi.fn().mockResolvedValue({
      connector: { id: 'connector-1' },
      zone: { remoteId: 'zone-1', name: 'example.com' },
      settings: { defaultTtl: 1, defaultProxied: true },
      client,
    }),
  } as never);
  vi.spyOn(service, 'getNginxNodeOptions').mockResolvedValue({
    eligibleNodes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'edge-1',
        hostname: 'edge-1',
        displayName: 'Edge 1',
        appearanceColor: null,
        effectiveAddress: '8.8.8.8',
        effectiveAddresses: ['8.8.8.8'],
      },
    ],
    unconfiguredNodes: [],
    totalNginxNodes: 1,
    unconfiguredNginxNodes: 0,
  });
  return { service, client };
}

describe('DomainsService Cloudflare lifecycle', () => {
  beforeEach(() => {
    vi.mocked(probeDnsRecords).mockResolvedValue({
      queryName: 'app.example.com',
      addressResolution: 'resolved',
      records: { a: ['8.8.8.8'], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    });
  });
  it('chooses a stable backfill node only when proxy-host affinity is unambiguous', () => {
    const eligible = [
      {
        id: 'node-1',
        slug: 'edge-1',
        hostname: 'edge-1',
        displayName: null,
        appearanceColor: null,
        effectiveAddress: '1.1.1.1',
      },
      {
        id: 'node-2',
        slug: 'edge-2',
        hostname: 'edge-2',
        displayName: null,
        appearanceColor: null,
        effectiveAddress: '8.8.8.8',
      },
    ];

    expect(selectBackfillNginxNode(eligible, [])?.id).toBe('node-1');
    expect(selectBackfillNginxNode(eligible, ['node-2', 'node-2'])?.id).toBe('node-2');
    expect(selectBackfillNginxNode(eligible, ['node-1', 'node-2'])).toBeUndefined();
    expect(selectBackfillNginxNode(eligible, ['node-3'])).toBeUndefined();
    expect(selectBackfillNginxNode(eligible, [null])).toBeUndefined();
  });

  it('moves linked proxy hosts with the source config preserved until DNS cutover', async () => {
    const sourceNode = {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'source',
      hostname: 'source',
      displayName: null,
      appearanceColor: null,
      effectiveAddress: '8.8.8.8',
    };
    const targetNode = {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'target',
      hostname: 'target',
      displayName: null,
      appearanceColor: null,
      effectiveAddress: '1.1.1.1',
    };
    const domain = {
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      nginxNodeId: sourceNode.id,
      dnsTargetIps: ['8.8.8.8'],
      ingressMigrationId: null,
    };
    const host = {
      id: 'host-1',
      slug: 'app-example-com',
      domainNames: ['app.example.com'],
      enabled: true,
      nodeId: sourceNode.id,
    };
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ ...domain, nginxNodeId: targetNode.id }]) })),
      })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const proxyService = { updateProxyHost: vi.fn() };
    service.setProxyService(proxyService as never);
    const impact = {
      root: domain,
      sourceNode,
      targetNode,
      domains: [domain],
      proxyHosts: [host],
      pending: false,
      migrationId: null,
    };
    vi.spyOn(service as any, 'buildIngressMigrationImpact')
      .mockResolvedValueOnce(impact)
      .mockResolvedValueOnce({ ...impact, pending: true, migrationId: 'migration-1' });
    vi.spyOn(service as any, 'reconcileDomainTarget').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'completeIngressMigration').mockResolvedValue({ status: 'completed' });

    await service.migrateIngress(domain.id, { targetNodeId: targetNode.id }, 'user-1');

    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(
      host.id,
      { nodeId: targetNode.id },
      'user-1',
      expect.objectContaining({
        skipDomainNodeValidation: true,
        preserveFormerNodeConfig: true,
        allowSystemNodeMove: true,
      })
    );
  });

  it('keeps a prepared external-DNS migration pending until DNS reaches the target', async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
      select: vi.fn(),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const proxyService = { cleanupMigratedHostSource: vi.fn() };
    service.setProxyService(proxyService as never);
    const impact = {
      root: { id: 'domain-1' },
      sourceNode: { id: 'node-source' },
      targetNode: { id: 'node-target', effectiveAddress: '1.1.1.1' },
      domains: [{ id: 'domain-1', domain: 'app.example.com', dnsProvider: 'legacy', dnsStatus: 'pending' }],
      proxyHosts: [{ id: 'host-1', slug: 'app', domainNames: ['app.example.com'], enabled: true }],
      pending: true,
      migrationId: 'migration-1',
    };
    vi.spyOn(service as any, 'refreshExternalMigrationDns').mockResolvedValue({
      ...impact.domains[0],
      dnsStatus: 'invalid',
    });

    const result = await (service as any).completeIngressMigration(impact, 'user-1');

    expect(result.status).toBe('waiting_dns');
    expect(proxyService.cleanupMigratedHostSource).not.toHaveBeenCalled();
  });

  it('assigns legacy domains without inventing a managed DNS target', async () => {
    const legacyDomain = {
      id: 'domain-1',
      domain: 'legacy.example.com',
      dnsProvider: 'legacy',
      nginxNodeId: null,
      pendingDnsTargetIp: null,
    };
    const updateSet = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...legacyDomain, ...values }]) })),
    }));
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([legacyDomain]) })) })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    vi.spyOn(service, 'getNginxNodeOptions').mockResolvedValue({
      eligibleNodes: [
        {
          id: 'node-1',
          slug: 'edge-1',
          hostname: 'edge-1',
          displayName: null,
          appearanceColor: null,
          effectiveAddress: '1.1.1.1',
          effectiveAddresses: ['1.1.1.1'],
        },
      ],
      unconfiguredNodes: [],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 0,
    });
    vi.spyOn(service, 'getUsage').mockResolvedValue({ proxyHosts: [], sslCertificates: [] });
    const reconcile = vi.spyOn(service as any, 'reconcileDomainTarget').mockResolvedValue(undefined);

    await (service as any).backfillNginxNodeAssignments();

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ nginxNodeId: 'node-1', pendingDnsTargetIp: null })
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('distinguishes missing Nginx nodes from nodes without public addresses', async () => {
    const { service } = createService({}, []);
    vi.mocked(service.getNginxNodeOptions).mockResolvedValueOnce({
      eligibleNodes: [],
      unconfiguredNodes: [],
      totalNginxNodes: 0,
      unconfiguredNginxNodes: 0,
    });
    await expect(service.previewDomain({ domain: 'app.example.com' })).rejects.toMatchObject({
      code: 'DOMAIN_NGINX_NODE_MISSING',
    });

    vi.mocked(service.getNginxNodeOptions).mockResolvedValueOnce({
      eligibleNodes: [],
      unconfiguredNodes: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 'private-edge',
          hostname: 'private-edge',
          displayName: null,
          appearanceColor: null,
        },
      ],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 1,
    });
    await expect(service.previewDomain({ domain: 'app.example.com' })).rejects.toMatchObject({
      code: 'DOMAIN_NGINX_ADDRESS_REQUIRED',
    });
  });

  it('requires an explicit node when several eligible Nginx nodes exist', async () => {
    const { service } = createService({}, []);
    const eligibleNodes = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'edge-1',
        hostname: 'edge-1',
        displayName: null,
        appearanceColor: null,
        effectiveAddress: '8.8.8.8',
        effectiveAddresses: ['8.8.8.8'],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'edge-2',
        hostname: 'edge-2',
        displayName: null,
        appearanceColor: null,
        effectiveAddress: '1.1.1.1',
        effectiveAddresses: ['1.1.1.1'],
      },
    ];
    vi.mocked(service.getNginxNodeOptions).mockResolvedValue({
      eligibleNodes,
      unconfiguredNodes: [],
      totalNginxNodes: 2,
      unconfiguredNginxNodes: 0,
    });

    await expect(service.previewDomain({ domain: 'app.example.com' })).rejects.toMatchObject({
      code: 'DOMAIN_NGINX_NODE_REQUIRED',
    });
    await expect(
      service.previewDomain({ domain: 'app.example.com', nginxNodeId: eligibleNodes[1]!.id })
    ).resolves.toMatchObject({ targetIps: ['1.1.1.1'], nginxNode: { id: eligibleNodes[1]!.id } });
  });

  it('reconciles only tracked Cloudflare address records and preserves unrelated record types', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const service = new DomainsService(db as never, audit as never);
    const client = {
      listDnsRecords: vi.fn().mockResolvedValue([
        { id: 'tracked-a', type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 1, proxied: true },
        { id: 'tracked-aaaa', type: 'AAAA', name: 'app.example.com', content: '2606:4700::1', ttl: 1 },
        { id: 'unrelated-txt', type: 'TXT', name: 'app.example.com', content: 'verify=1', ttl: 1 },
      ]),
      updateDnsRecord: vi.fn().mockResolvedValue(undefined),
      deleteDnsRecord: vi.fn().mockResolvedValue(undefined),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await (service as any).reconcileDomainTarget(
      {
        id: 'domain-1',
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['tracked-a', 'tracked-aaaa'],
        dnsTargetIps: ['8.8.8.8'],
        dnsTtl: 1,
        dnsProxied: true,
        nginxNodeId: 'node-1',
        pendingDnsTargetIp: '1.1.1.1',
      },
      '1.1.1.1'
    );

    expect(client.updateDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'tracked-a',
      expect.objectContaining({ type: 'A', content: '1.1.1.1', proxied: true })
    );
    expect(client.deleteDnsRecord).toHaveBeenCalledWith('zone-1', 'tracked-aaaa');
    expect(client.deleteDnsRecord).not.toHaveBeenCalledWith('zone-1', 'unrelated-txt');
    expect(writes).toContainEqual(
      expect.objectContaining({ providerRecordIds: ['tracked-a'], dnsTargetIps: ['1.1.1.1'], dnsStatus: 'valid' })
    );
  });

  it('preserves two tracked Cloudflare targets when both are requested', async () => {
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const client = {
      listDnsRecords: vi.fn().mockResolvedValue([
        { id: 'tracked-a-1', type: 'A', name: 'app.example.com', content: '1.1.1.1', ttl: 1 },
        { id: 'tracked-a-2', type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 1 },
      ]),
      createDnsRecord: vi.fn(),
      updateDnsRecord: vi.fn(),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await (service as any).reconcileDomainTarget(
      {
        id: 'domain-1',
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['tracked-a-1', 'tracked-a-2'],
        dnsRecordType: 'A',
        dnsTargetIps: ['1.1.1.1', '8.8.8.8'],
        dnsStatus: 'valid',
        dnsTtl: 1,
        dnsProxied: false,
        nginxNodeId: 'node-1',
        pendingDnsTargetIp: null,
      },
      ['1.1.1.1', '8.8.8.8']
    );

    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.updateDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('refuses every untracked Cloudflare address record before mutating DNS', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const client = {
      listDnsRecords: vi.fn().mockResolvedValue([
        { id: 'tracked-a', type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 1 },
        { id: 'untracked-a', type: 'A', name: 'app.example.com', content: '9.9.9.9', ttl: 1 },
      ]),
      createDnsRecord: vi.fn(),
      updateDnsRecord: vi.fn(),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await (service as any).reconcileDomainTarget(
      {
        id: 'domain-1',
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['tracked-a'],
        dnsTargetIps: ['8.8.8.8'],
        dnsTtl: 1,
        dnsProxied: true,
        nginxNodeId: 'node-1',
        pendingDnsTargetIp: '1.1.1.1',
      },
      '1.1.1.1'
    );

    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.updateDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
    expect(writes).toEqual([expect.objectContaining({ dnsStatus: 'invalid' })]);
  });

  it('keeps the previous target snapshot and marks the domain invalid when Cloudflare reconcile fails', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const client = {
      listDnsRecords: vi
        .fn()
        .mockResolvedValue([
          { id: 'tracked-a', type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 1, proxied: true },
        ]),
      updateDnsRecord: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await (service as any).reconcileDomainTarget(
      {
        id: 'domain-1',
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['tracked-a'],
        dnsTargetIps: ['8.8.8.8'],
        dnsTtl: 1,
        dnsProxied: true,
        nginxNodeId: 'node-1',
        pendingDnsTargetIp: '1.1.1.1',
      },
      '1.1.1.1'
    );

    expect(writes).toEqual([expect.objectContaining({ dnsStatus: 'invalid' })]);
    expect(writes[0]).not.toHaveProperty('dnsTargetIps');
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('repairs tracked provider drift even when the stored target snapshot already matches', async () => {
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const client = {
      listDnsRecords: vi
        .fn()
        .mockResolvedValue([
          { id: 'tracked-a', type: 'A', name: 'app.example.com', content: '9.9.9.9', ttl: 1, proxied: true },
        ]),
      updateDnsRecord: vi.fn().mockResolvedValue(undefined),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await (service as any).reconcileDomainTarget(
      {
        id: 'domain-1',
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['tracked-a'],
        dnsRecordType: 'A',
        dnsTargetIps: ['1.1.1.1'],
        dnsStatus: 'valid',
        dnsTtl: 1,
        dnsProxied: true,
        nginxNodeId: 'node-1',
      },
      '1.1.1.1'
    );

    expect(client.updateDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'tracked-a',
      expect.objectContaining({ type: 'A', content: '1.1.1.1', ttl: 1, proxied: true })
    );
  });

  it('recreates a missing tracked record without touching unrelated record types', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const client = {
      listDnsRecords: vi
        .fn()
        .mockResolvedValue([{ id: 'txt-1', type: 'TXT', name: 'app.example.com', content: 'verify=1', ttl: 1 }]),
      createDnsRecord: vi.fn().mockResolvedValue({ id: 'replacement-a' }),
      updateDnsRecord: vi.fn(),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await (service as any).reconcileDomainTarget(
      {
        id: 'domain-1',
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['deleted-a'],
        dnsTargetIps: ['1.1.1.1'],
        dnsTtl: 1,
        dnsProxied: true,
        nginxNodeId: 'node-1',
      },
      '1.1.1.1'
    );

    expect(client.createDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ type: 'A', name: 'app.example.com', content: '1.1.1.1' })
    );
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
    expect(writes).toContainEqual(expect.objectContaining({ providerRecordIds: ['replacement-a'] }));
  });

  it('recovers a created replacement by ownership marker after database persistence fails', async () => {
    const providerRecords: Array<Record<string, unknown>> = [];
    let rejectFirstSnapshot = true;
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            if ('providerRecordIds' in values && rejectFirstSnapshot) {
              rejectFirstSnapshot = false;
              throw new Error('database unavailable');
            }
          }),
        })),
      })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    const client = {
      listDnsRecords: vi.fn(async () => providerRecords),
      createDnsRecord: vi.fn(async (_zoneId: string, input: Record<string, unknown>) => {
        const record = { id: 'replacement-a', ...input };
        providerRecords.push(record);
        return record;
      }),
      updateDnsRecord: vi.fn(),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);
    const row = {
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      integrationConnectorId: 'connector-1',
      providerZoneId: 'zone-1',
      providerRecordIds: ['deleted-a'],
      dnsTargetIps: ['8.8.8.8'],
      dnsTtl: 1,
      dnsProxied: true,
      nginxNodeId: 'node-1',
      pendingDnsTargetIp: '1.1.1.1',
    };

    await (service as any).reconcileDomainTarget(row, '1.1.1.1');
    await (service as any).reconcileDomainTarget(row, '1.1.1.1');

    expect(client.createDnsRecord).toHaveBeenCalledTimes(1);
    expect(client.createDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ comment: 'wiolett-gateway:domain:domain-1' })
    );
    expect(client.updateDnsRecord).not.toHaveBeenCalled();
  });

  it('automatically reconciles Cloudflare domains after a reported ingress-address change', async () => {
    const domain = {
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      nginxNodeId: 'node-1',
      dnsTargetIps: ['8.8.8.8'],
      dnsStatus: 'valid',
      pendingDnsTargetIp: null,
    };
    let selection = 0;
    const updateSet = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ ...domain, ...values }]),
      })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selection += 1;
            return selection === 1 ? Promise.resolve([]) : Promise.resolve([domain]);
          }),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    vi.spyOn(service as any, 'getNginxNodeSummary').mockResolvedValue({ id: 'node-1', effectiveAddress: '1.1.1.1' });
    const reconcile = vi.spyOn(service as any, 'reconcileDomainTarget').mockResolvedValue(undefined);

    await service.reconcileIngressTargets('node-1');

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ pendingDnsTargetIp: '1.1.1.1' }));
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ pendingDnsTargetIp: '1.1.1.1' }), '1.1.1.1');
  });

  it('retries a durably approved retarget after a transient provider failure', async () => {
    const domain = {
      id: 'domain-1',
      domain: 'app.example.com',
      nginxNodeId: 'node-1',
      dnsProvider: 'cloudflare',
      integrationConnectorId: 'connector-1',
      providerZoneId: 'zone-1',
      providerRecordIds: ['tracked-a'],
      dnsTargetIps: ['8.8.8.8'],
      dnsRecordType: 'A',
      dnsStatus: 'valid',
      dnsTtl: 1,
      dnsProxied: true,
      pendingDnsTargetIp: '1.1.1.1',
    };
    let selection = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selection += 1;
            return selection % 2 === 1 ? Promise.resolve([]) : Promise.resolve([domain]);
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            Object.assign(domain, values);
          }),
        })),
      })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    vi.spyOn(service as any, 'getNginxNodeSummary').mockResolvedValue({ id: 'node-1', effectiveAddress: '1.1.1.1' });
    const client = {
      listDnsRecords: vi
        .fn()
        .mockResolvedValue([
          { id: 'tracked-a', type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 1, proxied: true },
        ]),
      updateDnsRecord: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockResolvedValueOnce(undefined),
      deleteDnsRecord: vi.fn(),
    };
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' }, client }),
    } as never);

    await service.reconcileIngressTargets('node-1');
    expect(domain).toMatchObject({
      dnsTargetIps: ['8.8.8.8'],
      dnsStatus: 'invalid',
      pendingDnsTargetIp: '1.1.1.1',
    });

    await service.reconcileIngressTargets('node-1');
    expect(client.updateDnsRecord).toHaveBeenCalledTimes(2);
    expect(domain).toMatchObject({
      dnsTargetIps: ['1.1.1.1'],
      dnsStatus: 'valid',
      pendingDnsTargetIp: null,
    });
  });

  it('creates a Cloudflare address record from the assigned Nginx node', async () => {
    const db = createInsertDb({
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      dnsOwnership: 'created',
      providerRecordIds: ['record-A'],
    });
    const { service, client } = createService(db, []);

    await expect(service.createDomain({ domain: 'App.Example.com' }, 'user-1')).resolves.toMatchObject({
      id: 'domain-1',
      dnsOwnership: 'created',
      providerRecordIds: ['record-A'],
    });

    expect(client.createDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ type: 'A', name: 'app.example.com', content: '8.8.8.8' })
    );
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        dnsOwnership: 'created',
        nginxNodeId: '11111111-1111-4111-8111-111111111111',
        dnsTargetIps: ['8.8.8.8'],
        dnsRecordType: 'A',
      })
    );
  });

  it('creates an external domain only after DNS matches the selected Nginx node', async () => {
    const db = createInsertDb({
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'legacy',
      dnsOwnership: 'legacy',
      dnsTargetIps: ['8.8.8.8'],
    });
    const { service, client } = createService(db, []);

    await expect(
      service.createDomain({ domain: 'App.Example.com', dnsProvider: 'external' }, 'user-1')
    ).resolves.toMatchObject({ dnsProvider: 'legacy', dnsTargetIps: ['8.8.8.8'] });

    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'app.example.com',
        dnsProvider: 'legacy',
        dnsOwnership: 'legacy',
        nginxNodeId: '11111111-1111-4111-8111-111111111111',
        dnsTargetIps: ['8.8.8.8'],
        dnsStatus: 'valid',
      })
    );
    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('keeps a mismatched external domain out of persistence', async () => {
    vi.mocked(probeDnsRecords).mockResolvedValueOnce({
      queryName: 'app.example.com',
      addressResolution: 'resolved',
      records: { a: ['1.1.1.1'], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    });
    const db = createConflictDb();
    const { service } = createService(db, []);

    await expect(
      service.createDomain({ domain: 'app.example.com', dnsProvider: 'external' }, 'user-1')
    ).rejects.toMatchObject({
      code: 'DOMAIN_DNS_NOT_READY',
      details: expect.objectContaining({ status: 'invalid', targetIps: ['8.8.8.8'] }),
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('adopts a matching external domain into Cloudflare without mutating provider DNS', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const migratedRow = {
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
    };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(values.dnsProvider === 'cloudflare' ? [migratedRow] : []),
            })),
          };
        }),
      })),
    };
    const { service, client } = createService(db, [
      { id: 'record-a', type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 120, proxied: true },
      { id: 'record-txt', type: 'TXT', name: 'app.example.com', content: 'verification=1', ttl: 120 },
    ]);

    await (service as any).migrateExternalDomainToCloudflare({
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'legacy',
      nginxNodeId: '11111111-1111-4111-8111-111111111111',
    });

    expect(writes).toContainEqual(
      expect.objectContaining({
        dnsProvider: 'cloudflare',
        dnsOwnership: 'matched_existing',
        integrationConnectorId: 'connector-1',
        providerZoneId: 'zone-1',
        providerRecordIds: ['record-a'],
        dnsTargetIps: ['8.8.8.8'],
        cloudflareMigrationStatus: 'migrated',
      })
    );
    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('leaves conflicting external DNS untouched and records a migration status', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) };
        }),
      })),
    };
    const { service, client } = createService(db, [
      { id: 'record-a', type: 'A', name: 'app.example.com', content: '1.1.1.1', ttl: 120, proxied: false },
    ]);

    await (service as any).migrateExternalDomainToCloudflare({
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'legacy',
      nginxNodeId: '11111111-1111-4111-8111-111111111111',
    });

    expect(writes).toContainEqual(expect.objectContaining({ cloudflareMigrationStatus: 'dns_conflict' }));
    expect(writes).not.toContainEqual(expect.objectContaining({ dnsProvider: 'cloudflare' }));
    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('clears stale migration statuses when no enabled Cloudflare connector remains', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 'domain-1', domain: 'app.example.com' }]),
        })),
      })),
      update: vi.fn(() => ({ set })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    service.setIntegrationsService({
      hasEnabledCloudflareConnector: vi.fn().mockResolvedValue(false),
    } as never);

    await service.migrateExternalDomainsToCloudflare();

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudflareMigrationStatus: null,
        cloudflareMigrationCheckedAt: null,
      })
    );
  });

  it('returns target mismatch metadata without persisting when existing Cloudflare records differ', async () => {
    const db = createConflictDb();
    const { service, client } = createService(db, [
      { id: 'record-a', type: 'A', name: 'app.example.com', content: '198.51.100.20', ttl: 1, proxied: true },
    ]);

    await expect(service.createDomain({ domain: 'app.example.com' }, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_DNS_TARGET_MISMATCH',
      details: expect.objectContaining({
        canOverwrite: true,
        desiredRecords: expect.arrayContaining([expect.objectContaining({ type: 'A', content: '8.8.8.8' })]),
      }),
    } satisfies Partial<AppError>);
    expect(db.insert).not.toHaveBeenCalled();
    expect(client.createDnsRecord).not.toHaveBeenCalled();
  });

  it('previews the matching Cloudflare zone and desired Gateway target records', async () => {
    const { service } = createService({}, []);

    await expect(service.previewDomain({ domain: 'app.example.com' })).resolves.toMatchObject({
      domain: 'app.example.com',
      zoneName: 'example.com',
      targetIps: ['8.8.8.8'],
      status: 'ready',
      desiredRecords: expect.arrayContaining([expect.objectContaining({ type: 'A', content: '8.8.8.8' })]),
    });
  });

  it('does not report MX and TXT records as address conflicts', async () => {
    const { service } = createService({}, [
      { id: 'record-mx', type: 'MX', name: 'app.example.com', content: 'mail.example.com', ttl: 1 },
      { id: 'record-txt', type: 'TXT', name: 'app.example.com', content: 'verification=value', ttl: 1 },
    ]);

    await expect(service.previewDomain({ domain: 'app.example.com' })).resolves.toMatchObject({
      status: 'ready',
      currentRecords: [],
      canOverwrite: false,
    });
  });

  it('treats proxied Cloudflare records as valid when provider targets match Gateway IPs', async () => {
    vi.mocked(probeDnsRecords).mockResolvedValueOnce({
      queryName: 'app.example.com',
      addressResolution: 'resolved',
      records: { a: ['104.16.1.1'], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    });
    const updateSet = vi.fn((value) => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'domain-1', dnsStatus: value.dnsStatus }]),
      })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'domain-1',
                domain: 'app.example.com',
                dnsProvider: 'cloudflare',
                integrationConnectorId: 'connector-1',
                providerZoneId: 'zone-1',
                providerRecordIds: ['record-a'],
                dnsTargetIps: ['203.0.113.10'],
                dnsRecordType: 'A',
                dnsStatus: 'valid',
                dnsTtl: 1,
                dnsProxied: true,
              },
            ]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    const service = new DomainsService(db as never, { log: vi.fn() } as never);
    service.setIntegrationsService({
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({
        zone: { remoteId: 'zone-1' },
        client: {
          listDnsRecords: vi.fn().mockResolvedValue([
            {
              id: 'record-a',
              type: 'A',
              name: 'app.example.com',
              content: '203.0.113.10',
              ttl: 1,
              proxied: true,
            },
          ]),
          updateDnsRecord: vi.fn(),
          deleteDnsRecord: vi.fn(),
          createDnsRecord: vi.fn(),
        },
      }),
    } as never);

    await expect(service.checkDns('domain-1')).resolves.toMatchObject({ dnsStatus: 'valid' });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ dnsStatus: 'valid' }));
  });

  it('checks external domains against the assigned Nginx node address', async () => {
    const service = new DomainsService({} as never, { log: vi.fn() } as never);
    const nodeLookup = vi
      .spyOn(service as any, 'getNginxNodeSummary')
      .mockResolvedValue({ id: 'node-1', effectiveAddress: '1.1.1.1' });

    await expect(
      (service as any).computeDomainDnsStatus(
        {
          dnsProvider: 'legacy',
          nginxNodeId: 'node-1',
          dnsTargetIps: [],
        },
        { a: ['1.1.1.1'], aaaa: [], cname: [], caa: [], mx: [], txt: [] }
      )
    ).resolves.toBe('valid');
    expect(nodeLookup).toHaveBeenCalledWith('node-1');
  });

  it('accepts either or both configured Nginx addresses but rejects unrelated DNS addresses', async () => {
    const service = new DomainsService({} as never, { log: vi.fn() } as never);
    vi.spyOn(service as any, 'getNginxNodeSummary').mockResolvedValue({
      id: 'node-1',
      effectiveAddress: '1.1.1.1',
      effectiveAddresses: ['1.1.1.1', '8.8.8.8'],
    });
    const row = { dnsProvider: 'legacy', nginxNodeId: 'node-1', dnsTargetIps: [] };
    const records = (a: string[]) => ({ a, aaaa: [], cname: [], caa: [], mx: [], txt: [] });

    await expect((service as any).computeDomainDnsStatus(row, records(['1.1.1.1']))).resolves.toBe('valid');
    await expect((service as any).computeDomainDnsStatus(row, records(['8.8.8.8']))).resolves.toBe('valid');
    await expect((service as any).computeDomainDnsStatus(row, records(['1.1.1.1', '8.8.8.8']))).resolves.toBe('valid');
    await expect((service as any).computeDomainDnsStatus(row, records(['1.1.1.1', '9.9.9.9']))).resolves.toBe(
      'invalid'
    );
  });
});
