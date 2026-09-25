import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/settings/environment-settings.service.js', () => ({
  getEnvironmentSettingsSnapshot: () => ({ pkiDefaults: { expiryWarningDays: 30, expiryCriticalDays: 7 } }),
}));

import { crossedThreshold, ExpiryAlertJob } from './expiry-alert.job.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2030-06-01T00:00:00.000Z');
const inDays = (days: number) => new Date(now.getTime() + days * DAY_MS);

type Rows = Partial<
  Record<
    | 'sslCertificates'
    | 'certificates'
    | 'certificateAuthorities'
    | 'nodes'
    | 'integrationConnectors'
    | 'gitLabUserCredentials'
    | 'users'
    | 'managedStorageClusters'
    | 'managedDatabaseInstances'
    | 'relayInstances',
    unknown[]
  >
>;

function harness(rows: Rows = {}, existingAlert: unknown = undefined, existingMarkers: string[] = []) {
  const markers = new Set(existingMarkers);
  const insertedMarkers: Array<Record<string, unknown>> = [];
  const table = (name: keyof Rows) => ({
    findMany: vi.fn().mockResolvedValue(rows[name] ?? []),
    findFirst: vi.fn().mockResolvedValue(undefined),
  });
  const db = {
    query: {
      sslCertificates: table('sslCertificates'),
      certificates: table('certificates'),
      certificateAuthorities: table('certificateAuthorities'),
      nodes: table('nodes'),
      integrationConnectors: table('integrationConnectors'),
      gitLabUserCredentials: table('gitLabUserCredentials'),
      users: table('users'),
      managedStorageClusters: table('managedStorageClusters'),
      managedDatabaseInstances: table('managedDatabaseInstances'),
      relayInstances: table('relayInstances'),
      alerts: { findFirst: vi.fn().mockResolvedValue(existingAlert) },
    },
    insert: vi.fn(() => ({
      values: vi.fn((marker: Record<string, unknown>) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            const key = `${marker.resourceType}:${marker.resourceId}:${marker.reason}:${(marker.expiresAt as Date).toISOString()}`;
            if (markers.has(key)) return [];
            markers.add(key);
            insertedMarkers.push(marker);
            return [{ reason: marker.reason }];
          }),
        })),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  };
  const alertService = { createAlert: vi.fn().mockResolvedValue(undefined) };
  const job = new ExpiryAlertJob(db as never, alertService as never);
  return { db, job, alertService, insertedMarkers };
}

describe('crossedThreshold', () => {
  it('returns the tightest threshold that was crossed', () => {
    expect(crossedThreshold(inDays(100), [180, 60, 30, 7], now)).toBe(180);
    expect(crossedThreshold(inDays(45), [180, 60, 30, 7], now)).toBe(60);
    expect(crossedThreshold(inDays(3), [180, 60, 30, 7], now)).toBe(7);
    expect(crossedThreshold(inDays(-2), [30, 7], now)).toBe(7);
    expect(crossedThreshold(inDays(400), [180, 60], now)).toBeNull();
  });
});

describe('ExpiryAlertJob', () => {
  it('keeps warning about SSL certificates whose renewal failed', async () => {
    const { db, job } = harness();

    await job.run(now);

    const query = new PgDialect().sqlToQuery(db.query.sslCertificates.findMany.mock.calls[0]![0].where);
    expect(query.sql).toMatch(/"status" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(query.params).toEqual(expect.arrayContaining(['active', 'error', 'expired']));
  });

  it('explains when a linked internal certificate cannot be reissued automatically', async () => {
    const { job, alertService } = harness({
      sslCertificates: [
        {
          id: 'ssl-1',
          name: 'api',
          type: 'internal',
          notAfter: inDays(20),
          domainNames: ['api.example.com'],
          autoRenew: false,
          renewalError: null,
        },
      ],
    });

    await job.run(now);

    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_warning',
        resourceType: 'ssl_certificate',
        message: expect.stringContaining('issued from a CSR'),
      })
    );
  });

  it('warns about user CAs 180 and 60 days ahead and system CAs two years ahead', async () => {
    const { job, alertService } = harness({
      certificateAuthorities: [
        { id: 'ca-user', commonName: 'Corp Root', notAfter: inDays(150), type: 'root', isSystem: false },
        { id: 'ca-user-far', commonName: 'Far Root', notAfter: inDays(400), type: 'root', isSystem: false },
        {
          id: 'ca-system',
          commonName: 'Gateway Node CA',
          notAfter: inDays(600),
          type: 'root',
          isSystem: true,
          systemPurpose: 'node-mtls',
        },
      ],
    });

    await job.run(now);

    const created = alertService.createAlert.mock.calls.map(([alert]) => alert);
    expect(created).toEqual([
      expect.objectContaining({
        type: 'ca_expiry',
        resourceId: 'ca-user',
        message: expect.stringContaining('Corp Root'),
      }),
      expect.objectContaining({
        type: 'ca_expiry',
        resourceId: 'ca-system',
        message: expect.stringMatching(/System node and relay mTLS CA .*no automatic CA rollover/),
      }),
    ]);
  });

  it('raises each threshold once per validity period, even after the alert row is purged', async () => {
    const ca = { id: 'ca-user', commonName: 'Corp Root', notAfter: inDays(45), type: 'root', isSystem: false };
    const { job, alertService, insertedMarkers } = harness({ certificateAuthorities: [ca] });

    await job.run(now);
    await job.run(now);

    expect(alertService.createAlert).toHaveBeenCalledTimes(1);
    expect(insertedMarkers).toEqual([
      { resourceType: 'certificate_authority', resourceId: 'ca-user', reason: 'expiry:60', expiresAt: ca.notAfter },
    ]);
  });

  it('starts a new period after a renewal', async () => {
    const renewed = { id: 'ca-user', commonName: 'Corp Root', notAfter: inDays(45), type: 'root', isSystem: false };
    const previousEnd = inDays(45 - 365);
    const { job, alertService } = harness({ certificateAuthorities: [renewed] }, undefined, [
      `certificate_authority:ca-user:expiry:60:${previousEnd.toISOString()}`,
    ]);

    await job.run(now);

    expect(alertService.createAlert).toHaveBeenCalledTimes(1);
  });

  it('honors an alert raised before markers existed', async () => {
    const { db, job, alertService } = harness(
      {
        certificateAuthorities: [
          { id: 'ca-user', commonName: 'Corp Root', notAfter: inDays(45), type: 'root', isSystem: false },
        ],
      },
      { id: 'alert-1' }
    );

    await job.run(now);

    expect(alertService.createAlert).not.toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(db.query.alerts.findFirst.mock.calls[0]![0].where);
    // The legacy window starts where the 60-day threshold was crossed, dismissed alerts included.
    expect(query.sql).toContain('"created_at" >=');
    expect(query.sql).not.toContain('"dismissed"');
    expect(query.params).toEqual(expect.arrayContaining([inDays(45 - 60).toISOString()]));
  });

  it('stops reporting resources that expired more than a year ago, at the marker pruning boundary', async () => {
    const { db, job, alertService } = harness({
      integrationConnectors: [
        {
          id: 'gl-old',
          name: 'Old',
          provider: 'gitlab',
          enabled: true,
          authMode: 'token',
          tokenExpiresAt: inDays(-400),
          refreshTokenExpiresAt: null,
        },
      ],
    });

    await job.run(now);

    const windowStart = inDays(-365).toISOString();
    for (const table of [
      db.query.sslCertificates,
      db.query.certificates,
      db.query.nodes,
      db.query.certificateAuthorities,
      db.query.gitLabUserCredentials,
    ]) {
      const query = new PgDialect().sqlToQuery(table.findMany.mock.calls[0]![0].where);
      expect(query.sql).toMatch(/>= \$\d+/);
      expect(query.params).toContain(windowStart);
    }
    // A token that expired 400 days ago is outside the window too.
    expect(alertService.createAlert).not.toHaveBeenCalled();
    const prune = (db.delete.mock.results[0]!.value as { where: ReturnType<typeof vi.fn> }).where.mock.calls[0]![0];
    expect(new PgDialect().sqlToQuery(prune).params).toEqual([windowStart]);
  });

  it('prunes markers of periods that ended a year ago', async () => {
    const { db, job } = harness();

    await job.run(now);

    const where = (db.delete.mock.results[0]!.value as { where: ReturnType<typeof vi.fn> }).where.mock.calls[0]![0];
    const query = new PgDialect().sqlToQuery(where);
    expect(query.sql).toContain('"expiry_alert_markers"."expires_at" <');
    expect(query.params).toEqual([inDays(-365).toISOString()]);
  });

  it('names the resource that owns a system certificate', async () => {
    const { job, alertService } = harness({
      certificates: [
        {
          id: 'leaf-1',
          caId: 'ca-storage',
          commonName: 'managed-storage-3f1c',
          notAfter: inDays(20),
          systemOwnerType: 'managed_storage',
          systemOwnerId: 'storage-1',
          systemLifecycleState: 'current',
        },
        {
          id: 'leaf-node',
          caId: 'ca-node',
          commonName: 'node-1',
          notAfter: inDays(20),
          systemOwnerType: 'node',
          systemOwnerId: 'node-1',
          systemLifecycleState: 'current',
        },
      ],
      managedStorageClusters: [{ id: 'storage-1', name: 'files' }],
    });

    await job.run(now);

    expect(alertService.createAlert).toHaveBeenCalledTimes(1);
    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'certificate',
        resourceId: 'leaf-1',
        message: expect.stringContaining('TLS certificate of managed storage "files"'),
      })
    );
  });

  it('alerts when a node mTLS certificate has less than 30 days left', async () => {
    const { job, alertService } = harness({
      nodes: [
        {
          id: 'node-1',
          hostname: 'edge-1',
          displayName: 'Edge 1',
          status: 'offline',
          certificateExpiresAt: inDays(25),
        },
      ],
    });

    await job.run(now);

    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_warning',
        resourceType: 'node',
        resourceId: 'node-1',
        message: expect.stringContaining('node "Edge 1"'),
      })
    );
  });

  it('alerts on expiring Git tokens at 30 and 7 days', async () => {
    const { job, alertService } = harness({
      integrationConnectors: [
        {
          id: 'gl-1',
          name: 'GitLab',
          provider: 'gitlab',
          enabled: true,
          authMode: 'token',
          tokenExpiresAt: inDays(20),
          refreshTokenExpiresAt: null,
        },
        {
          id: 'gh-1',
          name: 'GitHub',
          provider: 'github',
          enabled: true,
          authMode: 'oauth',
          tokenExpiresAt: inDays(0.1),
          refreshTokenExpiresAt: inDays(200),
        },
      ],
      gitLabUserCredentials: [
        {
          id: 'cred-1',
          userId: 'user-1',
          connectorId: 'gl-1',
          gitlabUsername: 'alice',
          tokenExpiresAt: inDays(5),
        },
      ],
      users: [{ id: 'user-1', email: 'alice@example.com' }],
    });

    await job.run(now);

    const created = alertService.createAlert.mock.calls.map(([alert]) => alert);
    expect(created).toEqual([
      expect.objectContaining({ type: 'expiry_warning', resourceType: 'integration_connector', resourceId: 'gl-1' }),
      expect.objectContaining({
        type: 'expiry_critical',
        resourceType: 'gitlab_user_credential',
        resourceId: 'cred-1',
        message: expect.stringContaining('alice@example.com'),
      }),
    ]);
  });

  it('waits for an overdue renewal before alerting on a node daemon older than rc.9', async () => {
    const node = (days: number, daemonVersion: string) => ({
      id: `node-${daemonVersion}-${days}`,
      hostname: 'edge-1',
      displayName: null,
      status: 'online',
      certificateExpiresAt: inDays(days),
      daemonVersion,
    });
    const { job, alertService } = harness({
      nodes: [node(20, '2.11.0-rc.8'), node(2, '2.10.4'), node(20, '2.11.0-rc.9'), node(20, 'dev')],
    });

    await job.run(now);

    const created = alertService.createAlert.mock.calls.map(([alert]) => alert);
    expect(created.map((alert) => alert.resourceId)).toEqual(['node-2.10.4-2', 'node-2.11.0-rc.9-20', 'node-dev-20']);
    expect(created[0]).toMatchObject({
      type: 'expiry_critical',
      message: expect.stringContaining('Update the node daemon'),
    });
  });

  it('skips expiry alerts for Git tokens that rotate themselves, and raises maintenance alerts once', async () => {
    const { job, alertService } = harness({
      integrationConnectors: [
        {
          id: 'gl-auto',
          name: 'Auto',
          provider: 'gitlab',
          enabled: true,
          authMode: 'token',
          tokenExpiresAt: inDays(20),
          refreshTokenExpiresAt: null,
        },
        {
          id: 'gl-manual',
          name: 'Manual',
          provider: 'gitlab',
          enabled: true,
          authMode: 'token',
          tokenExpiresAt: inDays(20),
          refreshTokenExpiresAt: null,
        },
      ],
    });
    job.setGitTokenMaintenance(async () => ({
      autoRotating: ['integration_connector:gl-auto'],
      alerts: [
        {
          severity: 'critical',
          resourceType: 'integration_connector',
          resourceId: 'gl-lost',
          reason: 'git:rotation-lost',
          expiresAt: inDays(10),
          message: 'Re-authorize now',
        },
      ],
    }));

    await job.run(now);
    await job.run(now);

    const created = alertService.createAlert.mock.calls.map(([alert]) => alert);
    expect(created).toEqual([
      expect.objectContaining({ type: 'expiry_critical', resourceId: 'gl-lost', message: 'Re-authorize now' }),
      expect.objectContaining({ type: 'expiry_warning', resourceId: 'gl-manual' }),
    ]);
  });

  it('rotates Git tokens before alerting and tolerates editions without GitLab', async () => {
    const { job } = harness();
    const order: string[] = [];
    job.setGitTokenMaintenance(async () => {
      order.push('maintenance');
      throw Object.assign(new Error('unavailable'), { code: 'COMMERCIAL_MODULE_UNAVAILABLE' });
    });

    await expect(job.run(now)).resolves.toBeUndefined();
    expect(order).toEqual(['maintenance']);
  });

  it('keeps checking other sources when one query fails', async () => {
    const { db, job, alertService } = harness({
      nodes: [
        { id: 'node-1', hostname: 'edge-1', displayName: null, status: 'online', certificateExpiresAt: inDays(3) },
      ],
    });
    db.query.sslCertificates.findMany.mockRejectedValue(new Error('db hiccup'));

    await job.run(now);

    expect(alertService.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'expiry_critical', resourceType: 'node' })
    );
  });
});
