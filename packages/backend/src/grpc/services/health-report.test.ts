import { describe, expect, it } from 'vitest';
import { managedLinkHealth, relayStreamHealth, updateConnectionsHealth } from './health-report.js';

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

describe('relayStreamHealth', () => {
  it('decodes the relay stream sessions a daemon reports and leaves the field out without them', () => {
    expect(relayStreamHealth(undefined)).toEqual({});
    expect(
      relayStreamHealth({
        resumableSessions: '12',
        legacySessions: 1,
        migrationsOkTotal: '40',
        cutTotal: '2',
        migrationStallP95Ms: 35,
        byRelay: [
          { relayInstanceId: 'relay-1', resumable: '12', legacy: '1' },
          { relayInstanceId: '', resumable: 3 },
        ],
      })
    ).toEqual({
      relayStreams: {
        resumableSessions: 12,
        legacySessions: 1,
        suspendedSessions: 0,
        migrationsOkTotal: 40,
        migrationsFailedTotal: 0,
        cutTotal: 2,
        retransmittedBytesTotal: 0,
        unackedBytes: 0,
        migrationStallP50Ms: 0,
        migrationStallP95Ms: 35,
        resumeRefusedTotal: 0,
        byRelay: [{ relayInstanceId: 'relay-1', resumable: 12, legacy: 1 }],
      },
    });
  });
});

describe('updateConnectionsHealth', () => {
  it('decodes what an update keeps and cuts, with the last update once it is final', () => {
    // proto-loader with defaults: an absent message is null.
    expect(updateConnectionsHealth(null)).toEqual({});
    expect(
      updateConnectionsHealth({
        handoverAvailable: true,
        kept: 40,
        cut: { raw_stream: 2, registry: 0 },
        lastUpdate: {
          fromVersion: 'v2.12.0',
          toVersion: 'v2.12.1',
          startedAtUnixMs: '1800000000000',
          finishedAtUnixMs: '1800000004000',
          handover: true,
          handedOver: 38,
          kept: 37,
          cut: { resume_failed: 1 },
          pauseP50Ms: 900,
          pauseP99Ms: 1800,
          pauseMaxMs: 2100,
        },
      })
    ).toEqual({
      updateConnections: {
        handoverAvailable: true,
        kept: 40,
        cut: { raw_stream: 2 },
        lastUpdate: {
          fromVersion: 'v2.12.0',
          toVersion: 'v2.12.1',
          startedAtUnixMs: 1_800_000_000_000,
          finishedAtUnixMs: 1_800_000_004_000,
          handover: true,
          handedOver: 38,
          kept: 37,
          cut: { resume_failed: 1 },
          pauseP50Ms: 900,
          pauseP99Ms: 1800,
          pauseMaxMs: 2100,
        },
      },
    });
    // A last update without counts yet (defaults) is left out.
    expect(
      updateConnectionsHealth({
        handoverAvailable: false,
        kept: 0,
        cut: {},
        lastUpdate: { toVersion: '', finishedAtUnixMs: '0' },
      })
    ).toEqual({ updateConnections: { handoverAvailable: false, kept: 0, cut: {} } });
  });
});
