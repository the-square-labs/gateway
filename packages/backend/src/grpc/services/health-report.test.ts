import { describe, expect, it } from 'vitest';
import { managedLinkHealth } from './health-report.js';

describe('managedLinkHealth', () => {
  it('decodes the managed links a docker daemon reports and leaves the field out without any', () => {
    expect(
      managedLinkHealth([
        {
          ownerKind: 'managed_database_binding',
          ownerId: 'binding-1',
          activeConnections: 64,
          connectionLimit: 64,
          rejectedTotal: '6',
          lastRejectionReason: 'link_limit',
          lastRejectedAtUnixMs: '1790935200000',
        },
        {
          ownerKind: 'managed_storage_binding',
          ownerId: 'binding-2',
          activeConnections: 0,
          connectionLimit: 64,
          rejectedTotal: '0',
          lastRejectionReason: '',
          lastRejectedAtUnixMs: '0',
        },
        { ownerKind: 'proxy_host_secure_link', ownerId: 'link-1', activeConnections: 3 },
      ])
    ).toEqual({
      managedLinks: [
        {
          ownerKind: 'managed_database_binding',
          ownerId: 'binding-1',
          activeConnections: 64,
          connectionLimit: 64,
          rejectedTotal: 6,
          lastRejectionReason: 'link_limit',
          lastRejectedAt: '2026-10-02T10:00:00.000Z',
        },
        {
          ownerKind: 'managed_storage_binding',
          ownerId: 'binding-2',
          activeConnections: 0,
          connectionLimit: 64,
          rejectedTotal: 0,
          lastRejectionReason: null,
          lastRejectedAt: null,
        },
      ],
    });
    expect(managedLinkHealth(undefined)).toEqual({});
    expect(managedLinkHealth([])).toEqual({});
  });
});
