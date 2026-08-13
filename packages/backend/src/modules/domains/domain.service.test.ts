import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/middleware/error-handler.js';
import { resolveDnsRecords } from './dns.utils.js';
import { DomainsService } from './domain.service.js';

vi.mock('@/db/schema/proxy-hosts.js', () => ({
  proxyHosts: {
    id: 'proxyHosts.id',
    slug: 'proxyHosts.slug',
    domainNames: 'proxyHosts.domainNames',
    enabled: 'proxyHosts.enabled',
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
  service.setGeneralSettingsService({
    getGatewayEndpointSettings: vi.fn().mockResolvedValue({
      gatewayPublicIps: ['203.0.113.10', '2001:db8::10'],
      gatewayGrpcPublicTarget: null,
      gatewayGrpcLocalIp: null,
    }),
  } as never);
  return { service, client };
}

describe('DomainsService Cloudflare lifecycle', () => {
  it('creates Cloudflare A and AAAA records from configured Gateway public IPs', async () => {
    const db = createInsertDb({
      id: 'domain-1',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      dnsOwnership: 'created',
      providerRecordIds: ['record-A', 'record-AAAA'],
    });
    const { service, client } = createService(db, []);

    await expect(service.createDomain({ domain: 'App.Example.com' }, 'user-1')).resolves.toMatchObject({
      id: 'domain-1',
      dnsOwnership: 'created',
      providerRecordIds: ['record-A', 'record-AAAA'],
    });

    expect(client.createDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ type: 'A', name: 'app.example.com', content: '203.0.113.10' })
    );
    expect(client.createDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ type: 'AAAA', name: 'app.example.com', content: '2001:db8::10' })
    );
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'app.example.com',
        dnsProvider: 'cloudflare',
        dnsOwnership: 'created',
        dnsTargetIps: ['203.0.113.10', '2001:db8::10'],
        dnsRecordType: 'A/AAAA',
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
        desiredRecords: expect.arrayContaining([
          expect.objectContaining({ type: 'A', content: '203.0.113.10' }),
          expect.objectContaining({ type: 'AAAA', content: '2001:db8::10' }),
        ]),
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
      targetIps: ['203.0.113.10', '2001:db8::10'],
      status: 'ready',
      desiredRecords: expect.arrayContaining([
        expect.objectContaining({ type: 'A', content: '203.0.113.10' }),
        expect.objectContaining({ type: 'AAAA', content: '2001:db8::10' }),
      ]),
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
    vi.mocked(resolveDnsRecords).mockResolvedValueOnce({
      a: ['104.16.1.1'],
      aaaa: [],
      cname: [],
      caa: [],
      mx: [],
      txt: [],
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
                dnsTargetIps: ['203.0.113.10'],
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
        },
      }),
    } as never);

    await expect(service.checkDns('domain-1')).resolves.toMatchObject({ dnsStatus: 'valid' });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ dnsStatus: 'valid' }));
  });
});
