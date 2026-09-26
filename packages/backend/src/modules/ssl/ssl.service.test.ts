import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLeaseStore, operationLeaseKey } from '@/db/operation-lease.js';
import { createFakeOperationLeaseDb } from '@/db/operation-lease.test-helpers.js';
import { AppError } from '@/middleware/error-handler.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { RequestACMECertSchema } from './ssl.schemas.js';
import { SSLService } from './ssl.service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SSLService DNS-01 renewal', () => {
  it('allows Cloudflare DNS-01 requests to keep auto-renew enabled', () => {
    expect(
      RequestACMECertSchema.parse({
        domains: ['*.example.com'],
        challengeType: 'dns-01',
        dnsProvider: 'cloudflare',
      })
    ).toMatchObject({
      challengeType: 'dns-01',
      dnsProvider: 'cloudflare',
      autoRenew: true,
    });

    expect(
      RequestACMECertSchema.parse({
        domains: ['*.example.com'],
        challengeType: 'dns-01',
      })
    ).toMatchObject({
      challengeType: 'dns-01',
      autoRenew: false,
    });
  });

  it('provisions Cloudflare DNS-01 records for initial issuance and completes verification', async () => {
    vi.useFakeTimers();
    const cert = {
      id: 'cert-1',
      name: '*.example.com',
      type: 'acme',
      status: 'pending',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['*.example.com'],
    };
    const insertReturning = vi.fn().mockResolvedValue([cert]);
    const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      update: vi.fn().mockReturnValue({ set }),
    } as any;
    const acmeService = {
      requestCertDNS01Start: vi.fn().mockResolvedValue({
        accountKey: 'account-key',
        orderUrl: 'https://acme.test/order/1',
        challenges: [
          {
            domain: '*.example.com',
            recordName: '_acme-challenge.example.com',
            recordValue: 'challenge-token',
          },
        ],
      }),
    } as any;
    const cryptoService = {
      encryptPrivateKey: vi.fn().mockReturnValue({
        encryptedPrivateKey: 'encrypted',
        encryptedDek: 'dek',
        dekIv: 'iv',
      }),
    } as any;
    const createDnsRecord = vi.fn().mockResolvedValue({ id: 'record-1' });
    const integrationsService = {
      resolveCloudflareDnsContext: vi.fn().mockResolvedValue({
        connector: { id: 'connector-1', name: 'Cloudflare' },
        zone: { remoteId: 'zone-1', name: 'example.com' },
        client: {
          listDnsRecords: vi.fn().mockResolvedValue([]),
          createDnsRecord,
        },
      }),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    service.setIntegrationsService(integrationsService);
    const complete = vi
      .spyOn(service, 'completeDNS01Verification')
      .mockResolvedValue({ id: 'cert-1', status: 'active' } as any);

    const request = service.requestACMECert(
      RequestACMECertSchema.parse({
        domains: ['*.example.com'],
        challengeType: 'dns-01',
        dnsProvider: 'cloudflare',
      }),
      'user-1'
    );
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({
      certificate: { id: 'cert-1', status: 'active' },
      status: 'issued',
    });

    expect(createDnsRecord).toHaveBeenCalledWith('zone-1', expect.objectContaining({ type: 'TXT' }));
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        autoRenew: true,
        autoRenewProvider: 'cloudflare',
        autoRenewDnsBindings: [
          expect.objectContaining({ connectorId: 'connector-1', zoneId: 'zone-1', domain: '*.example.com' }),
        ],
        acmePendingChallenges: [
          expect.objectContaining({
            cloudflare: expect.objectContaining({ connectorId: 'connector-1', recordId: 'record-1' }),
          }),
        ],
      })
    );
    expect(complete).toHaveBeenCalledWith('cert-1', 'user-1', {
      cleanupCloudflare: true,
      clearPendingOnFailure: true,
    });
  });

  it('cleans up Cloudflare DNS-01 records when initial issuance aborts after provisioning', async () => {
    const cert = {
      id: 'cert-1',
      name: '*.example.com',
      type: 'acme',
      status: 'pending',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['*.example.com'],
    };
    const insertReturning = vi.fn().mockResolvedValue([cert]);
    const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
    const where = vi.fn().mockRejectedValueOnce(new Error('db update failed')).mockResolvedValueOnce(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const db = {
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      update: vi.fn().mockReturnValue({ set }),
    } as any;
    const acmeService = {
      requestCertDNS01Start: vi.fn().mockResolvedValue({
        accountKey: 'account-key',
        orderUrl: 'https://acme.test/order/1',
        challenges: [
          {
            domain: '*.example.com',
            recordName: '_acme-challenge.example.com',
            recordValue: 'challenge-token',
          },
        ],
      }),
    } as any;
    const cryptoService = {
      encryptPrivateKey: vi.fn().mockReturnValue({
        encryptedPrivateKey: 'encrypted',
        encryptedDek: 'dek',
        dekIv: 'iv',
      }),
    } as any;
    const deleteDnsRecord = vi.fn().mockResolvedValue(undefined);
    const integrationsService = {
      resolveCloudflareDnsContext: vi.fn().mockResolvedValue({
        connector: { id: 'connector-1', name: 'Cloudflare' },
        zone: { remoteId: 'zone-1', name: 'example.com' },
        client: {
          listDnsRecords: vi.fn().mockResolvedValue([]),
          createDnsRecord: vi.fn().mockResolvedValue({ id: 'record-1' }),
        },
      }),
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({
        client: { deleteDnsRecord },
      }),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    service.setIntegrationsService(integrationsService);
    const complete = vi.spyOn(service, 'completeDNS01Verification');

    await expect(
      service.requestACMECert(
        RequestACMECertSchema.parse({
          domains: ['*.example.com'],
          challengeType: 'dns-01',
          dnsProvider: 'cloudflare',
          autoRenew: false,
        }),
        'user-1'
      )
    ).rejects.toThrow('db update failed');

    expect(deleteDnsRecord).toHaveBeenCalledWith('zone-1', 'record-1');
    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'error',
        renewalError: 'db update failed',
        acmeOrderUrl: null,
        acmePendingOperation: null,
        acmePendingChallenges: null,
        autoRenew: false,
        autoRenewProvider: null,
        autoRenewDnsBindings: null,
      })
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not persist a pending renewal when Cloudflare provisioning fails', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({ set });
    const db = {
      query: {
        sslCertificates: {
          findFirst: vi.fn().mockResolvedValue(cert),
        },
      },
      update,
    } as any;
    const acmeService = {
      requestCertDNS01Start: vi.fn().mockResolvedValue({
        accountKey: 'account-key',
        orderUrl: 'https://acme.test/order/1',
        challenges: [
          {
            domain: 'example.com',
            recordName: '_acme-challenge.example.com',
            recordValue: 'challenge-token',
          },
        ],
      }),
    } as any;
    const cryptoService = {
      encryptPrivateKey: vi.fn().mockReturnValue({
        encryptedPrivateKey: 'encrypted',
        encryptedDek: 'dek',
        dekIv: 'iv',
      }),
    } as any;
    const integrationsService = {
      resolveCloudflareDnsContext: vi
        .fn()
        .mockRejectedValue(new AppError(502, 'CLOUDFLARE_UNAVAILABLE', 'Cloudflare unavailable')),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    service.setIntegrationsService(integrationsService);

    await expect(service.renewCert('cert-1', 'user-1')).rejects.toMatchObject({
      code: 'CLOUDFLARE_UNAVAILABLE',
    });

    // Only the failed attempt is recorded; no pending renewal order is kept
    // and the still-valid certificate stays active.
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', renewalError: 'Renewal failed: Cloudflare unavailable' })
    );
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ acmePendingOperation: 'renewal' }));
  });

  it('clears pending renewal state when automatic Cloudflare verification fails', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['example.com'],
      acmeAccountKey: JSON.stringify({
        encrypted: 'encrypted-account-key',
        encryptedDek: 'account-dek',
        dekIv: 'account-iv',
      }),
      acmeOrderUrl: 'https://acme.test/order/1',
      acmePendingOperation: 'renewal',
      acmePendingChallenges: [
        {
          domain: 'example.com',
          recordName: '_acme-challenge.example.com',
          recordValue: 'challenge-token',
          cloudflare: {
            connectorId: 'connector-1',
            zoneId: 'zone-1',
            zoneName: 'example.com',
            recordId: 'record-1',
            created: true,
          },
        },
      ],
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn() });
    const db = {
      query: {
        sslCertificates: {
          findFirst: vi.fn().mockResolvedValue(cert),
        },
      },
      update: vi.fn().mockReturnValue({ set }),
    } as any;
    const acmeService = {
      requestCertDNS01Verify: vi.fn().mockRejectedValue(new Error('DNS record not visible yet')),
    } as any;
    const cryptoService = {
      decryptPrivateKey: vi.fn().mockReturnValue('account-key'),
      encryptPrivateKey: vi.fn(),
    } as any;
    const integrationsService = {
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({
        client: { deleteDnsRecord: vi.fn().mockResolvedValue(undefined) },
      }),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    service.setIntegrationsService(integrationsService);

    await expect(
      service.completeDNS01Verification('cert-1', 'user-1', {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      })
    ).rejects.toMatchObject({
      code: 'DNS01_VERIFICATION_FAILED',
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        acmeOrderUrl: null,
        acmePendingOperation: null,
        acmePendingChallenges: null,
        renewalError: 'Renewal failed: DNS record not visible yet',
      })
    );
  });

  it('clears pending issue state when automatic Cloudflare verification fails', async () => {
    const cert = {
      id: 'cert-1',
      name: '*.example.com',
      type: 'acme',
      status: 'pending',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['*.example.com'],
      acmeAccountKey: JSON.stringify({
        encrypted: 'encrypted-account-key',
        encryptedDek: 'account-dek',
        dekIv: 'account-iv',
      }),
      acmeOrderUrl: 'https://acme.test/order/1',
      acmePendingOperation: 'issue',
      acmePendingChallenges: [
        {
          domain: '*.example.com',
          recordName: '_acme-challenge.example.com',
          recordValue: 'challenge-token',
          cloudflare: {
            connectorId: 'connector-1',
            zoneId: 'zone-1',
            zoneName: 'example.com',
            recordId: 'record-1',
            created: true,
          },
        },
      ],
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn() });
    const db = {
      query: {
        sslCertificates: {
          findFirst: vi.fn().mockResolvedValue(cert),
        },
      },
      update: vi.fn().mockReturnValue({ set }),
    } as any;
    const acmeService = {
      requestCertDNS01Verify: vi.fn().mockRejectedValue(new Error('DNS record not visible yet')),
    } as any;
    const cryptoService = {
      decryptPrivateKey: vi.fn().mockReturnValue('account-key'),
      encryptPrivateKey: vi.fn(),
    } as any;
    const deleteDnsRecord = vi.fn().mockResolvedValue(undefined);
    const integrationsService = {
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({
        client: { deleteDnsRecord },
      }),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    service.setIntegrationsService(integrationsService);

    await expect(
      service.completeDNS01Verification('cert-1', 'user-1', {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      })
    ).rejects.toMatchObject({
      code: 'DNS01_VERIFICATION_FAILED',
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        acmeOrderUrl: null,
        acmePendingOperation: null,
        acmePendingChallenges: null,
        autoRenew: false,
        autoRenewProvider: null,
        autoRenewDnsBindings: null,
        renewalError: 'DNS record not visible yet',
      })
    );
    expect(deleteDnsRecord).toHaveBeenCalledWith('zone-1', 'record-1');
  });
});

describe('SSLService pending ACME cancellation', () => {
  it('refuses to delete a certificate used by the Pages wildcard profile', async () => {
    const { db, events } = certificateDeleteDb({ pagesProfileId: 'default' });
    const removeSslCertificateAsset = vi.fn();
    const service = new SSLService(
      db,
      {} as any,
      {} as any,
      { log: vi.fn() } as any,
      { removeSslCertificateAsset } as any
    );

    await expect(service.deleteCert('cert-1', 'user-1')).rejects.toMatchObject({
      code: 'CERT_IN_USE',
      details: { pagesProfileId: 'default' },
    });
    expect(removeSslCertificateAsset).not.toHaveBeenCalled();
    expect(events).not.toContain('delete');
  });

  // Regression (rc10 audit F5): the reference check ran before the delete
  // without a lock, so a host assigned in between kept ssl_enabled with a
  // NULL certificate and nginx pointed at files queued for cleanup.
  it('checks for referencing proxy hosts only after locking the certificate row', async () => {
    const { db, events, assignHost } = certificateDeleteDb({});
    // A proxy host update that names the certificate commits while the delete
    // waits for the row lock.
    db.lockGranted = () => assignHost('host-9');
    const removeSslCertificateAsset = vi.fn(async () => void events.push('remove-asset'));
    const service = new SSLService(
      db,
      {} as any,
      {} as any,
      { log: vi.fn() } as any,
      { removeSslCertificateAsset } as any
    );

    await expect(service.deleteCert('cert-1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CERT_IN_USE',
      details: { proxyHostIds: ['host-9'] },
    });
    expect(events).toEqual(['lock', 'references']);
    expect(removeSslCertificateAsset).not.toHaveBeenCalled();
  });

  it('removes the asset and deletes the row inside the locked transaction', async () => {
    const { db, events } = certificateDeleteDb({});
    const removeSslCertificateAsset = vi.fn(async () => void events.push('remove-asset'));
    const service = new SSLService(
      db,
      {} as any,
      {} as any,
      { log: vi.fn() } as any,
      { removeSslCertificateAsset } as any
    );

    await service.deleteCert('cert-1', 'user-1');

    expect(events).toEqual(['lock', 'references', 'pages', 'remove-asset', 'delete', 'commit']);
    // The asset is retired through the delete's own transaction, not the pool.
    expect(removeSslCertificateAsset).toHaveBeenCalledWith('cert-1', db.lastTx);
  });

  // Review follow-up: the asset removal wrote on a separate pooled connection,
  // so a delete that rolled back still left the surviving certificate's
  // replicas queued for cleanup.
  it('leaves the certificate replicas untouched when the delete rolls back', async () => {
    const committed = { id: 'replica-1', assetId: 'asset-1', nodeId: 'node-1', generation: 3, status: 'ready' };
    const pool = new Proxy(
      {},
      {
        get: () => {
          throw new Error('asset removal used a pooled connection outside the delete transaction');
        },
      }
    );
    const distribution = new NginxCertificateDistributionService(pool as never, {} as never, {} as never, {} as never);
    const pending: Array<() => void> = [];
    const tx = {
      select: vi.fn((fields?: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            fields
              ? { limit: async () => [] }
              : { for: async () => [{ id: 'cert-1', name: 'example.com', domainNames: [], isSystem: false }] },
        }),
      })),
      query: {
        proxyHosts: { findMany: async () => [] },
        nginxCertificateAssets: { findFirst: async () => ({ id: 'asset-1' }) },
        nginxCertificateReplicas: {
          findMany: async () => [{ ...committed }],
          findFirst: async () => ({ ...committed }),
        },
      },
      // Writes become visible only if the transaction commits.
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => void pending.push(() => Object.assign(committed, values)),
        }),
      }),
      delete: () => ({
        where: async () => {
          throw new Error('delete failed');
        },
      }),
    };
    const db = {
      transaction: async (fn: (transaction: unknown) => Promise<unknown>) => {
        const result = await fn(tx);
        for (const apply of pending) apply();
        return result;
      },
    } as any;
    const service = new SSLService(db, {} as any, {} as any, { log: vi.fn() } as any, distribution);

    await expect(service.deleteCert('cert-1', 'user-1')).rejects.toThrow('delete failed');

    expect(pending).toHaveLength(1);
    expect(committed).toMatchObject({ status: 'ready', generation: 3 });
  });

  it('deletes an unfinished initial ACME request', async () => {
    const db = {
      query: {
        sslCertificates: {
          findFirst: vi.fn().mockResolvedValue({
            type: 'acme',
            status: 'pending',
            acmePendingOperation: 'issue',
          }),
        },
      },
    } as any;
    const service = new SSLService(
      db,
      {} as any,
      {} as any,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    const deleteCert = vi.spyOn(service, 'deleteCert').mockResolvedValue(undefined);

    await service.cancelPendingAcmeIssue('cert-1', 'user-1');

    expect(deleteCert).toHaveBeenCalledWith('cert-1', 'user-1');
  });

  it('does not delete an active certificate or an in-progress renewal', async () => {
    const db = {
      query: {
        sslCertificates: {
          findFirst: vi.fn().mockResolvedValue({
            type: 'acme',
            status: 'pending',
            acmePendingOperation: 'renewal',
          }),
        },
      },
    } as any;
    const service = new SSLService(
      db,
      {} as any,
      {} as any,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    const deleteCert = vi.spyOn(service, 'deleteCert').mockResolvedValue(undefined);

    await expect(service.cancelPendingAcmeIssue('cert-1', 'user-1')).rejects.toMatchObject({
      code: 'ACME_REQUEST_NOT_PENDING',
    });
    expect(deleteCert).not.toHaveBeenCalled();
  });
});

/** Certificate delete transaction with an observable row lock. */
function certificateDeleteDb(options: { pagesProfileId?: string }) {
  const events: string[] = [];
  const referencingHosts: Array<{ id: string; domainNames: string[] }> = [];
  const db: any = {
    lockGranted: () => undefined,
    lastTx: undefined as unknown,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      db.lastTx = tx;
      const result = await fn(tx);
      events.push('commit');
      return result;
    }),
  };
  const tx = {
    select: vi.fn((fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          fields
            ? {
                limit: vi.fn(async () => {
                  events.push('pages');
                  return options.pagesProfileId ? [{ id: options.pagesProfileId }] : [];
                }),
              }
            : {
                for: vi.fn(async (strength: string) => {
                  expect(strength).toBe('update');
                  db.lockGranted();
                  events.push('lock');
                  return [{ id: 'cert-1', name: 'Pages', domainNames: ['*.pages.test'], isSystem: false }];
                }),
              },
      }),
    })),
    query: {
      proxyHosts: {
        findMany: vi.fn(async () => {
          events.push('references');
          return [...referencingHosts];
        }),
      },
    },
    delete: vi.fn(() => ({
      where: vi.fn(async () => void events.push('delete')),
    })),
  };
  return {
    db,
    events,
    assignHost: (id: string) => referencingHosts.push({ id, domainNames: ['app.example.com'] }),
  };
}

function selectChain(results: unknown[][]) {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy']) chain[method] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => queue.shift() ?? []);
  return vi.fn(() => chain);
}

/** `update().set().where()` that can be awaited directly or finished with `.returning()`. */
function updateWhere(rows: unknown[] = [{ id: 'cert-1' }]) {
  return vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn().mockResolvedValue(rows) }));
}

function renewalHarness(
  cert: Record<string, unknown>,
  options: { selectResults?: unknown[][]; issue?: () => Promise<unknown> } = {}
) {
  const set = vi.fn().mockReturnValue({ where: updateWhere() });
  const db = {
    query: { sslCertificates: { findFirst: vi.fn().mockResolvedValue(cert) } },
    update: vi.fn().mockReturnValue({ set }),
    select: selectChain(options.selectResults ?? []),
  } as any;
  const acmeService = {
    requestCertHTTP01: vi.fn(
      options.issue ??
        (async () => ({
          certificatePem: 'cert',
          privateKeyPem: 'key',
          chainPem: 'chain',
          notBefore: new Date(),
          notAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          accountKey: 'new-account-key',
        }))
    ),
  } as any;
  const cryptoService = {
    encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'enc', encryptedDek: 'dek', dekIv: 'iv' }),
  } as any;
  const service = new SSLService(
    db,
    acmeService,
    cryptoService,
    { log: vi.fn() } as any,
    { upsertGatewayAsset: vi.fn() } as any
  );
  return { service, db, set, acmeService };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('SSLService renewal failures', () => {
  it('keeps a still-valid certificate active (and heals a stuck error row) when renewal fails', async () => {
    const { service, set } = renewalHarness(
      {
        id: 'cert-1',
        name: 'example.com',
        type: 'acme',
        status: 'error',
        acmeChallengeType: 'http-01',
        acmeAccountKey: JSON.stringify({ contactEmail: 'ops@example.com' }),
        domainNames: ['example.com'],
        notAfter: new Date(Date.now() + 10 * DAY_MS),
      },
      { issue: async () => Promise.reject(new Error('rate limited')) }
    );

    await expect(service.renewCert('cert-1', 'user-1')).rejects.toMatchObject({ code: 'RENEWAL_FAILED' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        renewalError: 'Renewal failed: rate limited',
        renewalFailureCount: expect.anything(),
        lastRenewalAttemptAt: expect.any(Date),
      })
    );
  });

  it('marks a certificate expired only once notAfter has passed', async () => {
    const { service, set } = renewalHarness(
      {
        id: 'cert-1',
        name: 'example.com',
        type: 'acme',
        status: 'active',
        acmeChallengeType: 'http-01',
        acmeAccountKey: JSON.stringify({ contactEmail: 'ops@example.com' }),
        domainNames: ['example.com'],
        notAfter: new Date(Date.now() - DAY_MS),
      },
      { issue: async () => Promise.reject(new Error('unreachable')) }
    );

    await expect(service.renewCert('cert-1', 'user-1')).rejects.toMatchObject({ code: 'RENEWAL_FAILED' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('renews an expired certificate that still has auto-renew', async () => {
    const { service, acmeService } = renewalHarness({
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'expired',
      acmeChallengeType: 'http-01',
      acmeAccountKey: JSON.stringify({ contactEmail: 'ops@example.com' }),
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() - DAY_MS),
    });

    await service.renewCert('cert-1', 'user-1');
    expect(acmeService.requestCertHTTP01).toHaveBeenCalled();
  });
});

describe('SSLService ACME contact for pre-v2.10 certificates', () => {
  const legacyCert = {
    id: 'cert-1',
    name: 'example.com',
    type: 'acme',
    status: 'active',
    acmeChallengeType: 'http-01',
    // v2.9.x blobs carry no contactEmail
    acmeAccountKey: JSON.stringify({ encrypted: 'e', encryptedDek: 'd', dekIv: 'i' }),
    createdById: 'creator-1',
    domainNames: ['example.com'],
    notAfter: new Date(Date.now() + 10 * DAY_MS),
  };

  it('uses the renewing user and persists the contact into the account blob', async () => {
    const { service, acmeService, set } = renewalHarness(legacyCert);

    await service.renewCert('cert-1', 'user-1', 'operator@example.com');

    expect(acmeService.requestCertHTTP01).toHaveBeenCalledWith(['example.com'], false, 'operator@example.com');
    const stored = set.mock.calls.map(([values]) => values).find((values) => values.acmeAccountKey);
    expect(JSON.parse(stored.acmeAccountKey)).toMatchObject({ contactEmail: 'operator@example.com' });
  });

  it('falls back to the certificate creator for the renewal job', async () => {
    const { service, acmeService } = renewalHarness(legacyCert, {
      selectResults: [[{ email: 'creator@example.com' }]],
    });

    await service.renewCert('cert-1', '00000000-0000-0000-0000-000000000000');

    expect(acmeService.requestCertHTTP01).toHaveBeenCalledWith(['example.com'], false, 'creator@example.com');
  });

  it('falls back to the first system administrator when the creator is gone', async () => {
    const { service, acmeService } = renewalHarness(legacyCert, {
      selectResults: [[], [{ email: 'admin@example.com' }]],
    });

    await service.renewCert('cert-1', '00000000-0000-0000-0000-000000000000');

    expect(acmeService.requestCertHTTP01).toHaveBeenCalledWith(['example.com'], false, 'admin@example.com');
  });
});

describe('SSLService delivery to legacy Nginx daemons', () => {
  function deliveryHarness(deployLegacy: ReturnType<typeof vi.fn>) {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const host = {
      id: 'host-1',
      nodeId: 'node-1',
      sslEnabled: true,
      sslCertificateId: 'cert-1',
      internalCertificateId: null,
    };
    const db = {
      query: {
        sslCertificates: { findFirst: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'example.com' }) },
        proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) },
      },
      update: vi.fn().mockReturnValue({ set }),
    } as any;
    const distribution = {
      syncCertificate: vi.fn().mockResolvedValue({ synchronized: 0 }),
      deployLegacyCertificateForHost: deployLegacy,
      setLegacyHostConfigReapplier: vi.fn(),
    };
    const service = new SSLService(db, {} as any, {} as any, { log: vi.fn() } as any, distribution as any);
    const proxyService = {
      resyncTlsHost: vi
        .fn()
        .mockRejectedValue(new AppError(409, 'NGINX_TLS_DAEMON_UPDATE_REQUIRED', 'Update the selected daemon')),
      reconcileAdditionalRouteHost: vi.fn(),
    };
    service.setProxyService(proxyService as any);
    return { service, set, host, distribution };
  }

  it('pushes the certificate with the legacy command instead of only logging', async () => {
    const deployLegacy = vi.fn().mockResolvedValue('delivered');
    const { service, set, host, distribution } = deliveryHarness(deployLegacy);

    await expect(service.resyncDistribution('cert-1', 'user-1')).resolves.toEqual({ synchronized: 1 });

    expect(distribution.setLegacyHostConfigReapplier).toHaveBeenCalledWith(expect.any(Function));
    expect(deployLegacy).toHaveBeenCalledWith(host);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ renewalError: null }));
  });

  it('records a visible error when the legacy push fails', async () => {
    const deployLegacy = vi.fn().mockRejectedValue(new AppError(502, 'NGINX_TLS_LEGACY_DEPLOY_FAILED', 'node offline'));
    const { service, set } = deliveryHarness(deployLegacy);

    await expect(service.resyncDistribution('cert-1', 'user-1')).resolves.toEqual({ synchronized: 0 });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        renewalError: expect.stringMatching(/^Distribution incomplete: 1 proxy host\(s\).*node offline/),
      })
    );
  });
});

describe('SSLService internal certificate linking', () => {
  const certId = '11111111-1111-4111-8111-111111111111';

  function linkHarness(pkiCert: Record<string, unknown>, issuer: Record<string, unknown>) {
    const findFirst = vi.fn().mockResolvedValue(pkiCert);
    const db = {
      query: { certificates: { findFirst } },
      select: selectChain([[issuer]]),
      insert: vi.fn(),
    } as any;
    const cryptoService = { decryptPrivateKey: vi.fn() } as any;
    const service = new SSLService(db, {} as any, cryptoService, { log: vi.fn() } as any, {} as any);
    return { service, findFirst, db, cryptoService };
  }

  const serverCert = {
    id: certId,
    caId: 'ca-1',
    type: 'tls-server',
    status: 'active',
    notAfter: new Date(Date.now() + 30 * DAY_MS),
    encryptedPrivateKey: 'enc',
    encryptedDek: 'dek',
  };

  it('requires the PKI key-use scope before touching the PKI certificate', async () => {
    const { service, findFirst, cryptoService } = linkHarness(serverCert, { isSystem: false });

    await expect(
      service.linkInternalCert({ internalCertId: certId }, 'user-1', ['ssl:cert:issue'])
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(cryptoService.decryptPrivateKey).not.toHaveBeenCalled();
  });

  it('rejects system-CA, inactive and non-server certificates', async () => {
    const scopes = ['ssl:cert:issue', `pki:cert:export:${certId}`];

    await expect(
      linkHarness(serverCert, { isSystem: true }).service.linkInternalCert({ internalCertId: certId }, 'u', scopes)
    ).rejects.toMatchObject({ code: 'SYSTEM_CERT' });
    await expect(
      linkHarness({ ...serverCert, status: 'revoked' }, { isSystem: false }).service.linkInternalCert(
        { internalCertId: certId },
        'u',
        scopes
      )
    ).rejects.toMatchObject({ code: 'PKI_CERT_NOT_ACTIVE' });
    await expect(
      linkHarness({ ...serverCert, type: 'tls-client' }, { isSystem: false }).service.linkInternalCert(
        { internalCertId: certId },
        'u',
        scopes
      )
    ).rejects.toMatchObject({ code: 'PKI_CERT_NOT_SERVER' });
  });
});

describe('SSLService linked internal certificate renewal', () => {
  function internalHarness(cert: Record<string, unknown>) {
    const returning = vi.fn().mockResolvedValue([{ ...cert, autoRenew: false }]);
    const where = vi.fn(() => Object.assign(Promise.resolve(undefined), { returning }));
    const set = vi.fn(() => ({ where }));
    const db = {
      query: { sslCertificates: { findFirst: vi.fn().mockResolvedValue(cert) } },
      update: vi.fn(() => ({ set })),
      select: selectChain([]),
    } as any;
    const audit = { log: vi.fn() };
    const service = new SSLService(db, {} as any, {} as any, audit as any, { upsertGatewayAsset: vi.fn() } as any);
    return { service, db, set, audit };
  }

  const linked = {
    id: 'ssl-1',
    name: 'api.example.com',
    type: 'internal',
    status: 'active',
    internalCertId: 'pki-1',
    privateKeyPem: 'enc',
    autoRenew: true,
    renewalError: null,
    notAfter: new Date(Date.now() + 20 * DAY_MS),
  };

  it('routes a renew of a linked internal certificate to the CA reissue with the caller scopes', async () => {
    const { service } = internalHarness(linked);
    const renewer = { renewSslCertificate: vi.fn().mockResolvedValue({}) };
    service.setInternalCertificateRenewal(renewer);

    await service.renewCert('ssl-1', 'user-1', 'ops@example.com', { actorScopes: ['ssl:cert:issue'] });

    expect(renewer.renewSslCertificate).toHaveBeenCalledWith('ssl-1', 'user-1', { actorScopes: ['ssl:cert:issue'] });
  });

  it('still refuses to renew an uploaded certificate', async () => {
    const { service } = internalHarness({ ...linked, type: 'upload' });
    service.setInternalCertificateRenewal({ renewSslCertificate: vi.fn() });

    await expect(service.renewCert('ssl-1', 'user-1')).rejects.toMatchObject({ code: 'NOT_ACME' });
  });

  it('toggles automatic reissue for a linked certificate Gateway holds the key for', async () => {
    const { service, set, audit } = internalHarness(linked);

    await service.setAutoRenew('ssl-1', { enabled: false }, 'user-1');

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ autoRenew: false }));
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ssl.auto_renew', details: { enabled: false, type: 'internal' } })
    );
  });

  it('refuses automatic reissue for a CSR-issued link without a key', async () => {
    const { service, set } = internalHarness({ ...linked, privateKeyPem: null, autoRenew: false });

    await expect(service.setAutoRenew('ssl-1', { enabled: true }, 'user-1')).rejects.toMatchObject({
      code: 'INTERNAL_CERT_NOT_RENEWABLE',
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('links a certificate with automatic reissue on when Gateway holds its key', async () => {
    const certId = '11111111-1111-4111-8111-111111111111';
    const values = vi.fn((row: Record<string, unknown>) => ({
      returning: vi.fn().mockResolvedValue([{ id: 'ssl-new', ...row }]),
    }));
    const db = {
      query: {
        certificates: {
          findFirst: vi.fn().mockResolvedValue({
            id: certId,
            caId: 'ca-1',
            type: 'tls-server',
            status: 'active',
            commonName: 'api.example.com',
            certificatePem: 'not-a-pem',
            notBefore: new Date(),
            notAfter: new Date(Date.now() + 30 * DAY_MS),
            encryptedPrivateKey: 'enc',
            encryptedDek: 'dek',
            dekIv: 'iv',
          }),
        },
      },
      select: selectChain([[{ isSystem: false }]]),
      insert: vi.fn(() => ({ values })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    } as any;
    const cryptoService = {
      decryptPrivateKey: vi.fn().mockReturnValue('KEY'),
      encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'e', encryptedDek: 'd', dekIv: 'i' }),
    } as any;
    const service = new SSLService(
      db,
      {} as any,
      cryptoService,
      { log: vi.fn() } as any,
      {
        upsertGatewayAsset: vi.fn(),
      } as any
    );

    await service.linkInternalCert({ internalCertId: certId }, 'user-1', [
      'ssl:cert:issue',
      `pki:cert:export:${certId}`,
    ]);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ type: 'internal', autoRenew: true }));
  });
});

describe('SSLService ACME single flight', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const issued = () => ({
    certificatePem: 'cert',
    privateKeyPem: 'key',
    chainPem: 'chain',
    notBefore: new Date(),
    notAfter: new Date(Date.now() + 90 * DAY),
  });

  const httpCert = {
    id: 'cert-1',
    name: 'example.com',
    type: 'acme',
    status: 'active',
    acmeChallengeType: 'http-01',
    acmeAccountKey: JSON.stringify({ contactEmail: 'ops@example.com' }),
    acmeOrderUrl: null,
    acmePendingOperation: null,
    domainNames: ['example.com'],
    notAfter: new Date(Date.now() + 10 * DAY),
  };

  // Regression (rc10 audit F3): a double-clicked Renew, or a Renew during the
  // nightly job, ran two full ACME orders for one certificate.
  it('runs one ACME order for concurrent renewals of the same certificate', async () => {
    const order = deferred<ReturnType<typeof issued>>();
    const { service, acmeService } = renewalHarness(httpCert, { issue: () => order.promise });

    const first = service.renewCert('cert-1', 'user-1');
    const repeated = service.renewCert('cert-1', 'user-1');
    const byJob = service.renewCert('cert-1', '00000000-0000-0000-0000-000000000000');
    const verify = service.completeDNS01Verification('cert-1', 'user-1');

    await expect(byJob).rejects.toMatchObject({ statusCode: 409, code: 'ACME_OPERATION_IN_PROGRESS' });
    await expect(verify).rejects.toMatchObject({ statusCode: 409, code: 'ACME_OPERATION_IN_PROGRESS' });
    order.resolve(issued());
    const [firstResult, repeatedResult] = await Promise.all([first, repeated]);

    expect(repeatedResult).toBe(firstResult);
    expect(acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1);

    // Once it settles, the certificate can be renewed again.
    await service.renewCert('cert-1', '00000000-0000-0000-0000-000000000000');
    expect(acmeService.requestCertHTTP01).toHaveBeenCalledTimes(2);
  });

  it('dedupes a double-submitted certificate request into one order and one row', async () => {
    const order = deferred<ReturnType<typeof issued> & { accountKey: string }>();
    const insertValues = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'cert-1', name: 'example.com', status: 'active' }]),
    }));
    const db = {
      insert: vi.fn(() => ({ values: insertValues })),
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([]) } },
    } as any;
    const acmeService = { requestCertHTTP01: vi.fn(() => order.promise) } as any;
    const cryptoService = {
      encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'enc', encryptedDek: 'dek', dekIv: 'iv' }),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    const input = RequestACMECertSchema.parse({ domains: ['example.com'], challengeType: 'http-01' });

    const first = service.requestACMECert(input, 'user-1', 'ops@example.com');
    const second = service.requestACMECert(input, 'user-1', 'ops@example.com');
    const otherUser = service.requestACMECert(input, 'user-2', 'ops@example.com');
    await expect(otherUser).rejects.toMatchObject({ statusCode: 409, code: 'ACME_OPERATION_IN_PROGRESS' });
    order.resolve({ ...issued(), accountKey: 'account-key' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
  });

  /** Two SSL services on one database: separate backend processes. */
  function twoProcesses(issueA?: () => Promise<unknown>, issueB?: () => Promise<unknown>) {
    const leaseDb = createFakeOperationLeaseDb();
    const processes = [renewalHarness(httpCert, { issue: issueA }), renewalHarness(httpCert, { issue: issueB })];
    for (const { service } of processes) {
      service.setOperationLeases(new OperationLeaseStore(leaseDb.db));
      (service as unknown as { acmeJoinPollMs: number }).acmeJoinPollMs = 1;
    }
    return { a: processes[0]!, b: processes[1]!, leaseDb };
  }

  // rc.11: the single flight above was per process, so the renewal job on one
  // replica and a Renew on another still ran two orders for one certificate.
  it('runs one ACME order per certificate across backend processes, joining the same caller', async () => {
    const order = deferred<ReturnType<typeof issued>>();
    const { a, b } = twoProcesses(() => order.promise);

    const first = a.service.renewCert('cert-1', 'user-1');
    await vi.waitFor(() => expect(a.acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1));
    // A's call to the ACME server is pending and holds no database lock: B's
    // claims are answered at once.
    await expect(b.service.renewCert('cert-1', '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACME_OPERATION_IN_PROGRESS',
    });
    await expect(b.service.completeDNS01Verification('cert-1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACME_OPERATION_IN_PROGRESS',
    });
    const repeated = b.service.renewCert('cert-1', 'user-1');

    order.resolve(issued());
    const [firstResult, repeatedResult] = await Promise.all([first, repeated]);

    expect(repeatedResult).toEqual(JSON.parse(JSON.stringify(firstResult)));
    expect(b.acmeService.requestCertHTTP01).not.toHaveBeenCalled();

    // Once it finished, another process may renew the certificate.
    await b.service.renewCert('cert-1', '00000000-0000-0000-0000-000000000000');
    expect(b.acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1);
  });

  it('gives a caller that joined from another process the same failure', async () => {
    const order = deferred<ReturnType<typeof issued>>();
    const { a, b } = twoProcesses(() => order.promise);

    const first = a.service.renewCert('cert-1', 'user-1');
    await vi.waitFor(() => expect(a.acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1));
    const repeated = b.service.renewCert('cert-1', 'user-1');
    order.reject(new Error('rate limited'));

    await expect(first).rejects.toMatchObject({ statusCode: 500, code: 'RENEWAL_FAILED' });
    await expect(repeated).rejects.toMatchObject({
      statusCode: 500,
      code: 'RENEWAL_FAILED',
      message: 'Certificate renewal failed: rate limited',
    });
    expect(b.acmeService.requestCertHTTP01).not.toHaveBeenCalled();
  });

  it('takes over the operation of a process that stopped once its lease lapses', async () => {
    const { b, leaseDb } = twoProcesses();
    const leaseKey = operationLeaseKey('acme', 'cert:cert-1');
    const stale = {
      token: 'stopped-process',
      holder: 'replica-1:42',
      expiresAt: new Date(Date.now() + 60_000),
      data: { kind: 'renew', actor: 'user-2' },
    };
    leaseDb.rows.set(leaseKey, stale);
    await expect(b.service.renewCert('cert-1', 'user-1')).rejects.toMatchObject({
      code: 'ACME_OPERATION_IN_PROGRESS',
    });

    leaseDb.rows.set(leaseKey, { ...stale, expiresAt: new Date(Date.now() - 1) });
    await b.service.renewCert('cert-1', 'user-1');

    expect(b.acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1);
    expect(leaseDb.rows.get(leaseKey)).toMatchObject({ data: { kind: 'renew', outcome: { status: 'fulfilled' } } });
  });

  // Regression (rc10 audit F3): a verify that lost the race wrote status
  // `error` and disabled auto-renew over the winner's valid certificate.
  it('does not store or mark failed a verify whose ACME order was replaced meanwhile', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['example.com'],
      acmeAccountKey: JSON.stringify({
        encrypted: 'e',
        encryptedDek: 'd',
        dekIv: 'i',
        contactEmail: 'ops@example.com',
      }),
      acmeOrderUrl: 'https://acme.test/order/1',
      acmePendingOperation: 'renewal',
      acmePendingChallenges: [],
      notAfter: new Date(Date.now() + 10 * DAY),
    };
    // The guarded write matches no row: the order is no longer the stored one.
    const where = vi.fn((_guard: unknown) =>
      Object.assign(Promise.resolve(undefined), { returning: vi.fn().mockResolvedValue([]) })
    );
    const set = vi.fn(() => ({ where }));
    const db = {
      query: { sslCertificates: { findFirst: vi.fn().mockResolvedValue(cert) } },
      update: vi.fn(() => ({ set })),
    } as any;
    const acmeService = { requestCertDNS01Verify: vi.fn().mockResolvedValue(issued()) } as any;
    const cryptoService = {
      decryptPrivateKey: vi.fn().mockReturnValue('account-key'),
      encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'enc', encryptedDek: 'dek', dekIv: 'iv' }),
    } as any;
    const upsertGatewayAsset = vi.fn();
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      {
        upsertGatewayAsset,
      } as any
    );

    await expect(service.completeDNS01Verification('cert-1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACME_ORDER_SUPERSEDED',
    });

    expect(set).toHaveBeenCalledTimes(1);
    expect(upsertGatewayAsset).not.toHaveBeenCalled();
    const guard = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as any);
    expect(guard.sql).toContain('"acme_order_url" = $');
    expect(guard.params).toEqual(expect.arrayContaining(['cert-1', 'https://acme.test/order/1', 'renewal']));
  });

  /** Whether the `operationLeaseHeld` conditions of a write's guard hold on the fake lease table (true without any). */
  function leaseFencesHold(leaseDb: ReturnType<typeof createFakeOperationLeaseDb>, guard: unknown): boolean {
    const { sql, params } = new PgDialect().sqlToQuery(guard as any);
    const fences = [...sql.matchAll(/"operation_leases"\."key" = \$(\d+) and "operation_leases"\."token" = \$(\d+)/g)];
    return fences.every(([, key, token]) =>
      leaseDb.held(String(params[Number(key) - 1]), String(params[Number(token) - 1]))
    );
  }

  /** A certificate row whose guarded writes land only while the operation's lease fences hold. */
  function fencedCertificateDb(cert: Record<string, unknown>, leaseDb: ReturnType<typeof createFakeOperationLeaseDb>) {
    const where = vi.fn((guard: unknown) =>
      Object.assign(Promise.resolve(undefined), {
        returning: vi.fn(async () => (leaseFencesHold(leaseDb, guard) ? [{ id: cert.id }] : [])),
      })
    );
    const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
    const db = {
      query: { sslCertificates: { findFirst: vi.fn().mockResolvedValue(cert) } },
      update: vi.fn(() => ({ set })),
    } as any;
    return { db, set, where };
  }

  const accountKey = JSON.stringify({ encrypted: 'e', encryptedDek: 'd', dekIv: 'i', contactEmail: 'ops@example.com' });

  // rc.11 data review F6: a verify whose lease had lapsed, and been taken
  // over by another process, still stored its result as the owner.
  it('does not store a verify once another process took its lease over', async () => {
    const leaseDb = createFakeOperationLeaseDb();
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['example.com'],
      acmeAccountKey: accountKey,
      acmeOrderUrl: 'https://acme.test/order/1',
      acmePendingOperation: 'renewal',
      acmePendingChallenges: [],
      notAfter: new Date(Date.now() + 10 * DAY),
    };
    const { db, set, where } = fencedCertificateDb(cert, leaseDb);
    const order = deferred<ReturnType<typeof issued>>();
    const acmeService = { requestCertDNS01Verify: vi.fn(() => order.promise) } as any;
    const cryptoService = {
      decryptPrivateKey: vi.fn().mockReturnValue('account-key'),
      encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'enc', encryptedDek: 'dek', dekIv: 'iv' }),
    } as any;
    const upsertGatewayAsset = vi.fn();
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      {
        upsertGatewayAsset,
      } as any
    );
    service.setOperationLeases(new OperationLeaseStore(leaseDb.db));

    const verify = service.completeDNS01Verification('cert-1', 'user-1');
    await vi.waitFor(() => expect(acmeService.requestCertDNS01Verify).toHaveBeenCalledTimes(1));
    // Its lease lapsed while the CA answered, and another process claimed the certificate.
    const leaseKey = operationLeaseKey('acme', 'cert:cert-1');
    leaseDb.rows.set(leaseKey, { ...leaseDb.rows.get(leaseKey)!, token: 'replica-2-token', holder: 'replica-2:7' });
    order.resolve(issued());

    await expect(verify).rejects.toMatchObject({ statusCode: 409, code: 'ACME_ORDER_SUPERSEDED' });
    // Nothing was stored, marked failed or distributed over the new owner's work.
    expect(set).toHaveBeenCalledTimes(1);
    expect(upsertGatewayAsset).not.toHaveBeenCalled();
    const guard = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as any);
    expect(guard.sql).toContain('"operation_leases"."expires_at" > statement_timestamp()');
    expect(guard.params).toEqual(expect.arrayContaining(['cert-1', 'https://acme.test/order/1', leaseKey]));
    // The new owner's lease is untouched.
    expect(leaseDb.rows.get(leaseKey)).toMatchObject({ token: 'replica-2-token' });
  });

  it('skips the verify step of a Cloudflare DNS-01 renewal once its lease was lost', async () => {
    vi.useFakeTimers();
    const leaseDb = createFakeOperationLeaseDb();
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      acmeChallengeType: 'dns-01',
      acmeProvider: 'letsencrypt',
      domainNames: ['example.com'],
      acmeAccountKey: accountKey,
      acmeOrderUrl: null,
      acmePendingOperation: null,
      acmePendingChallenges: null,
      autoRenewProvider: 'cloudflare',
      autoRenewDnsBindings: [
        {
          domain: 'example.com',
          connectorId: 'connector-1',
          connectorName: 'Cloudflare',
          zoneId: 'zone-1',
          zoneName: 'example.com',
        },
      ],
      notAfter: new Date(Date.now() + 10 * DAY),
    };
    const { db, set } = fencedCertificateDb(cert, leaseDb);
    const acmeService = {
      requestCertDNS01Start: vi.fn().mockResolvedValue({
        accountKey: 'account-key',
        orderUrl: 'https://acme.test/order/2',
        challenges: [{ domain: 'example.com', recordName: '_acme-challenge.example.com', recordValue: 'token' }],
      }),
      requestCertDNS01Verify: vi.fn(),
    } as any;
    const cryptoService = {
      encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'enc', encryptedDek: 'dek', dekIv: 'iv' }),
    } as any;
    // The renewal pauses once its new order is stored.
    const started = deferred<void>();
    const resume = deferred<void>();
    const log = vi.fn(async (entry: { action: string }) => {
      if (entry.action !== 'ssl.acme_dns01_renew_start') return;
      started.resolve();
      await resume.promise;
    });
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log } as any,
      {
        upsertGatewayAsset: vi.fn(),
      } as any
    );
    service.setIntegrationsService({
      resolveCloudflareDnsContext: vi.fn().mockResolvedValue({
        connector: { id: 'connector-1', name: 'Cloudflare' },
        zone: { remoteId: 'zone-1', name: 'example.com' },
        client: {
          listDnsRecords: vi.fn().mockResolvedValue([]),
          createDnsRecord: vi.fn().mockResolvedValue({ id: 'record-1' }),
        },
      }),
      getCloudflareDnsContextForRecord: vi.fn().mockResolvedValue({ client: { deleteDnsRecord: vi.fn() } }),
    } as any);
    service.setOperationLeases(new OperationLeaseStore(leaseDb.db));

    const renewal = service.renewCert('cert-1', 'user-1').catch((error: unknown) => error);
    await started.promise;
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ acmeOrderUrl: 'https://acme.test/order/2' }));
    // Another process takes the lease over; the next heartbeat finds out.
    const leaseKey = operationLeaseKey('acme', 'cert:cert-1');
    leaseDb.rows.set(leaseKey, { ...leaseDb.rows.get(leaseKey)!, token: 'replica-2-token' });
    await vi.advanceTimersByTimeAsync(20_000);
    resume.resolve();
    await vi.runAllTimersAsync();

    await expect(renewal).resolves.toMatchObject({
      statusCode: 409,
      code: 'ACME_ORDER_SUPERSEDED',
      details: { leaseLost: true },
    });
    expect(acmeService.requestCertDNS01Verify).not.toHaveBeenCalled();
    // Not recorded as a renewal failure over the new owner's work either.
    expect(set).toHaveBeenCalledTimes(1);
  });

  /** One backend process renewing `httpCert` under a lease whose CA answer the test controls. */
  function leasedRenewal() {
    const leaseDb = createFakeOperationLeaseDb();
    const order = deferred<ReturnType<typeof issued>>();
    const harness = renewalHarness(httpCert, { issue: () => order.promise });
    harness.service.setOperationLeases(new OperationLeaseStore(leaseDb.db));
    const leaseKey = operationLeaseKey('acme', 'cert:cert-1');
    /** Its lease lapsed while the CA answered, and another process claimed the certificate. */
    const takeOver = () =>
      leaseDb.rows.set(leaseKey, { ...leaseDb.rows.get(leaseKey)!, token: 'replica-2-token', holder: 'replica-2:7' });
    return { ...harness, leaseDb, order, takeOver };
  }

  // rc.11 data review F6: the HTTP-01 renewal wrote its certificate by id
  // after another process had taken its lease over.
  it('does not store an HTTP-01 renewal once another process took its lease over', async () => {
    const { service, set, acmeService, order, takeOver } = leasedRenewal();

    const renewal = service.renewCert('cert-1', 'user-1');
    await vi.waitFor(() => expect(acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1));
    takeOver();
    order.resolve(issued());

    await expect(renewal).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACME_ORDER_SUPERSEDED',
      details: { leaseLost: true },
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('records no renewal failure once another process took the lease over', async () => {
    const { service, set, acmeService, order, takeOver } = leasedRenewal();

    const renewal = service.renewCert('cert-1', 'user-1');
    await vi.waitFor(() => expect(acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1));
    takeOver();
    order.reject(new Error('rate limited'));

    await expect(renewal).rejects.toMatchObject({ code: 'ACME_ORDER_SUPERSEDED', details: { leaseLost: true } });
    expect(set).not.toHaveBeenCalled();
  });

  it('records a renewal failure only while the lease is still its own', async () => {
    const { service, set, order } = leasedRenewal();

    const renewal = service.renewCert('cert-1', 'user-1');
    order.reject(new Error('rate limited'));

    await expect(renewal).rejects.toMatchObject({ code: 'RENEWAL_FAILED' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ renewalError: 'Renewal failed: rate limited' }));
  });

  it.each([
    'http-01',
    'dns-01',
  ] as const)('does not store a %s certificate request once another process took its lease over', async (challengeType) => {
    const leaseDb = createFakeOperationLeaseDb();
    const order = deferred<Record<string, unknown>>();
    const insert = vi.fn();
    const db = { insert, query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([]) } } } as any;
    const acmeService = {
      requestCertHTTP01: vi.fn(() => order.promise),
      requestCertDNS01Start: vi.fn(() => order.promise),
    } as any;
    const cryptoService = {
      encryptPrivateKey: vi.fn().mockReturnValue({ encryptedPrivateKey: 'enc', encryptedDek: 'dek', dekIv: 'iv' }),
    } as any;
    const service = new SSLService(
      db,
      acmeService,
      cryptoService,
      { log: vi.fn() } as any,
      { upsertGatewayAsset: vi.fn() } as any
    );
    service.setOperationLeases(new OperationLeaseStore(leaseDb.db));

    const request = service.requestACMECert(
      RequestACMECertSchema.parse({ domains: ['example.com'], challengeType }),
      'user-1',
      'ops@example.com'
    );
    const started = challengeType === 'http-01' ? acmeService.requestCertHTTP01 : acmeService.requestCertDNS01Start;
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    // Another process now issues for the same domains.
    const leaseKey = operationLeaseKey('acme', 'acme-request:example.com');
    leaseDb.rows.set(leaseKey, { ...leaseDb.rows.get(leaseKey)!, token: 'replica-2-token' });
    order.resolve({
      ...issued(),
      accountKey: 'account-key',
      orderUrl: 'https://acme.test/order/1',
      challenges: [{ domain: 'example.com', recordName: '_acme-challenge.example.com', recordValue: 'token' }],
    });

    await expect(request).rejects.toMatchObject({ code: 'ACME_ORDER_SUPERSEDED', details: { leaseLost: true } });
    expect(insert).not.toHaveBeenCalled();
  });

  // rc.11 data review F6: a joined caller compared the lease expiry with its
  // own clock, so a clock running ahead ended its wait on a live operation.
  it('keeps a caller joined from another process waiting while the operation lives by the database clock', async () => {
    let databaseNow = Date.now();
    const leaseDb = createFakeOperationLeaseDb({ now: () => databaseNow });
    const b = renewalHarness(httpCert);
    b.service.setOperationLeases(new OperationLeaseStore(leaseDb.db));
    (b.service as unknown as { acmeJoinPollMs: number }).acmeJoinPollMs = 1;
    const leaseKey = operationLeaseKey('acme', 'cert:cert-1');
    // The same caller's renewal runs on another process, its lease live for a minute.
    leaseDb.rows.set(leaseKey, {
      token: 'replica-1-token',
      holder: 'replica-1:42',
      expiresAt: new Date(databaseNow + 60_000),
      data: { kind: 'renew', actor: 'user-1' },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    // This process's clock runs ten minutes ahead of the database's.
    vi.setSystemTime(databaseNow + 10 * 60_000);

    const joined = b.service.renewCert('cert-1', 'user-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(b.acmeService.requestCertHTTP01).not.toHaveBeenCalled();
    // It claimed once, then only read the lease: its wait did not end early.
    expect(leaseDb.acquired).toHaveLength(1);

    // The other process stopped: its lease lapses by the database clock.
    databaseNow += 61_000;
    await joined;
    expect(b.acmeService.requestCertHTTP01).toHaveBeenCalledTimes(1);
  });
});
