import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { ACMERenewalJob } from './acme-renewal.job.js';

function createDb(certs: unknown[]) {
  return {
    query: {
      sslCertificates: {
        findMany: vi.fn().mockResolvedValue(certs),
      },
    },
  };
}

describe('ACMERenewalJob', () => {
  it('attempts automatic renewal for DNS-01 certificates', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      autoRenewProvider: 'cloudflare',
      acmeChallengeType: 'dns-01',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const db = createDb([cert]);
    const sslService = {
      renewCert: vi.fn().mockResolvedValue({ id: 'cert-1', status: 'active' }),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(db as never, sslService as never, alertService as never);

    await job.run();

    expect(sslService.renewCert).toHaveBeenCalledWith('cert-1', '00000000-0000-0000-0000-000000000000');
    expect(alertService.createAlert).not.toHaveBeenCalled();
  });

  it('alerts when DNS-01 renewal still needs manual verification', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      autoRenewProvider: 'cloudflare',
      acmeChallengeType: 'dns-01',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const db = createDb([cert]);
    const sslService = {
      renewCert: vi.fn().mockResolvedValue({ id: 'cert-1', status: 'pending' }),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(db as never, sslService as never, alertService as never);

    await job.run();

    expect(sslService.renewCert).toHaveBeenCalledWith('cert-1', '00000000-0000-0000-0000-000000000000');
    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_warning',
        resourceType: 'ssl_certificate',
        resourceId: 'cert-1',
      })
    );
  });

  it('does not start a new order for certificates already pending DNS-01 renewal', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      acmeChallengeType: 'dns-01',
      acmePendingOperation: 'renewal',
      acmePendingChallenges: [
        {
          domain: 'example.com',
          recordName: '_acme-challenge.example.com',
          recordValue: 'challenge-token',
        },
      ],
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const db = createDb([cert]);
    const sslService = {
      renewCert: vi.fn(),
      completeDNS01Verification: vi.fn(),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(db as never, sslService as never, alertService as never);

    await job.run();

    expect(db.query.sslCertificates.findMany).toHaveBeenCalled();
    expect(sslService.renewCert).not.toHaveBeenCalled();
    expect(sslService.completeDNS01Verification).not.toHaveBeenCalled();
    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_warning',
        resourceType: 'ssl_certificate',
        resourceId: 'cert-1',
      })
    );
  });

  it('alerts instead of renewing unmanaged DNS-01 certificates', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      acmeChallengeType: 'dns-01',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const db = createDb([cert]);
    const sslService = {
      renewCert: vi.fn(),
      completeDNS01Verification: vi.fn(),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(db as never, sslService as never, alertService as never);

    await job.run();

    expect(sslService.renewCert).not.toHaveBeenCalled();
    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_warning',
        resourceType: 'ssl_certificate',
        resourceId: 'cert-1',
      })
    );
  });

  it('completes pending Cloudflare DNS-01 renewals instead of starting a new order', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      acmeChallengeType: 'dns-01',
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
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const db = createDb([cert]);
    const sslService = {
      renewCert: vi.fn(),
      completeDNS01Verification: vi.fn().mockResolvedValue({ id: 'cert-1', status: 'active' }),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(db as never, sslService as never, alertService as never);

    await job.run();

    expect(sslService.renewCert).not.toHaveBeenCalled();
    expect(sslService.completeDNS01Verification).toHaveBeenCalledWith(
      'cert-1',
      '00000000-0000-0000-0000-000000000000',
      {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      }
    );
    expect(alertService.createAlert).not.toHaveBeenCalled();
  });
});

describe('ACMERenewalJob recovery', () => {
  it('selects still-valid rows stuck in error and expired rows, not only active ones', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const db = createDb([]);
    const job = new ACMERenewalJob(db as never, { renewCert: vi.fn() } as never, { createAlert: vi.fn() } as never);

    await job.run();

    const where = db.query.sslCertificates.findMany.mock.calls[0]![0].where;
    const query = new PgDialect().sqlToQuery(where);
    expect(query.sql).toMatch(/"status" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(query.params).toEqual(expect.arrayContaining(['active', 'error', 'expired']));
  });

  it('alerts when a renewed certificate did not reach every proxy host', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      acmeChallengeType: 'http-01',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const sslService = {
      renewCert: vi.fn().mockResolvedValue({
        id: 'cert-1',
        status: 'active',
        renewalError: 'Distribution incomplete: 1 proxy host(s) did not receive the current certificate (offline)',
      }),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(createDb([cert]) as never, sslService as never, alertService as never);

    await job.run();

    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_warning',
        resourceId: 'cert-1',
        message: expect.stringContaining('was renewed, but not every proxy host received it'),
      })
    );
  });

  it.each([
    ['ACME_OPERATION_IN_PROGRESS', 'An ACME renew is already running for this certificate'],
    ['ACME_ORDER_SUPERSEDED', 'The certificate or its ACME order changed while the renewal was starting'],
    ['SSL_CERT_DELETED', 'The certificate was deleted while it was being renewed'],
  ])('skips a certificate another operation owns (%s) without a failure alert', async (code, message) => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      acmeChallengeType: 'http-01',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const sslService = { renewCert: vi.fn().mockRejectedValue(new AppError(409, code, message)) };
    const alertService = { createAlert: vi.fn() };
    const eventBus = { publish: vi.fn() };
    const job = new ACMERenewalJob(createDb([cert]) as never, sslService as never, alertService as never);
    job.setEventBus(eventBus as never);

    await job.run();

    expect(sslService.renewCert).toHaveBeenCalledOnce();
    expect(alertService.createAlert).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('still alerts on a real renewal failure', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      type: 'acme',
      status: 'active',
      autoRenew: true,
      acmeChallengeType: 'http-01',
      domainNames: ['example.com'],
      notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };
    const sslService = {
      renewCert: vi
        .fn()
        .mockRejectedValue(new AppError(500, 'RENEWAL_FAILED', 'Certificate renewal failed: rate limited')),
    };
    const alertService = { createAlert: vi.fn() };
    const job = new ACMERenewalJob(createDb([cert]) as never, sslService as never, alertService as never);

    await job.run();

    expect(alertService.createAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'expiry_critical' }));
  });
});
