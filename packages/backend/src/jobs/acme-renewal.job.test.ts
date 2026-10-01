import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { ACMERenewalJob } from './acme-renewal.job.js';

const DAY = 24 * 60 * 60 * 1000;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function createDb(certs: unknown[]) {
  return {
    query: {
      sslCertificates: {
        findMany: vi.fn().mockResolvedValue(certs),
      },
    },
  };
}

function cert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cert-1',
    name: 'example.com',
    type: 'acme',
    status: 'active',
    autoRenew: true,
    acmeChallengeType: 'http-01',
    domainNames: ['example.com'],
    notAfter: new Date(Date.now() + 5 * DAY),
    ...overrides,
  };
}

function job(certs: unknown[], sslService: Record<string, unknown>) {
  const db = createDb(certs);
  const alertService = { createAlert: vi.fn() };
  return { job: new ACMERenewalJob(db as never, sslService as never, alertService as never), db, alertService };
}

describe('ACMERenewalJob', () => {
  // The renewal window and the retry of failed or lapsed certificates live in the selection.
  it('selects certificates inside the 30-day window, including ones a failed renewal left in error or expired', async () => {
    const { job: renewal, db } = job([], { renewCert: vi.fn() });
    const before = Date.now();

    await renewal.run();

    const where = db.query.sslCertificates.findMany.mock.calls[0]![0].where;
    const query = new PgDialect().sqlToQuery(where);
    expect(query.params).toEqual(expect.arrayContaining(['active', 'error', 'expired']));
    const threshold = query.params.map((value) => Date.parse(String(value))).find((value) => !Number.isNaN(value));
    expect(threshold).toBeGreaterThanOrEqual(before + 29 * DAY);
    expect(threshold).toBeLessThanOrEqual(Date.now() + 31 * DAY);
  });

  it('renews a due HTTP-01 certificate', async () => {
    const sslService = { renewCert: vi.fn().mockResolvedValue({ id: 'cert-1', status: 'active' }) };
    const { job: renewal, alertService } = job([cert()], sslService);

    await renewal.run();

    expect(sslService.renewCert).toHaveBeenCalledWith('cert-1', SYSTEM_USER_ID);
    expect(alertService.createAlert).not.toHaveBeenCalled();
  });

  it('renews DNS-01 certificates through Cloudflare and alerts when one still needs manual verification', async () => {
    const sslService = { renewCert: vi.fn().mockResolvedValue({ id: 'cert-1', status: 'active' }) };
    const managed = job([cert({ acmeChallengeType: 'dns-01', autoRenewProvider: 'cloudflare' })], sslService);
    await managed.job.run();
    expect(sslService.renewCert).toHaveBeenCalledWith('cert-1', SYSTEM_USER_ID);
    expect(managed.alertService.createAlert).not.toHaveBeenCalled();

    sslService.renewCert.mockResolvedValue({ id: 'cert-1', status: 'pending' });
    const pending = job([cert({ acmeChallengeType: 'dns-01', autoRenewProvider: 'cloudflare' })], sslService);
    await pending.job.run();
    expect(pending.alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'expiry_warning', resourceType: 'ssl_certificate', resourceId: 'cert-1' })
    );
  });

  it('alerts instead of silently skipping a DNS-01 certificate it cannot renew', async () => {
    const sslService = { renewCert: vi.fn(), completeDNS01Verification: vi.fn() };
    const unmanaged = job([cert({ acmeChallengeType: 'dns-01' })], sslService);
    await unmanaged.job.run();

    const awaitingManual = job(
      [
        cert({
          acmeChallengeType: 'dns-01',
          acmePendingOperation: 'renewal',
          acmePendingChallenges: [
            { domain: 'example.com', recordName: '_acme-challenge.example.com', recordValue: 'challenge-token' },
          ],
        }),
      ],
      sslService
    );
    await awaitingManual.job.run();

    expect(sslService.renewCert).not.toHaveBeenCalled();
    expect(sslService.completeDNS01Verification).not.toHaveBeenCalled();
    for (const { alertService } of [unmanaged, awaitingManual]) {
      expect(alertService.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'expiry_warning', resourceType: 'ssl_certificate', resourceId: 'cert-1' })
      );
    }
  });

  it('completes a pending Cloudflare DNS-01 renewal instead of starting a new order', async () => {
    const sslService = {
      renewCert: vi.fn(),
      completeDNS01Verification: vi.fn().mockResolvedValue({ id: 'cert-1', status: 'active' }),
    };
    const { job: renewal, alertService } = job(
      [
        cert({
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
        }),
      ],
      sslService
    );

    await renewal.run();

    expect(sslService.renewCert).not.toHaveBeenCalled();
    expect(sslService.completeDNS01Verification).toHaveBeenCalledWith('cert-1', SYSTEM_USER_ID, {
      cleanupCloudflare: true,
      clearPendingOnFailure: true,
    });
    expect(alertService.createAlert).not.toHaveBeenCalled();
  });

  it('alerts when a renewed certificate did not reach every proxy host', async () => {
    const sslService = {
      renewCert: vi.fn().mockResolvedValue({
        id: 'cert-1',
        status: 'active',
        renewalError: 'Distribution incomplete: 1 proxy host(s) did not receive the current certificate (offline)',
      }),
    };
    const { job: renewal, alertService } = job([cert()], sslService);

    await renewal.run();

    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'expiry_warning', resourceId: 'cert-1' })
    );
  });

  it('alerts on a failed renewal and still renews the next certificate', async () => {
    const sslService = {
      renewCert: vi
        .fn()
        .mockRejectedValueOnce(new AppError(500, 'RENEWAL_FAILED', 'Certificate renewal failed: rate limited'))
        .mockResolvedValue({ id: 'cert-2', status: 'active' }),
    };
    const { job: renewal, alertService } = job([cert(), cert({ id: 'cert-2', name: 'other.example.com' })], sslService);

    await renewal.run();

    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'expiry_critical', resourceId: 'cert-1' })
    );
    expect(sslService.renewCert).toHaveBeenLastCalledWith('cert-2', SYSTEM_USER_ID);
  });
});
