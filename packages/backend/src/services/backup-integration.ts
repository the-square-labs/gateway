import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { backupRuns, databaseConnections, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type {
  BackupDestination,
  BackupRuntimeConnection,
  StorageBackupTargetConfig,
} from '@/modules/backups/backups.types.js';
import { CreateManagedDatabaseSchema } from '@/modules/databases/databases.schemas.js';
import {
  MANAGED_DATABASE_CATALOG,
  type ManagedDatabaseService,
} from '@/modules/databases/managed-databases.service.js';
import type { CryptoService } from './crypto.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';
import type { StorageCAService } from './storage-ca.service.js';

/** Resolves stored credentials and per-run relay authority inside the control plane. */
export class BackupRuntimeIntegration {
  constructor(
    private db: DrizzleClient,
    private crypto: CryptoService,
    private relay: RelayPolicyService | undefined,
    private storageCA: StorageCAService,
    private managedDatabases: ManagedDatabaseService
  ) {}

  async assertScope(userId: string, scope: string, id?: string) {
    const user = await resolveLiveUser(this.db, userId);
    if (!user || user.isBlocked || !(id ? hasScopeForResource(user.scopes, scope, id) : hasScope(user.scopes, scope)))
      throw new AppError(403, 'BACKUP_ACCESS_DENIED', `Backup requires ${scope}`);
  }

  async prepareConnectionForExecutor(
    runId: string,
    executorNodeId: string,
    connectionId: string,
    purpose: 'backup' | 'restore'
  ) {
    const [row] = await this.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connectionId))
      .limit(1);
    const [managed] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, connectionId))
      .limit(1);
    if (!row || !managed || managed.status !== 'ready')
      throw new AppError(409, 'BACKUP_SOURCE_UNAVAILABLE', 'Managed database is not ready');
    // Canonical configuration uses native credentials; never forward Gateway's loopback proxy.
    const config = JSON.parse(this.crypto.decryptString(JSON.parse(row.encryptedConfig))) as Record<string, unknown>;
    if (!this.relay) throw new AppError(503, 'BACKUP_RELAY_UNAVAILABLE', 'Relay is unavailable');
    const relayRouteId = await this.relay.ensureBackupRoute(
      runId,
      executorNodeId,
      { kind: 'database', id: managed.id, nodeId: managed.nodeId },
      purpose === 'backup' ? 'database_backup_source' : 'database_backup_restore'
    );
    return {
      ...this.nativeConnection(row, config),
      host: '127.0.0.1',
      port: row.type === 'postgres' ? 5432 : row.type === 'redis' ? 6379 : 8123,
      // The managed relay terminates at the internal engine port. Redis/CH TLS is a separate published proxy.
      tls: row.type === 'postgres' && Boolean(config.sslEnabled),
      relayRouteId,
      managedDatabaseId: managed.id,
    };
  }

  async resolve(
    target: StorageBackupTargetConfig,
    executorNodeId: string,
    selection: {
      runId: string;
      bucket: string;
      prefix: string;
      ownerKind: 'storage_backup_target' | 'storage_backup_staging';
    }
  ): Promise<BackupDestination> {
    const provider = ['ftp', 'ftps', 'sftp'].includes(target.provider)
      ? (target.provider as 'ftp' | 'ftps' | 'sftp')
      : 's3';
    const result: BackupDestination = {
      connectionId: target.connectionId,
      provider,
      endpoint:
        target.endpoint ||
        (target.provider === 'aws' ? `https://s3.${target.region || 'us-east-1'}.amazonaws.com` : undefined),
      region: target.region,
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
      sessionToken: target.sessionToken,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      passphrase: target.passphrase,
      implicitTls: target.implicitTls,
      forcePathStyle: target.forcePathStyle,
      caPem: target.caPem,
      hostKeyFingerprint: target.hostKeyFingerprint,
      basePath: target.basePath,
      host: target.host ?? '',
      port: target.port ?? (provider === 'sftp' ? 22 : provider === 's3' ? 443 : 21),
      bucket: selection.bucket,
      prefix: selection.prefix,
      tls: provider === 'ftps' || target.endpoint?.startsWith('https:') === true,
    };
    if (target.managedClusterId && target.managedNodeId) {
      if (!this.relay) throw new AppError(503, 'BACKUP_RELAY_UNAVAILABLE', 'Relay is unavailable');
      result.relayRouteId = await this.relay.ensureBackupRoute(
        selection.runId,
        executorNodeId,
        { kind: 'storage', id: target.managedClusterId, nodeId: target.managedNodeId },
        selection.ownerKind
      );
      result.host = '127.0.0.1';
      result.port = 9000;
      if (result.tls) {
        result.caPem = (await this.storageCA.getStorageCA()).certificatePem;
        result.serverName = 'localhost';
      }
    }
    return result;
  }

  async prepareRestoreTargetForExecutor(
    runId: string,
    executorNodeId: string,
    userId: string,
    target: { newManagedDatabaseName?: string; restoreTargetConnectionId?: string }
  ): Promise<BackupRuntimeConnection & { newManagedDatabaseId?: string }> {
    const [run] = await this.db.select().from(backupRuns).where(eq(backupRuns.id, runId)).limit(1);
    if (!run?.createdById || run.createdById !== userId)
      throw new AppError(403, 'BACKUP_ACTOR_UNAVAILABLE', 'Restore owner is unavailable');
    if (target.restoreTargetConnectionId) {
      if (target.restoreTargetConnectionId === run.databaseConnectionId)
        throw new AppError(409, 'BACKUP_RESTORE_SOURCE_REJECTED', 'Restore requires a separate target');
      await this.assertScope(run.createdById, 'databases:backups:restore', target.restoreTargetConnectionId);
      await this.assertScope(run.createdById, 'databases:edit', target.restoreTargetConnectionId);
      const [row] = await this.db
        .select()
        .from(databaseConnections)
        .where(eq(databaseConnections.id, target.restoreTargetConnectionId))
        .limit(1);
      if (!row || row.type !== run.engine)
        throw new AppError(409, 'BACKUP_ENGINE_MISMATCH', 'Restore target engine does not match the backup');
      const [managed] = await this.db
        .select({ id: managedDatabaseInstances.id })
        .from(managedDatabaseInstances)
        .where(eq(managedDatabaseInstances.databaseConnectionId, row.id))
        .limit(1);
      if (managed) return this.prepareConnectionForExecutor(runId, executorNodeId, row.id, 'restore');
      const config = JSON.parse(this.crypto.decryptString(JSON.parse(row.encryptedConfig))) as Record<string, unknown>;
      return this.nativeConnection(row, config);
    }
    const actor = await resolveLiveUser(this.db, run.createdById);
    if (!actor || actor.isBlocked || !hasScopeForCreation(actor.scopes, 'databases:create', null, executorNodeId))
      throw new AppError(
        403,
        'BACKUP_ACCESS_DENIED',
        'Restore requires permission to create databases on the executor node'
      );
    const restoreTag = `backup-restore:${runId}`;
    const findTarget = async () => {
      const [result] = await this.db
        .select({ instance: managedDatabaseInstances, connection: databaseConnections })
        .from(managedDatabaseInstances)
        .innerJoin(databaseConnections, eq(databaseConnections.id, managedDatabaseInstances.databaseConnectionId))
        .where(
          and(
            eq(managedDatabaseInstances.nodeId, executorNodeId),
            eq(databaseConnections.createdById, run.createdById!),
            eq(databaseConnections.type, run.engine),
            sql`${databaseConnections.tags} @> ${JSON.stringify([restoreTag])}::jsonb`
          )
        )
        .limit(1);
      return result;
    };
    let restored = await findTarget();
    if (!restored) {
      const catalog = MANAGED_DATABASE_CATALOG[run.engine];
      const artifact = (
        run.restoreTarget as {
          artifact?: { engineVersion?: string; sizes?: Record<string, number>; sourceDatabase?: string };
        } | null
      )?.artifact;
      const sourceVersion = artifact?.engineVersion?.match(/\d+(?:\.\d+)*/)?.[0];
      const major = sourceVersion?.split('.')[0];
      const version = Object.keys(catalog).find((candidate) => !major || candidate.split('.')[0] === major);
      if (!version)
        throw new AppError(
          409,
          'BACKUP_RESTORE_VERSION_UNAVAILABLE',
          'No compatible target engine version exists in the managed database catalog'
        );
      const backupBytes = Object.values(artifact?.sizes ?? {}).reduce((sum, bytes) => sum + bytes, 0);
      const storageSizeGb = Math.max(20, Math.ceil((backupBytes * 3) / 1024 ** 3));
      await this.managedDatabases.create(
        CreateManagedDatabaseSchema.parse({
          name: target.newManagedDatabaseName,
          type: run.engine,
          version,
          nodeId: executorNodeId,
          storageSizeGb,
          databaseName: artifact?.sourceDatabase,
          cpuCores: 1,
          memoryMb: run.engine === 'clickhouse' ? 2048 : 1024,
          swapMb: 0,
          publishTcp: false,
          tlsEnabled: true,
          tags: [restoreTag],
        }),
        run.createdById
      );
      restored = await findTarget();
    }
    if (!restored || restored.instance.status !== 'ready')
      throw new AppError(409, 'BACKUP_RESTORE_TARGET_NOT_READY', 'New restore database is not ready');
    return {
      ...(await this.prepareConnectionForExecutor(runId, executorNodeId, restored.connection.id, 'restore')),
      newManagedDatabaseId: restored.instance.id,
    };
  }

  async getExecutorReachableAddress(executorNodeId: string): Promise<string> {
    const [node] = await this.db
      .select({ address: nodes.serviceAddress })
      .from(nodes)
      .where(eq(nodes.id, executorNodeId))
      .limit(1);
    if (!node?.address || node.address === 'localhost' || node.address.startsWith('127.') || node.address === '::1')
      throw new AppError(
        409,
        'BACKUP_REDIS_STAGE_ADDRESS_REQUIRED',
        'External Redis restore requires a Storage node service address reachable from the target database'
      );
    return node.address;
  }

  async cleanupRuntime(runId: string) {
    await this.relay?.revokeBackupRoutes(runId);
  }

  private nativeConnection(
    row: typeof databaseConnections.$inferSelect,
    config: Record<string, unknown>
  ): BackupRuntimeConnection {
    return {
      connectionId: row.id,
      host: String(config.host ?? row.host),
      port: Number(config.port ?? row.port),
      database: typeof config.database === 'string' ? config.database : (row.databaseName ?? undefined),
      username: typeof config.username === 'string' ? config.username : undefined,
      password: typeof config.password === 'string' ? config.password : undefined,
      tls: Boolean(config.sslEnabled ?? config.tlsEnabled),
      caPem: typeof config.caPem === 'string' ? config.caPem : undefined,
      serverName: typeof config.serverName === 'string' ? config.serverName : undefined,
    };
  }
}
