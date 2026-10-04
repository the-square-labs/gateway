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
          openedTotal: '120',
          sourceToTargetBytes: '4096',
          targetToSourceBytes: '65536',
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
          openedTotal: 120,
          sourceToTargetBytes: 4096,
          targetToSourceBytes: 65536,
          completedTotal: 0,
        },
        {
          ownerKind: 'managed_storage_binding',
          ownerId: 'binding-2',
          activeConnections: 0,
          connectionLimit: 64,
          rejectedTotal: 0,
          lastRejectionReason: null,
          lastRejectedAt: null,
          openedTotal: 0,
          sourceToTargetBytes: 0,
          targetToSourceBytes: 0,
          completedTotal: 0,
        },
      ],
    });
    expect(
      managedLinkHealth([
        {
          ownerKind: 'container_link',
          ownerId: 'link-1',
          activeConnections: 2,
          openedTotal: '9',
          sourceToTargetBytes: '10',
          targetToSourceBytes: '20',
        },
      ]).managedLinks?.[0]
    ).toMatchObject({
      ownerKind: 'container_link',
      activeConnections: 2,
      openedTotal: 9,
      sourceToTargetBytes: 10,
      targetToSourceBytes: 20,
    });
    expect(
      managedLinkHealth([{ ownerKind: 'container_link', ownerId: 'link-1', completedTotal: '5' }]).managedLinks?.[0]
    ).toMatchObject({
      completedTotal: 5,
    });
    expect(managedLinkHealth(undefined)).toEqual({});
    expect(managedLinkHealth([])).toEqual({});
  });
});
