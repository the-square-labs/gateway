import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
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
    const db = {
      query: {
        sslCertificates: {
          findFirst: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'Pages', domainNames: ['*.pages.test'] }),
        },
        proxyHosts: { findMany: vi.fn().mockResolvedValue([]) },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: 'default' }]) })),
        })),
      })),
    } as any;
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

function selectChain(results: unknown[][]) {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy']) chain[method] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => queue.shift() ?? []);
  return vi.fn(() => chain);
}

function renewalHarness(
  cert: Record<string, unknown>,
  options: { selectResults?: unknown[][]; issue?: () => Promise<unknown> } = {}
) {
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
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
