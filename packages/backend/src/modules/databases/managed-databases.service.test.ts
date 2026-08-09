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
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([row]) })) })),
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

  it('warms the PostgreSQL extension catalog when a database becomes ready', async () => {
    const ready = {
      ...managedRow,
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
    );

    await (
      service as unknown as {
        markReady: (row: typeof ready, userId: string | null, port: number | null) => Promise<unknown>;
      }
    ).markReady(ready, 'user-1', null);

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

  it('does not leave a completed recreate in reconciliation when direct-user provisioning fails', async () => {
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
    const db = { update: vi.fn(() => ({ set })) };
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

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        pendingOperation: null,
        lastError: expect.stringContaining('secure query principals'),
      })
    );
    expect(set).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'Managed database operation outcome is being reconciled' })
    );
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
    const where = vi
      .fn()
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([row]) })
      .mockReturnValueOnce({
        limit: vi.fn().mockResolvedValue([{ id: row.nodeId, type: 'databases', status: 'online' }]),
      });
    const updating = {
      ...row,
      publishedPort: null,
      pendingOperation: { id: 'operation_999', action: 'update' as const },
      status: 'updating',
    };
    const returning = vi.fn().mockResolvedValue([updating]);
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
    const query = vi
      .fn()
      .mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([row]) })
      .mockReturnValueOnce({
        limit: vi.fn().mockResolvedValue([{ id: row.nodeId, type: 'databases', status: 'online' }]),
      });
    const set = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...row, ...values }]) })),
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
      'binding_create',
      row.id,
      expect.stringContaining('"username":"gw_postgres_direct_123"')
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
      { decryptString: vi.fn(), encryptString: vi.fn() } as never,
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

    expect(dispatch.sendDockerDatabaseCommand).toHaveBeenCalledTimes(4);
    expect(dispatch.sendDockerDatabaseCommand.mock.calls.map((call) => call[1])).toEqual([
      'clickhouse_principal_apply_v1',
      'clickhouse_principal_apply_v1',
      'clickhouse_principal_apply_v1',
      'clickhouse_principal_apply_v1',
    ]);
    const commands = dispatch.sendDockerDatabaseCommand.mock.calls.map(
      (call) => JSON.parse(call[3]) as Record<string, unknown>
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalType: 'writer',
          username: 'gw_clickhouse_direct_123',
          password: 'direct-password',
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
});
