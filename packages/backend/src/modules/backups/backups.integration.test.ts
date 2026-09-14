import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema/index.js';
import { assertStorageHasNoBackupReferences } from '@/modules/object-storage/storage-backup-references.js';
import { CryptoService } from '@/services/crypto.service.js';
import { BackupService } from './backups.service.js';

const url = process.env.GATEWAY_BACKUP_TEST_DATABASE_URL;
describe.skipIf(!url)('backup controller on disposable PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids = {
    group: randomUUID(),
    user: randomUUID(),
    source: randomUUID(),
    target: randomUUID(),
    node: randomUUID(),
  };
  const crypto = new CryptoService('ab'.repeat(32));
  const intervals = new Map<string, () => Promise<unknown>>();
  const states = new Map<string, { status: string; phase: string; manifest?: schema.BackupManifest }>();
  const calls: Array<{ action: string; runId: string; payload: Record<string, any> }> = [];
  let revoked = false;
  let loseStartResponse = false;
  const check = async () => {
    if (revoked) throw new Error('revoked');
  };
  const cleanup = vi.fn();
  const deleted = vi.fn();
  const dispatch = {
    sendDockerBackupCommand: vi.fn(async (_node: string, action: string, runId: string, raw: string) => {
      const payload = raw ? JSON.parse(raw) : {};
      calls.push({ action, runId, payload });
      if (action === 'start' && loseStartResponse) {
        loseStartResponse = false;
        states.set(runId, { status: 'queued', phase: 'preflight_complete' });
        throw new Error('transport timeout');
      }
      if (action === 'start') states.set(runId, { status: 'running', phase: 'dump' });
      if (action === 'cancel') states.set(runId, { status: 'cancelled', phase: 'cancelled' });
      return {
        success: true,
        detail: JSON.stringify(states.get(runId) ?? { status: 'queued', phase: 'preflight_complete' }),
      };
    }),
  };
  const service = new BackupService(
    db,
    { log: vi.fn() } as never,
    crypto,
    dispatch,
    {
      getBackupTarget: async () => ({
        connectionId: ids.target,
        provider: 'other',
        endpoint: 'https://storage.example.test',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      }),
      deleteOwnedBackupArtifacts: deleted,
    },
    { assertSource: check, assertDestination: check, assertExecutor: check, assertScheduledActor: check },
    { registerInterval: (name: string, _ms: number, fn: () => Promise<unknown>) => intervals.set(name, fn) } as never,
    { get: () => `registry.example.test/runner@sha256:${'a'.repeat(64)}`, getRedisStage: () => undefined },
    { cleanupRuntime: cleanup }
  );
  const input = {
    destinationId: ids.target,
    bucket: 'backups',
    prefix: 'database',
    executorNodeId: ids.node,
    schedule: null,
    timezone: 'UTC',
    retentionCount: 1,
    limits: { workspaceBytes: 1024 ** 3, timeoutSeconds: 60, cpuCores: 1, memoryMb: 512 },
  };
  beforeAll(async () => {
    await db.insert(schema.permissionGroups).values({ id: ids.group, name: `backup-test-${ids.group}` });
    await db
      .insert(schema.users)
      .values({ id: ids.user, email: `${ids.user}@example.test`, name: 'Backup test', groupId: ids.group });
    await db.insert(schema.nodes).values({
      id: ids.node,
      type: 'storage',
      hostname: 'backup-test',
      slug: `backup-${ids.node.slice(0, 8)}`,
      status: 'online',
    });
    await db.insert(schema.databaseConnections).values({
      id: ids.source,
      name: 'Backup source',
      slug: `source-${ids.source.slice(0, 8)}`,
      type: 'postgres',
      host: 'db.example.test',
      port: 5432,
      databaseName: 'app',
      createdById: ids.user,
      encryptedConfig: JSON.stringify(
        crypto.encryptString(
          JSON.stringify({
            type: 'postgres',
            host: 'db.example.test',
            port: 5432,
            database: 'app',
            username: 'test',
            password: 'test-only',
          })
        )
      ),
    });
    await db.insert(schema.objectStorageConnections).values({
      id: ids.target,
      name: 'Backup target',
      slug: `target-${ids.target.slice(0, 8)}`,
      provider: 'other',
      encryptedConfig: 'test-only',
      createdById: ids.user,
    });
    service.registerScheduler();
  });
  afterAll(async () => {
    await db.delete(schema.backupRunNodeLeases).where(eq(schema.backupRunNodeLeases.executorNodeId, ids.node));
    await db.delete(schema.backupRuns).where(eq(schema.backupRuns.databaseConnectionId, ids.source));
    await db.delete(schema.backupPolicies).where(eq(schema.backupPolicies.databaseConnectionId, ids.source));
    await db.delete(schema.databaseConnections).where(eq(schema.databaseConnections.id, ids.source));
    await db.delete(schema.objectStorageConnections).where(eq(schema.objectStorageConnections.id, ids.target));
    await db.delete(schema.nodes).where(eq(schema.nodes.id, ids.node));
    await db.delete(schema.users).where(eq(schema.users.id, ids.user));
    await db.delete(schema.permissionGroups).where(eq(schema.permissionGroups.id, ids.group));
    await pool.end();
  });
  it('snapshots destination, rejects overlapping executors, reconciles cancellation and releases its lease', async () => {
    const policy = await service.createPolicy(ids.source, input, ids.user);
    const run = await service.startBackup(ids.source, policy.id, ids.user);
    expect(calls.find((x) => x.action === 'start' && x.runId === run.id)?.payload.destination).toMatchObject({
      connectionId: ids.target,
      bucket: 'backups',
      prefix: 'database',
    });
    await expect(service.startBackup(ids.source, policy.id, ids.user)).rejects.toMatchObject({
      code: 'BACKUP_EXECUTOR_BUSY',
    });
    await service.cancel(ids.source, run.id, ids.user);
    expect((await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id)))[0]?.status).toBe(
      'running'
    );
    await service.reconcileActiveRuns();
    expect((await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id)))[0]?.status).toBe(
      'cancelled'
    );
    expect(
      await db.select().from(schema.backupRunNodeLeases).where(eq(schema.backupRunNodeLeases.executorNodeId, ids.node))
    ).toHaveLength(0);
    expect(cleanup).toHaveBeenCalledWith(run.id);
    await expect(assertStorageHasNoBackupReferences(db, ids.target)).rejects.toMatchObject({
      code: 'STORAGE_REFERENCED_BY_BACKUPS',
    });
  });
  it('retains the lease after a lost start response and replays the encrypted immutable request', async () => {
    const policy = await service.createPolicy(ids.source, input, ids.user);
    loseStartResponse = true;
    const run = await service.startBackup(ids.source, policy.id, ids.user);
    const [pending] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id));
    expect(pending?.phase).toBe('awaiting_runner');
    expect(pending?.encryptedRuntimePayload).toBeTruthy();
    expect(pending?.encryptedRuntimePayload).not.toContain('test-only');
    expect((await service.listRuns(ids.source)).find((x) => x.id === run.id)).not.toHaveProperty(
      'encryptedRuntimePayload'
    );
    await expect(service.startBackup(ids.source, policy.id, ids.user)).rejects.toMatchObject({
      code: 'BACKUP_EXECUTOR_BUSY',
    });
    await service.reconcileActiveRuns();
    const starts = calls.filter((x) => x.action === 'start' && x.runId === run.id);
    expect(starts).toHaveLength(2);
    expect(starts[0]?.payload).toEqual(starts[1]?.payload);
    expect((await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id)))[0]?.phase).toBe('dump');
    states.set(run.id, { status: 'failed', phase: 'test_finished' });
    await service.reconcileActiveRuns();
    expect(
      (await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id)))[0]?.encryptedRuntimePayload
    ).toBeNull();
  });
  it('rejects a completed artifact outside the immutable destination ownership boundary', async () => {
    const policy = await service.createPolicy(ids.source, input, ids.user);
    const run = await service.startBackup(ids.source, policy.id, ids.user);
    states.set(run.id, {
      status: 'completed',
      phase: 'completed',
      manifest: {
        version: 1,
        engine: 'postgres',
        engineVersion: '18.6',
        sourceIdentity: ids.source,
        ownedPrefix: 'someone-else',
        artifactKeys: ['someone-else/database.dump'],
        sizes: { 'someone-else/database.dump': 10 },
        fileChecksums: { 'someone-else/database.dump': 'a'.repeat(64) },
        manifestSha256: 'b'.repeat(64),
      },
    });
    await service.reconcileActiveRuns();
    const [result] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id));
    expect(result).toMatchObject({ status: 'failed', phase: 'manifest_invalid', manifest: null });
    expect(deleted).not.toHaveBeenCalled();
    expect(
      await db.select().from(schema.backupRunNodeLeases).where(eq(schema.backupRunNodeLeases.executorNodeId, ids.node))
    ).toHaveLength(0);
  });
  it('reclaims an exact orphan lease after terminal daemon confirmation', async () => {
    const policy = await service.createPolicy(ids.source, input, ids.user);
    const run = await service.startBackup(ids.source, policy.id, ids.user);
    states.set(run.id, { status: 'failed', phase: 'test_finished' });
    await service.reconcileActiveRuns();
    await db
      .insert(schema.backupRunNodeLeases)
      .values({ executorNodeId: ids.node, runId: run.id, expiresAt: new Date(0) });
    const next = await service.startBackup(ids.source, policy.id, ids.user);
    expect(next.id).not.toBe(run.id);
    expect(
      (
        await db
          .select()
          .from(schema.backupRunNodeLeases)
          .where(eq(schema.backupRunNodeLeases.executorNodeId, ids.node))
      )[0]?.runId
    ).toBe(next.id);
    states.set(next.id, { status: 'failed', phase: 'test_finished' });
    await service.reconcileActiveRuns();
  });
  it('revalidates a revoked actor before dispatch and rejects unsafe prefixes', async () => {
    revoked = true;
    const before = calls.length;
    await expect(service.createPolicy(ids.source, input, ids.user)).rejects.toThrow('revoked');
    expect(calls).toHaveLength(before);
    revoked = false;
    await expect(
      service.createPolicy(ids.source, { ...input, prefix: 'safe\n!cat /run/gateway-backup/config.json' }, ids.user)
    ).rejects.toMatchObject({ code: 'BACKUP_DESTINATION_INVALID' });
  });
  it('runs scheduled policies at a nonzero second and deduplicates the same cron minute', async () => {
    const policy = await service.createPolicy(ids.source, { ...input, schedule: '* * * * *' }, ids.user);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-12T12:34:37Z'));
    try {
      await intervals.get('database-backups-schedule')!();
      await intervals.get('database-backups-schedule')!();
    } finally {
      vi.useRealTimers();
    }
    const runs = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.policyId, policy.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('running');
    states.set(runs[0]!.id, { status: 'failed', phase: 'test_finished' });
    await service.reconcileActiveRuns();
  });
});
