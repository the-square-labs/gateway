import { describe, expect, it, vi } from 'vitest';
import { CreateManagedDatabaseBindingSchema, CreateManagedDatabaseSchema } from './databases.schemas.js';
import {
  daemonCreateConfig,
  MANAGED_DATABASE_CATALOG,
  ManagedDatabaseService,
  managedConnectionConfig,
} from './managed-databases.service.js';

const managedRow = {
  id: '44444444-4444-4444-8444-444444444444',
  nodeId: '22222222-2222-4222-8222-222222222222',
  name: 'orders',
  slug: 'orders',
  type: 'postgres',
  version: '17.10',
  imageRef: MANAGED_DATABASE_CATALOG.postgres['17.10'],
  engineConfig: { ownerUsername: 'owner', databaseName: 'app' },
  encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'key', encryptedDek: 'dek' }),
  encryptedDirectCredentials: JSON.stringify({ encryptedKey: 'direct-key', encryptedDek: 'direct-dek' }),
  encryptedPendingOwnerCredentials: null,
  encryptedQueryCredentials: null,
  bindingIdentityVersion: 2,
  applicationPrincipalName: 'app_owner',
  ownerSeparationState: 'active',
  ownerSeparationOperationId: null,
  directPrincipalVersion: 2,
  clickhouseQueryPrincipalVersion: null,
  storageSizeBytes: 1024 * 1024 * 1024,
  runtimeConfig: { nanoCPUs: 1_000_000_000, memoryLimitBytes: 1024 * 1024 * 1024, memorySwapBytes: 1024 * 1024 * 1024 },
  publishedPort: null,
  status: 'creating',
  lastError: 'Managed database operation outcome is being reconciled',
  createdById: '11111111-1111-4111-8111-111111111111',
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function reconciliationService(row: Record<string, unknown>, result: { success: boolean; detail?: string }) {
  const returning = vi.fn().mockResolvedValue([{ ...row, status: 'ready', pendingOperation: null, lastError: null }]);
  const set = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }));
  const db: Record<string, any> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = Promise.resolve([row]) as Promise<Record<string, unknown>[]> & {
            limit: ReturnType<typeof vi.fn>;
            for: ReturnType<typeof vi.fn>;
          };
          rows.limit = vi.fn().mockResolvedValue([row]);
          rows.for = vi.fn().mockResolvedValue([row]);
          return rows;
        }),
      })),
    })),
    update: vi.fn(() => ({ set })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  const dispatch = { sendDockerDatabaseCommand: vi.fn().mockResolvedValue(result) };
  const audit = { log: vi.fn().mockResolvedValue(true) };
  const crypto = {
    decryptString: vi
      .fn()
      .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
    encryptString: vi.fn(),
  };
  return {
    service: new ManagedDatabaseService(db as never, audit as never, crypto as never, dispatch as never),
    db,
    dispatch,
    set,
  };
}

describe('managed database catalog and input guardrails', () => {
  it('persists TLS in the canonical PostgreSQL config while keeping internal Redis and ClickHouse lanes plaintext', () => {
    const credentials = { username: 'owner', password: 'secret-password-123', databaseName: 'app' };

    expect(managedConnectionConfig('postgres', credentials, true)).toMatchObject({ sslEnabled: true });
    expect(managedConnectionConfig('redis', credentials, true)).toMatchObject({ tlsEnabled: false, port: 6379 });
    expect(managedConnectionConfig('clickhouse', credentials, true)).toMatchObject({
      tlsEnabled: false,
      port: 8123,
    });
  });

  it('exposes only immutable curated images', () => {
    for (const versions of Object.values(MANAGED_DATABASE_CATALOG)) {
      for (const imageRef of Object.values(versions)) {
        expect(imageRef).toMatch(/^docker\.io\/.+@sha256:[a-f0-9]{64}$/);
        expect(imageRef).not.toContain(':latest');
      }
    }
  });

  it('offers current and compatible historical curated versions for every supported engine', () => {
    expect(Object.keys(MANAGED_DATABASE_CATALOG.postgres)).toHaveLength(10);
    expect(Object.keys(MANAGED_DATABASE_CATALOG.redis)).toHaveLength(8);
    expect(Object.keys(MANAGED_DATABASE_CATALOG.clickhouse)).toHaveLength(9);
  });

  it('does not accept a published port without explicit publication', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'orders',
      type: 'postgres',
      version: '17.10',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      publishedPort: 5432,
    });

    expect(result.success).toBe(false);
  });

  it('accepts storage in one-tenth GB increments when creating a managed database', () => {
    const input = {
      name: 'small-cache',
      type: 'redis',
      version: '8.8.1',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 0.1,
      cpuCores: 1,
      memoryMb: 128,
    };

    expect(CreateManagedDatabaseSchema.safeParse(input).success).toBe(true);
    expect(CreateManagedDatabaseSchema.safeParse({ ...input, storageSizeGb: 0.11 }).success).toBe(false);
  });

  it('allows ClickHouse HTTP publication without its native endpoint', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'analytics',
      type: 'clickhouse',
      version: '26.7.1.1315',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      publishTcp: true,
      publishNativeTcp: false,
    });

    expect(result.success).toBe(true);
  });

  it('allows a private ClickHouse database without native publication', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'analytics',
      type: 'clickhouse',
      version: '26.7.1.1315',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      publishTcp: false,
      publishNativeTcp: false,
    });

    expect(result.success).toBe(true);
  });

  it('rejects ClickHouse below its minimum memory requirement', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'analytics',
      type: 'clickhouse',
      version: '26.7.1.1315',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 128,
    });

    expect(result.success).toBe(false);
  });

  it('accepts tags when creating a managed database', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'orders',
      type: 'postgres',
      version: '18.4',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      tags: ['green:production', 'orders'],
    });

    expect(result.success).toBe(true);
  });

  it('does not accept a native ClickHouse port when native publication is disabled', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'analytics',
      type: 'clickhouse',
      version: '26.7.1.1315',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      publishTcp: true,
      publishNativeTcp: false,
      publishedNativePort: 9000,
    });

    expect(result.success).toBe(false);
  });

  it('rejects ClickHouse configuration for other engines', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'cache',
      type: 'redis',
      version: '8.8.1',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      clickhouseConfigXml: '<profiles />',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a complete Redis configuration for Redis', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'cache',
      type: 'redis',
      version: '8.8.1',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      redisConfig: {
        maxmemoryPercent: 75,
        maxmemoryPolicy: 'allkeys-lru',
        appendOnly: true,
        appendFsync: 'everysec',
        rdbSnapshotsEnabled: true,
        rdbSaveSeconds: 3600,
        rdbSaveChanges: 1,
        autoAofRewritePercentage: 100,
        autoAofRewriteMinSizeMb: 64,
        maxclients: 10_000,
        timeoutSeconds: 0,
        tcpKeepaliveSeconds: 300,
        slowlogThresholdMicroseconds: 10_000,
        slowlogMaxLen: 128,
        activeDefrag: false,
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects Redis configuration for other engines', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'orders',
      type: 'postgres',
      version: '17.10',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      redisConfig: {
        maxmemoryPercent: 75,
        maxmemoryPolicy: 'noeviction',
        appendOnly: true,
        appendFsync: 'everysec',
        rdbSnapshotsEnabled: true,
        rdbSaveSeconds: 3600,
        rdbSaveChanges: 1,
        autoAofRewritePercentage: 100,
        autoAofRewriteMinSizeMb: 64,
        maxclients: 10_000,
        timeoutSeconds: 0,
        tcpKeepaliveSeconds: 300,
        slowlogThresholdMicroseconds: 10_000,
        slowlogMaxLen: 128,
        activeDefrag: false,
      },
    });

    expect(result.success).toBe(false);
  });

  it('sends Redis configuration only to Redis daemons', async () => {
    const credentials = { username: 'owner', password: 'secret-password-123', databaseName: 'app' };
    const postgres = await daemonCreateConfig(managedRow as never, credentials, false, false, 'operation_postgres');
    const redis = await daemonCreateConfig(
      {
        ...managedRow,
        type: 'redis',
        version: '8.8.1',
        imageRef: MANAGED_DATABASE_CATALOG.redis['8.8.1'],
        engineConfig: { redisConfig: { maxmemoryPercent: 60 } },
      } as never,
      credentials,
      false,
      false,
      'operation_redis'
    );

    expect(postgres).not.toHaveProperty('redisConfig');
    expect(redis).toMatchObject({ redisConfig: { maxmemoryPercent: 60, maxmemoryPolicy: 'noeviction' } });
  });

  it('accepts a binding target without accepting credential input', () => {
    const result = CreateManagedDatabaseBindingSchema.safeParse({
      targetNodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      targetType: 'deployment',
      targetResourceId: 'orders-api',
    });

    expect(result).toMatchObject({
      success: true,
      data: { environment: {} },
    });
  });

  it('accepts an explicit ordinary-environment replacement with a binding target', () => {
    const result = CreateManagedDatabaseBindingSchema.safeParse({
      targetNodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      targetType: 'container',
      targetResourceId: 'orders-api',
      environment: { connectionUri: 'DATABASE_URL' },
      replaceExistingEnvironment: true,
      targetEnvironment: { LOG_LEVEL: 'info', DATABASE_URL: 'old-value' },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        replaceExistingEnvironment: true,
        targetEnvironment: { LOG_LEVEL: 'info', DATABASE_URL: 'old-value' },
      },
    });
  });

  it('accepts a stable Compose service binding target', () => {
    const result = CreateManagedDatabaseBindingSchema.safeParse({
      targetNodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      targetType: 'compose_service',
      targetResourceId: '44444444-4444-4444-8444-444444444444:api',
      environment: { connectionUri: 'DATABASE_URL' },
    });

    expect(result).toMatchObject({
      success: true,
      data: { targetType: 'compose_service' },
    });
  });

  it('warms the PostgreSQL extension catalog when a database becomes ready', async () => {
    const operation = { id: 'operation-ready', action: 'create' as const };
    const pending = {
      ...managedRow,
      databaseConnectionId: '55555555-5555-4555-8555-555555555555',
      status: 'creating' as const,
      pendingOperation: operation,
    };
    const ready = {
      ...pending,
      databaseConnectionId: '55555555-5555-4555-8555-555555555555',
      status: 'ready' as const,
      pendingOperation: null,
    };
    const returning = vi.fn().mockResolvedValue([ready]);
    const db = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })) })),
    };
    const warmManagedPostgresExtensionCatalog = vi.fn().mockResolvedValue(undefined);
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {} as never,
      {} as never,
      undefined,
      { warmManagedPostgresExtensionCatalog } as never
    ) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(pending);

    await service.markReady(pending, operation, 'user-1', null);

    expect(warmManagedPostgresExtensionCatalog).toHaveBeenCalledWith(ready.databaseConnectionId);
  });

  it('reconciles a delayed create response by matching its durable operation ID', async () => {
    const row = { ...managedRow, pendingOperation: { id: 'operation_123', action: 'create' as const } };
    const { service, dispatch, db } = reconciliationService(row, {
      success: true,
      detail: JSON.stringify({ status: 'ready', operationId: 'operation_123' }),
    });

    await service.reconcilePendingOperations();

    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(row.nodeId, 'inspect', row.id, '', 10_000);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('persists the daemon-reported auto-assigned port when reconciliation recovers a lost update response', async () => {
    const row = {
      ...managedRow,
      publishedPort: null,
      pendingOperation: { id: 'operation_auto_port', action: 'update' as const },
    };
    const { service, set } = reconciliationService(row, {
      success: true,
      detail: JSON.stringify({ status: 'ready', operationId: 'operation_auto_port', publishedPort: 32772 }),
    });

    await service.reconcilePendingOperations();

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ publishedPort: 32772, pendingOperation: null }));
  });

  it('keeps a completed recreate retryable when direct-user provisioning fails', async () => {
    const row = {
      ...managedRow,
      type: 'clickhouse' as const,
      status: 'updating' as const,
      engineConfig: { ...managedRow.engineConfig, publishTcp: true },
      encryptedQueryCredentials: JSON.stringify({ encryptedKey: 'query-key', encryptedDek: 'query-dek' }),
      clickhouseQueryPrincipalVersion: 1,
      pendingOperation: { id: 'operation_direct_user', action: 'update' as const },
    };
    const set = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...row, ...values }]) })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    };
    const dispatch = {
      sendDockerDatabaseCommand: vi.fn(async (_nodeId, action) =>
        action === 'update'
          ? {
              success: true,
              detail: JSON.stringify({
                status: 'ready',
                operationId: 'operation_direct_user',
                publishedPort: 32775,
              }),
            }
          : { success: false, error: 'owner cannot create users' }
      ),
    };
    const crypto = {
      decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
        JSON.stringify(
          encrypted.encryptedKey === 'direct-key'
            ? { username: 'gw_clickhouse_direct_123', password: 'direct-password', databaseName: 'app' }
            : { username: 'clickhouse_owner', password: 'owner-password', databaseName: 'app' }
        )
      ),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      crypto as never,
      dispatch as never
    );

    await (
      service as unknown as {
        dispatchUpdate: (
          value: typeof row,
          owner: { username: string; password: string; databaseName: string },
          publishTcp: boolean,
          publishNativeTcp: boolean,
          userId: string | null
        ) => Promise<unknown>;
      }
    ).dispatchUpdate(
      row,
      { username: 'clickhouse_owner', password: 'owner-password', databaseName: 'app' },
      true,
      false,
      null
    );

    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastError: 'Managed database operation outcome is being reconciled',
      })
    );
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error', pendingOperation: null }));
  });

  it('converges a delayed delete after daemon reports the record missing', async () => {
    const row = {
      ...managedRow,
      status: 'deleting',
      pendingOperation: { id: 'operation_456', action: 'delete' as const },
    };
    const { service, db } = reconciliationService(row, {
      success: true,
      detail: JSON.stringify({ status: 'missing' }),
    });

    await service.reconcilePendingOperations();

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('replays a pending operation when inspect overtakes its asynchronous daemon command', async () => {
    const row = { ...managedRow, pendingOperation: { id: 'operation_789', action: 'create' as const } };
    const { service, dispatch } = reconciliationService(row, {
      success: true,
      detail: JSON.stringify({ status: 'ready', operationId: 'older-operation' }),
    });

    await service.reconcilePendingOperations();

    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenNthCalledWith(1, row.nodeId, 'inspect', row.id, '', 10_000);
    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenNthCalledWith(
      2,
      row.nodeId,
      'create',
      row.id,
      expect.stringContaining('"operationId":"operation_789"')
    );
  });

  it('dispatches a publication change as a managed container recreation update', async () => {
    const row = { ...managedRow, status: 'ready', pendingOperation: null, publishedPort: 5432 };
    const updating = {
      ...row,
      publishedPort: null,
      pendingOperation: { id: 'operation_999', action: 'update' as const },
      status: 'updating',
    };
    const where = vi
      .fn()
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([row]) })
      .mockReturnValueOnce({
        limit: vi.fn().mockResolvedValue([{ id: row.nodeId, type: 'databases', status: 'online' }]),
      })
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([row]) })
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([updating]) })
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([updating]) });
    const returning = vi
      .fn()
      .mockResolvedValueOnce([updating])
      .mockResolvedValueOnce([{ ...updating, status: 'ready', pendingOperation: null }]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })) })),
    };
    const dispatch = {
      sendDockerDatabaseCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ status: 'ready', publishedPort: 0, operationId: 'operation_999' }),
      }),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi
          .fn()
          .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
        encryptString: vi.fn(),
      } as never,
      dispatch as never
    );

    await service.update(row.id, { publishTcp: false }, 'user-1');

    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(
      row.nodeId,
      'update',
      row.id,
      expect.stringContaining('"publishTcp":false')
    );
    expect(db.update).toHaveBeenCalled();
  });

  it('pauses a ready managed database through its dedicated daemon lifecycle action', async () => {
    const row = { ...managedRow, status: 'ready', pendingOperation: null };
    let current = row as typeof row & { pendingOperation: { id: string; action: 'pause' } | null };
    const query = vi
      .fn()
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([row]) })
      .mockReturnValueOnce({
        limit: vi.fn().mockResolvedValue([{ id: row.nodeId, type: 'databases', status: 'online' }]),
      })
      .mockImplementation(() => ({ limit: vi.fn().mockImplementation(async () => [current]) }));
    const set = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          current = { ...current, ...values } as typeof current;
          return [current];
        }),
      })),
    }));
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: query })) })),
      update: vi.fn(() => ({ set })),
    };
    const dispatch = {
      sendDockerDatabaseCommand: vi.fn(async (_nodeId, action, _databaseId, configJson) => ({
        success: true,
        detail: JSON.stringify({ status: 'paused', operationId: JSON.parse(configJson).operationId, action }),
      })),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { decryptString: vi.fn(), encryptString: vi.fn() } as never,
      dispatch as never
    );

    await expect(service.pause(row.id, 'user-1')).resolves.toMatchObject({ status: 'paused' });
    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(
      row.nodeId,
      'pause',
      row.id,
      expect.stringContaining('"operationId"')
    );
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'paused', pendingOperation: null }));
  });

  it('confirms an automatically allocated TCP port by inspecting the daemon record when a command detail is empty', async () => {
    const row = { ...managedRow, publishedPort: null };
    const dispatch = {
      sendDockerDatabaseCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ status: 'ready', publishedPort: 32770 }),
      }),
    };
    const service = new ManagedDatabaseService({} as never, { log: vi.fn() } as never, {} as never, dispatch as never);

    await expect(
      (
        service as unknown as {
          resolvePublishedPort: (
            database: typeof row,
            publishTcp: boolean,
            result: { detail?: string }
          ) => Promise<number | null>;
        }
      ).resolvePublishedPort(row, true, {})
    ).resolves.toBe(32770);
    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(row.nodeId, 'inspect', row.id, '', 10_000);
  });

  it('reveals the separate direct-access account, never the internal owner', async () => {
    const row = { ...managedRow, status: 'ready', pendingOperation: null, publishedPort: 32768 };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })) })),
      })),
    };
    const dispatch = { sendDockerDatabaseCommand: vi.fn().mockResolvedValue({ success: true }) };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'direct-key'
              ? { username: 'gw_postgres_direct_123', password: 'direct-password', databaseName: 'app' }
              : { username: 'app_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
        encryptString: vi.fn(),
      } as never,
      dispatch as never
    );

    await expect(service.revealCredentials(row.id)).resolves.toMatchObject({
      username: 'gw_postgres_direct_123',
      password: 'direct-password',
      publishedPort: 32768,
    });
    expect(dispatch.sendDockerDatabaseCommand).not.toHaveBeenCalled();
  });

  it('rotates only the direct-access password and preserves its username', async () => {
    const row = { ...managedRow, status: 'ready', pendingOperation: null, publishedPort: 32768 };
    const updated = { ...row };
    const returning = vi.fn().mockResolvedValue([updated]);
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: row.nodeId, type: 'databases', status: 'online' }]),
            })),
          })),
        }),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })) })),
    };
    const encryptString = vi.fn(() => ({ encryptedKey: 'next-key', encryptedDek: 'next-dek' }));
    const dispatch = { sendDockerDatabaseCommand: vi.fn().mockResolvedValue({ success: true }) };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'direct-key'
              ? { username: 'gw_postgres_direct_123', password: 'direct-password', databaseName: 'app' }
              : { username: 'app_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
        encryptString,
      } as never,
      dispatch as never
    );

    const credentials = await service.rotateDirectAccessCredentials(row.id, 'user-1');

    expect(credentials.username).toBe('gw_postgres_direct_123');
    expect(credentials.password).not.toBe('direct-password');
    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(
      row.nodeId,
      'binding_principal_apply_v2',
      row.id,
      expect.stringContaining('"principalName":"gw_postgres_direct_123"')
    );
    expect(encryptString).toHaveBeenCalledWith(expect.stringContaining('"username":"gw_postgres_direct_123"'));
  });

  it('returns managed CPU, memory, swap, and PID accounting without treating it as database health', async () => {
    const row = { ...managedRow, status: 'ready' };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })),
        })),
      })),
    };
    const dispatch = {
      sendDockerDatabaseCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({
          status: 'ready',
          cpuPercent: 42.5,
          memoryUsageBytes: 512,
          memoryLimitBytes: 1024,
          swapUsageBytes: 64,
          swapLimitBytes: 256,
          pids: 12,
        }),
      }),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi
          .fn()
          .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
        encryptString: vi.fn(),
      } as never,
      dispatch as never
    );

    await expect(service.getRuntimeStatsByDatabaseConnectionId('database-1')).resolves.toEqual({
      cpuPercent: 42.5,
      memoryUsageBytes: 512,
      memoryLimitBytes: 1024,
      swapUsageBytes: 64,
      swapLimitBytes: 256,
      pids: 12,
    });
    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(row.nodeId, 'stats', row.id, '', 10_000);
  });

  it('rejects a storage reduction before persisting an unachievable desired state', async () => {
    const row = {
      ...managedRow,
      status: 'ready',
      pendingOperation: null,
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })) })),
      })),
      update: vi.fn(),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(), encryptString: vi.fn() } as never,
      { sendDockerDatabaseCommand: vi.fn() } as never
    );

    await expect(service.update(row.id, { storageSizeGb: 9 }, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_DATABASE_STORAGE_REDUCTION_UNSUPPORTED',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('syncs the Postgres monitoring size limit after a managed storage update', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const db = { update: vi.fn(() => ({ set })) };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(), encryptString: vi.fn() } as never,
      { sendDockerDatabaseCommand: vi.fn() } as never
    );

    await (
      service as unknown as {
        syncCanonicalConnectionStorageLimit: (
          row: typeof managedRow & { databaseConnectionId: string | null }
        ) => Promise<void>;
      }
    ).syncCanonicalConnectionStorageLimit({
      ...managedRow,
      databaseConnectionId: '55555555-5555-4555-8555-555555555555',
      storageSizeBytes: 2 * 1024 * 1024 * 1024,
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ manualSizeLimitMb: 2048, updatedById: managedRow.updatedById })
    );
  });

  it('does not accept a custom Redis owner username', () => {
    const result = CreateManagedDatabaseSchema.safeParse({
      name: 'cache',
      type: 'redis',
      version: '7.4.2',
      nodeId: '44d553a4-8978-4ad1-8ca7-4d53c6e74a1d',
      storageSizeGb: 10,
      cpuCores: 1,
      memoryMb: 1024,
      ownerUsername: 'cache_owner',
    });

    expect(result.success).toBe(false);
  });

  it('reconciles reader and writer ClickHouse principals without a legacy binding fallback', async () => {
    const published = {
      ...managedRow,
      type: 'clickhouse' as const,
      status: 'ready' as const,
      pendingOperation: null,
      engineConfig: { databaseName: 'app', publishTcp: true },
      publishedPort: 32768,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
      encryptedDirectCredentials: JSON.stringify({ encryptedKey: 'direct-key', encryptedDek: 'direct-dek' }),
      encryptedQueryCredentials: JSON.stringify({ encryptedKey: 'query-key', encryptedDek: 'query-dek' }),
      clickhouseQueryPrincipalVersion: 1,
    };
    const privateDatabase = {
      ...published,
      id: '66666666-6666-4666-8666-666666666666',
      engineConfig: { databaseName: 'app', publishTcp: false },
      publishedPort: null,
    };
    const dispatch = { sendDockerDatabaseCommand: vi.fn().mockResolvedValue({ success: true }) };
    const update = vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...published, ...values }]) })),
      })),
    }));
    const service = new ManagedDatabaseService(
      {
        select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([published, privateDatabase]) })),
        update,
      } as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'direct-key'
              ? { username: 'gw_clickhouse_direct_123', password: 'direct-password', databaseName: 'app' }
              : encrypted.encryptedKey === 'query-key'
                ? { username: 'gw_clickhouse_query_123', password: 'query-password', databaseName: 'app' }
                : { username: 'clickhouse_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
      } as never,
      dispatch as never
    );

    await service.reconcileClickHouseQueryPrincipals();

    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledTimes(8);
    expect(dispatch.sendDockerDatabaseCommand.mock.calls.map((call) => call[1])).toEqual([
      'owner_separation_finalize_v1',
      'binding_principal_apply_v2',
      'binding_principal_probe_v2',
      'clickhouse_principal_apply_v1',
      'owner_separation_finalize_v1',
      'binding_principal_apply_v2',
      'binding_principal_probe_v2',
      'clickhouse_principal_apply_v1',
    ]);
    const commands = dispatch.sendDockerDatabaseCommand.mock.calls.map(
      (call) => JSON.parse(call[3]) as Record<string, unknown>
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: published.id,
          currentOwnerUsername: 'clickhouse_owner',
          currentOwnerPassword: 'owner-password',
          pendingOwnerUsername: 'clickhouse_owner',
          pendingOwnerPassword: 'owner-password',
        }),
        expect.objectContaining({
          principalName: 'gw_clickhouse_direct_123',
          password: 'direct-password',
          applicationPrincipalName: 'app_owner',
          ownerUsername: 'clickhouse_owner',
        }),
        expect.objectContaining({
          principalType: 'reader',
          username: 'gw_clickhouse_query_123',
          password: 'query-password',
          ownerUsername: 'clickhouse_owner',
        }),
      ])
    );
    expect(JSON.stringify(commands)).not.toContain('reconcileOnly');
  });

  it('leaves database identity migration to the binding coordinator while legacy bindings exist', async () => {
    const row = {
      ...managedRow,
      status: 'ready' as const,
      pendingOperation: null,
      bindingIdentityVersion: 0,
    };
    const service = new ManagedDatabaseService(
      {
        select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([row]) })),
      } as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    vi.spyOn(service, 'legacyBindingDatabaseIds').mockResolvedValue(new Set([row.id]));
    const ensure = vi.spyOn(service, 'ensureBindingIdentity');

    await service.reconcileBindingIdentities(row.nodeId);

    expect(ensure).not.toHaveBeenCalled();
  });

  it('prepares and pins the database runtime before applying identity v2', async () => {
    const row = {
      ...managedRow,
      type: 'redis' as const,
      version: '8.10.0',
      imageRef: MANAGED_DATABASE_CATALOG.redis['8.10.0'],
      engineConfig: { publishTcp: true },
      publishedPort: 32768,
      bindingIdentityVersion: 0,
    };
    const sendDockerDatabaseCommand = vi.fn().mockResolvedValue({ success: true });
    const service = new ManagedDatabaseService(
      {} as never,
      {} as never,
      {} as never,
      { sendDockerDatabaseCommand } as never
    ) as any;

    await service.prepareBindingIdentityRuntime(row, {
      username: 'default',
      password: 'owner-password-123456',
      databaseName: 'redis',
    });

    expect(sendDockerDatabaseCommand).toHaveBeenCalledWith(row.nodeId, 'update', row.id, expect.any(String));
    const payload = JSON.parse(sendDockerDatabaseCommand.mock.calls[0]![3]) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'redis',
      operationId: `binding-identity-${row.id}`,
      preserveLifecycleOperationId: true,
      publishTcp: true,
      publishedPort: 32768,
      redisConfig: expect.any(Object),
    });
  });

  it('keeps the active lifecycle operation id while preparing identity on an older daemon', async () => {
    const operationId = '77777777-7777-4777-8777-777777777777';
    const row = {
      ...managedRow,
      pendingOperation: { id: operationId, action: 'create' as const, requestedAt: new Date().toISOString() },
      bindingIdentityVersion: 0,
    };
    const sendDockerDatabaseCommand = vi.fn().mockResolvedValue({ success: true });
    const service = new ManagedDatabaseService(
      {} as never,
      {} as never,
      {} as never,
      { sendDockerDatabaseCommand } as never
    ) as any;

    await service.prepareBindingIdentityRuntime(row, {
      username: 'owner',
      password: 'owner-password-123456',
      databaseName: 'app',
    });

    const payload = JSON.parse(sendDockerDatabaseCommand.mock.calls[0]![3]) as Record<string, unknown>;
    expect(payload).toMatchObject({ operationId, preserveLifecycleOperationId: true });
  });

  it('restores owner credentials for an existing published database connection', async () => {
    const row = {
      ...managedRow,
      databaseConnectionId: '55555555-5555-4555-8555-555555555555',
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
      encryptedDirectCredentials: JSON.stringify({ encryptedKey: 'direct-key', encryptedDek: 'direct-dek' }),
      publishedPort: 32768,
    };
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([row]) })),
      update: vi.fn(() => ({ set })),
    };
    const crypto = {
      decryptString: vi.fn(() => JSON.stringify({ username: 'default', password: 'owner-password' })),
      encryptString: vi.fn((value: string) => ({ payload: value })),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      crypto as never,
      { sendDockerDatabaseCommand: vi.fn() } as never
    );

    await service.reconcileDatabaseConnections();

    const calls = set.mock.calls as unknown as Array<[{ encryptedConfig: string }]>;
    const update = calls[0]![0];
    const encrypted = JSON.parse(update.encryptedConfig) as { payload: string };
    expect(JSON.parse(encrypted.payload)).toMatchObject({ username: 'default', password: 'owner-password' });
  });

  it('retries PostgreSQL owner preparation from persisted pending credentials after an interrupted attempt', async () => {
    let current = {
      ...managedRow,
      status: 'ready' as const,
      pendingOperation: null,
      databaseConnectionId: null,
      bindingIdentityVersion: 0,
      directPrincipalVersion: 0,
      ownerSeparationState: 'preparing' as const,
      ownerSeparationOperationId: '77777777-7777-4777-8777-777777777777',
      applicationPrincipalName: 'gw_app_orders',
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
      encryptedPendingOwnerCredentials: JSON.stringify({ encryptedKey: 'pending-key', encryptedDek: 'pending-dek' }),
      encryptedDirectCredentials: null,
    };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              current = { ...current, ...values } as typeof current;
              return [current];
            }),
          })),
        })),
      })),
    };
    const dispatch = { sendDockerDatabaseCommand: vi.fn().mockResolvedValue({ success: true }) };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'pending-key'
              ? { username: 'gw_admin_orders', password: 'pending-password-123456', databaseName: 'app' }
              : { username: 'owner', password: 'owner-password-123456', databaseName: 'app' }
          )
        ),
        encryptString: vi.fn(),
      } as never,
      dispatch as never
    ) as any;
    vi.spyOn(service, 'getRow').mockImplementation(async () => current);
    vi.spyOn(service, 'assertBindingPrincipalV2Capability').mockResolvedValue({});
    vi.spyOn(service, 'syncCanonicalConnectionCredentials').mockResolvedValue(undefined);

    const result = await service.ensureBindingIdentity(current.id, null);

    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledWith(
      current.nodeId,
      'owner_separation_prepare_v1',
      current.id,
      expect.stringContaining('"pendingOwnerUsername":"gw_admin_orders"')
    );
    expect(result).toMatchObject({
      bindingIdentityVersion: 2,
      directPrincipalVersion: 2,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'pending-key', encryptedDek: 'pending-dek' }),
      encryptedPendingOwnerCredentials: null,
      ownerSeparationState: 'preparing',
    });
  });

  it('uses the prepared PostgreSQL control owner for principal provisioning', async () => {
    let current = {
      ...managedRow,
      status: 'ready' as const,
      pendingOperation: null,
      databaseConnectionId: null,
      bindingIdentityVersion: 0,
      directPrincipalVersion: 0,
      ownerSeparationState: 'preparing' as const,
      ownerSeparationOperationId: '77777777-7777-4777-8777-777777777777',
      applicationPrincipalName: 'gw_app_orders',
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
      encryptedPendingOwnerCredentials: JSON.stringify({ encryptedKey: 'pending-key', encryptedDek: 'pending-dek' }),
      encryptedDirectCredentials: JSON.stringify({ encryptedKey: 'direct-key', encryptedDek: 'direct-dek' }),
    };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              current = { ...current, ...values } as typeof current;
              return [current];
            }),
          })),
        })),
      })),
    };
    const dispatch = { sendDockerDatabaseCommand: vi.fn().mockResolvedValue({ success: true }) };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) => {
          if (encrypted.encryptedKey === 'pending-key') {
            return JSON.stringify({
              username: 'gateway_control',
              password: 'control-password-123456',
              databaseName: 'app',
            });
          }
          if (encrypted.encryptedKey === 'direct-key') {
            return JSON.stringify({
              username: 'gateway_direct',
              password: 'direct-password-123456',
              databaseName: 'app',
            });
          }
          return JSON.stringify({
            username: 'legacy_owner',
            password: 'legacy-password-123456',
            databaseName: 'app',
          });
        }),
        encryptString: vi.fn(),
      } as never,
      dispatch as never
    ) as any;
    vi.spyOn(service, 'getRow').mockImplementation(async () => current);
    vi.spyOn(service, 'assertBindingPrincipalV2Capability').mockResolvedValue({});
    vi.spyOn(service, 'prepareBindingIdentityRuntime').mockResolvedValue(undefined);
    vi.spyOn(service, 'syncCanonicalConnectionCredentials').mockResolvedValue(undefined);

    await service.ensureBindingIdentity(current.id, null);

    const apply = dispatch.sendDockerDatabaseCommand.mock.calls.find(
      (call) => call[1] === 'binding_principal_apply_v2'
    );
    expect(JSON.parse(apply![3])).toMatchObject({
      ownerUsername: 'gateway_control',
      ownerPassword: 'control-password-123456',
      principalName: 'gateway_direct',
    });
  });

  it('does not finalize owner separation while any binding still uses the legacy principal model', async () => {
    const row = {
      ...managedRow,
      status: 'ready' as const,
      pendingOperation: null,
      ownerSeparationState: 'preparing' as const,
    };
    const dispatch = { sendDockerDatabaseCommand: vi.fn() };
    const service = new ManagedDatabaseService(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'binding-1', principalModelVersion: 0 }]) })),
        })),
      } as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(), encryptString: vi.fn() } as never,
      dispatch as never
    ) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(row);

    await expect(service.finalizeBindingIdentity(row.id, null)).resolves.toBe(row);
    expect(dispatch.sendDockerDatabaseCommand).not.toHaveBeenCalled();
  });

  it('does not finalize owner separation while an unrelated lifecycle operation is pending', async () => {
    const row = {
      ...managedRow,
      status: 'updating' as const,
      pendingOperation: { id: 'update-operation', action: 'update' as const },
      ownerSeparationState: 'preparing' as const,
    };
    const db = { select: vi.fn() };
    const dispatch = { sendDockerDatabaseCommand: vi.fn() };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(), encryptString: vi.fn() } as never,
      dispatch as never
    ) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(row);

    await expect(service.finalizeBindingIdentity(row.id, null)).resolves.toBe(row);
    expect(db.select).not.toHaveBeenCalled();
    expect(dispatch.sendDockerDatabaseCommand).not.toHaveBeenCalled();
  });

  it('does not clear a newer lifecycle operation from a stale ready completion', async () => {
    const operationA = { id: 'operation-a', action: 'update' as const };
    const operationB = { id: 'operation-b', action: 'restart' as const };
    const stale = { ...managedRow, status: 'updating' as const, pendingOperation: operationA };
    const current = { ...managedRow, status: 'updating' as const, pendingOperation: operationB };
    const returning = vi.fn().mockResolvedValue([]);
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      })),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi
          .fn()
          .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
        encryptString: vi.fn(),
      } as never,
      {} as never
    ) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(current);
    const warm = vi.spyOn(service, 'warmPostgresExtensionCatalog').mockResolvedValue(undefined);
    const emit = vi.spyOn(service, 'emit');

    await expect(service.markReady(stale, operationA, null, null)).resolves.toMatchObject({ status: 'updating' });

    expect(db.update).not.toHaveBeenCalled();
    expect(current.pendingOperation).toBe(operationB);
    expect(warm).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps the pending operation durable when canonical synchronization fails', async () => {
    const operation = { id: 'operation-a', action: 'update' as const };
    const pending = { ...managedRow, status: 'updating' as const, pendingOperation: operation };
    const db = { update: vi.fn() };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi
          .fn()
          .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
        encryptString: vi.fn(),
      } as never,
      {} as never
    ) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(pending);
    vi.spyOn(service, 'syncCanonicalConnectionCredentials').mockRejectedValue(new Error('connection sync failed'));

    await expect(service.markReady(pending, operation, 'user-1', null, 'ready', null, true)).rejects.toThrow(
      'connection sync failed'
    );

    expect(db.update).not.toHaveBeenCalled();
    expect(pending.pendingOperation).toBe(operation);
  });

  it('lets a successful completion win when another completion of the same operation fails', async () => {
    const operation = { id: 'operation-a', action: 'update' as const };
    const pending = { ...managedRow, status: 'updating' as const, pendingOperation: operation };
    let current = pending as typeof pending | (typeof pending & { status: 'ready'; pendingOperation: null });
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (current.pendingOperation?.id !== operation.id) return [];
              current = { ...current, ...values } as typeof current;
              return [current];
            }),
          })),
        })),
      })),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi
          .fn()
          .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
        encryptString: vi.fn(),
      } as never,
      {} as never
    ) as any;
    vi.spyOn(service, 'getRow').mockImplementation(async () => current);
    vi.spyOn(service, 'syncCanonicalConnectionCredentials')
      .mockRejectedValueOnce(new Error('transient sync failure'))
      .mockResolvedValue(undefined);

    const failedCompletion = service
      .markReady(pending, operation, 'user-1', null, 'ready', null, true)
      .catch(() => service.markOutcomeUnknown(pending));
    const successfulCompletion = service.markReady(pending, operation, 'user-1', null, 'ready', null, true);

    await Promise.all([failedCompletion, successfulCompletion]);

    expect(current).toMatchObject({ status: 'ready', pendingOperation: null, lastError: null });
    expect(service.syncCanonicalConnectionCredentials).toHaveBeenCalledTimes(2);
    expect(service.bindingIdentityOperations.size).toBe(0);
  });

  it('coalesces concurrent dispatches of the same durable update operation', async () => {
    const operation = { id: 'operation-a', action: 'update' as const };
    const pending = { ...managedRow, status: 'updating' as const, pendingOperation: operation };
    const service = new ManagedDatabaseService({} as never, {} as never, {} as never, {} as never) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(pending);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unlocked = vi.spyOn(service, 'dispatchUpdateUnlocked').mockImplementation(async () => {
      await gate;
      return { status: 'ready' };
    });
    const credentials = { username: 'owner', password: 'secret-password-123', databaseName: 'app' };

    const first = service.dispatchUpdate(pending, credentials, false, false, null);
    const second = service.dispatchUpdate(pending, credentials, false, false, null);

    await vi.waitFor(() => expect(unlocked).toHaveBeenCalledOnce());
    expect(service.databaseOperationDispatches.size).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'ready' }, { status: 'ready' }]);

    expect(unlocked).toHaveBeenCalledOnce();
    expect(service.databaseOperationDispatches.size).toBe(0);
  });

  it('does not dispatch a delayed operation after a newer operation became current', async () => {
    const operationA = { id: 'operation-a', action: 'update' as const };
    const operationB = { id: 'operation-b', action: 'update' as const };
    const stale = { ...managedRow, status: 'updating' as const, pendingOperation: operationA };
    const current = { ...managedRow, status: 'updating' as const, pendingOperation: operationB };
    const service = new ManagedDatabaseService({} as never, {} as never, {} as never, {} as never) as any;
    vi.spyOn(service, 'getRow').mockResolvedValue(current);
    const unlocked = vi.spyOn(service, 'dispatchUpdateUnlocked');

    await expect(
      service.dispatchUpdate(
        stale,
        { username: 'owner', password: 'secret-password-123', databaseName: 'app' },
        false,
        false,
        null
      )
    ).resolves.toMatchObject({ status: 'updating' });

    expect(unlocked).not.toHaveBeenCalled();
    expect(service.databaseOperationDispatches.size).toBe(0);
  });

  it('serializes owner identity operations for the same managed database', async () => {
    const service = new ManagedDatabaseService({} as never, { log: vi.fn() } as never, {} as never, {} as never) as any;
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const unlocked = vi.spyOn(service, 'ensureBindingIdentityUnlocked').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (unlocked.mock.calls.length === 1) await firstGate;
      active -= 1;
      return managedRow;
    });

    const first = service.ensureBindingIdentity(managedRow.id, null);
    const second = service.ensureBindingIdentity(managedRow.id, null);
    await vi.waitFor(() => expect(unlocked).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(unlocked).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(service.bindingIdentityOperations.size).toBe(0);
  });

  it('serializes binding lifecycle work with owner identity operations for the same database', async () => {
    const service = new ManagedDatabaseService({} as never, { log: vi.fn() } as never, {} as never, {} as never) as any;
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const bindingStarted = vi.fn();
    const identityStarted = vi.fn();
    vi.spyOn(service, 'ensureBindingIdentityUnlocked').mockImplementation(async () => {
      identityStarted();
      return managedRow;
    });

    const binding = service.runBindingLifecycleOperation(managedRow.id, async () => {
      bindingStarted();
      await bindingGate;
    });
    const identity = service.ensureBindingIdentity(managedRow.id, null);

    await vi.waitFor(() => expect(bindingStarted).toHaveBeenCalledOnce());
    expect(identityStarted).not.toHaveBeenCalled();
    releaseBinding();
    await Promise.all([binding, identity]);

    expect(identityStarted).toHaveBeenCalledOnce();
    expect(service.bindingIdentityOperations.size).toBe(0);
  });

  it('serializes retry provisioning with binding lifecycle work for the same database', async () => {
    const failed = {
      ...managedRow,
      status: 'error' as const,
      pendingOperation: null,
      lastError: 'Managed database create failed: daemon unavailable',
    };
    const claimed = {
      ...failed,
      status: 'creating' as const,
      pendingOperation: { id: 'retry-operation', action: 'create' as const },
      lastError: null,
    };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([claimed]) })),
        })),
      })),
    };
    const service = new ManagedDatabaseService(
      db as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      {
        decryptString: vi
          .fn()
          .mockReturnValue(JSON.stringify({ username: 'owner', password: 'secret-password-123', databaseName: 'app' })),
      } as never,
      {} as never
    ) as any;
    const getRow = vi.spyOn(service, 'getRow').mockResolvedValue(failed);
    vi.spyOn(service, 'assertDatabaseNode').mockResolvedValue({});
    vi.spyOn(service, 'ensureManagedDatabaseCertificate').mockResolvedValue(failed);
    vi.spyOn(service, 'dispatchCreate').mockResolvedValue({ id: failed.id });
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const bindingStarted = vi.fn();

    const binding = service.runBindingLifecycleOperation(failed.id, async () => {
      bindingStarted();
      await bindingGate;
    });
    const retry = service.retryProvisioning(failed.id, 'user-1');

    await vi.waitFor(() => expect(bindingStarted).toHaveBeenCalledOnce());
    expect(getRow).not.toHaveBeenCalled();
    releaseBinding();
    await Promise.all([binding, retry]);

    expect(getRow).toHaveBeenCalledOnce();
    expect(service.dispatchCreate).toHaveBeenCalledOnce();
    expect(service.bindingIdentityOperations.size).toBe(0);
  });
});
