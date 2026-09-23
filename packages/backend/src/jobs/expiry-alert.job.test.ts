import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/settings/environment-settings.service.js', () => ({
  getEnvironmentSettingsSnapshot: () => ({ pkiDefaults: { expiryWarningDays: 30, expiryCriticalDays: 7 } }),
}));

import { ExpiryAlertJob } from './expiry-alert.job.js';

describe('ExpiryAlertJob', () => {
  it('keeps warning about SSL certificates whose renewal failed', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      query: {
        sslCertificates: { findMany },
        certificates: { findMany: vi.fn().mockResolvedValue([]) },
        certificateAuthorities: { findMany: vi.fn().mockResolvedValue([]) },
      },
    };
    const job = new ExpiryAlertJob(db as never, { createAlert: vi.fn() } as never);

    await job.run();

    const query = new PgDialect().sqlToQuery(findMany.mock.calls[0]![0].where);
    expect(query.sql).toMatch(/"status" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(query.params).toEqual(expect.arrayContaining(['active', 'error', 'expired']));
  });
});
