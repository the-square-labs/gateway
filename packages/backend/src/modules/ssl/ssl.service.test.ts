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
    const update = vi.fn();
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

    expect(update).not.toHaveBeenCalled();
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
