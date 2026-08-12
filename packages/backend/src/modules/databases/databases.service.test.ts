import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { splitSqlStatements } from './database-query-intent.js';
import {
  DatabaseConnectionService,
  inferClickHouseIntent,
  inferPostgresIntent,
  inferRedisIntent,
  mapDatabaseDriverError,
} from './databases.service.js';

describe('mapDatabaseDriverError', () => {
  it('maps postgres authentication failures to 401', () => {
    const error = Object.assign(new Error('password authentication failed for user "doadmin"'), {
      code: '28P01',
    });
    const mapped = mapDatabaseDriverError(error, 'postgres', 'connect');

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.statusCode).toBe(401);
    expect(mapped?.code).toBe('DATABASE_AUTH_FAILED');
  });

  it('maps redis authentication failures to 401', () => {
    const error = new Error('WRONGPASS invalid username-password pair or user is disabled.');
    const mapped = mapDatabaseDriverError(error, 'redis', 'connect');

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.statusCode).toBe(401);
    expect(mapped?.code).toBe('DATABASE_AUTH_FAILED');
  });

  it('maps ClickHouse authentication and query failures without hiding the driver message', () => {
    const auth = mapDatabaseDriverError(
      new Error('Authentication failed: password is incorrect'),
      'clickhouse',
      'connect'
    );
    const query = mapDatabaseDriverError(new Error('Code: 62. DB::Exception: Syntax error'), 'clickhouse', 'query');

    expect(auth).toMatchObject({ statusCode: 401, code: 'DATABASE_AUTH_FAILED' });
    expect(query).toMatchObject({ statusCode: 400, code: 'DATABASE_QUERY_FAILED' });
  });

  it('maps nested ClickHouse fetch failures as connection errors', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8123'), {
        code: 'ECONNREFUSED',
      }),
    });

    expect(mapDatabaseDriverError(error, 'clickhouse', 'connect')).toMatchObject({
      statusCode: 422,
      code: 'DATABASE_CONNECTION_FAILED',
    });
  });

  it('maps network and connectivity failures to 422', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const mapped = mapDatabaseDriverError(error, 'postgres', 'connect');

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.statusCode).toBe(422);
    expect(mapped?.code).toBe('DATABASE_CONNECTION_FAILED');
  });

  it('maps postgres query syntax errors to 400', () => {
    const error = Object.assign(new Error('syntax error at or near "FROM"'), {
      code: '42601',
    });
    const mapped = mapDatabaseDriverError(error, 'postgres', 'query');

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.statusCode).toBe(400);
    expect(mapped?.code).toBe('DATABASE_QUERY_FAILED');
  });

  it('maps postgres statement timeouts to the interactive budget error', () => {
    const error = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });

    expect(mapDatabaseDriverError(error, 'postgres', 'query')).toMatchObject({
      statusCode: 408,
      code: 'DATABASE_QUERY_BUDGET_EXCEEDED',
    });
  });

  it('maps other postgres query driver errors to 400 so the UI sees the real message', () => {
    const error = Object.assign(new Error('invalid input value for enum order_status: "oops"'), {
      code: 'ZZZZZ',
      severity: 'ERROR',
    });
    const mapped = mapDatabaseDriverError(error, 'postgres', 'query');

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.statusCode).toBe(400);
    expect(mapped?.code).toBe('DATABASE_QUERY_FAILED');
    expect(mapped?.message).toContain('invalid input value for enum');
  });

  it('preserves operational query error text for the database console', () => {
    const error = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    });
    const mapped = mapDatabaseDriverError(error, 'postgres', 'query');

    expect(mapped).toMatchObject({
      statusCode: 400,
      code: 'DATABASE_QUERY_FAILED',
      message: 'terminating connection due to administrator command',
    });
  });

  it('returns null for unknown errors', () => {
    const mapped = mapDatabaseDriverError(new Error('unexpected socket blowup'), 'postgres', 'connect');
    expect(mapped).toBeNull();
  });
});

describe('database query intent inference', () => {
  it('infers the strongest Postgres intent across batches while ignoring quoted semicolons', () => {
    expect(inferPostgresIntent("select ';' as semi; show all")).toBe('read');
    expect(inferPostgresIntent('select * from users; update users set role = $1')).toBe('write');
    expect(inferPostgresIntent('with deleted as (delete from users returning *) select * from deleted')).toBe('admin');
    expect(inferPostgresIntent('select 1 -- harmless\r; set role app_admin')).toBe('admin');
  });

  it('keeps lone CR inside ClickHouse line comments when using the shared splitter', () => {
    expect(splitSqlStatements('SELECT 1 -- intentionally disabled\r; DROP TABLE events')).toEqual([
      'SELECT 1 -- intentionally disabled\r; DROP TABLE events',
    ]);
  });

  it('infers the strongest Redis command intent across quoted and batched commands', () => {
    expect(inferRedisIntent('GET "key;with;semicolons"; TTL key')).toBe('read');
    expect(inferRedisIntent('GET key\nSET key value')).toBe('write');
    expect(inferRedisIntent('CONFIG GET *')).toBe('admin');
  });

  it('infers ClickHouse intent conservatively across provider-specific statements', () => {
    expect(inferClickHouseIntent('select `semi;column` from events; show tables')).toBe('read');
    expect(inferClickHouseIntent('insert into events values (1)')).toBe('write');
    expect(inferClickHouseIntent('alter table events delete where id = 1')).toBe('admin');
    expect(inferClickHouseIntent('optimize table events final')).toBe('admin');
  });
});

describe('DatabaseConnectionService.executePostgresSql', () => {
  it('rejects Postgres SQL batches above the response result limit before executing any statement', async () => {
    const service = new DatabaseConnectionService({} as never, { log: vi.fn() } as never, {} as never);
    const pool = {
      connect: vi.fn(),
    };
    const getPostgresPool = vi.spyOn(service, 'getPostgresPool').mockResolvedValue(pool as never);

    const sql = Array.from({ length: 11 }, (_, index) => `select ${index}`).join('; ');

    await expect(service.executePostgresSql('db-1', sql, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'POSTGRES_STATEMENT_LIMIT_EXCEEDED',
    });
    expect(getPostgresPool).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('casts update row parameters using column metadata types', async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const service = new DatabaseConnectionService({} as never, { log } as never, {} as never);
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: '1' }] }),
    };
    vi.spyOn(service, 'getPostgresPool').mockResolvedValue(pool as never);
    vi.spyOn(service, 'getPostgresTableMetadata').mockResolvedValue({
      schema: 'public',
      table: 'orders',
      columns: [
        {
          name: 'id',
          dataType: 'bigint',
          udtName: 'int8',
          udtSchema: 'pg_catalog',
          nullable: false,
          isPrimaryKey: true,
          hasDefault: false,
        },
        {
          name: 'status',
          dataType: 'USER-DEFINED',
          udtName: 'order_status',
          udtSchema: 'public',
          nullable: false,
          isPrimaryKey: false,
          hasDefault: false,
        },
        {
          name: 'scheduled_for',
          dataType: 'date',
          udtName: 'date',
          udtSchema: 'pg_catalog',
          nullable: true,
          isPrimaryKey: false,
          hasDefault: false,
        },
        {
          name: 'attempts',
          dataType: 'smallint',
          udtName: 'int2',
          udtSchema: 'pg_catalog',
          nullable: false,
          isPrimaryKey: false,
          hasDefault: false,
        },
      ],
      primaryKey: ['id'],
      hasPrimaryKey: true,
    });

    await service.updatePostgresRow(
      'db-1',
      'public',
      'orders',
      { id: '1' },
      { id: '1', status: 'queued', scheduled_for: '2026-06-18', attempts: '2' },
      'user-1'
    );

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'set "status" = $1::"public"."order_status", "scheduled_for" = $2::date, "attempts" = $3::smallint'
      ),
      ['queued', '2026-06-18', '2', '1']
    );
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('where "id" = $4::bigint'), [
      'queued',
      '2026-06-18',
      '2',
      '1',
    ]);
    expect(log).toHaveBeenCalled();
  });

  it('compacts Postgres query rows to the requested maxRows and reports truncation', async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const service = new DatabaseConnectionService({} as never, { log } as never, {} as never);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SET') || sql.startsWith('RESET')) return {};
        return {
          command: 'SELECT',
          rowCount: 3,
          fields: [{ name: 'id' }, { name: 'payload' }],
          rows: [
            { id: 1, payload: 'a' },
            { id: 2, payload: 'b' },
            { id: 3, payload: 'c' },
          ],
        };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    };
    vi.spyOn(service, 'getPostgresPool').mockResolvedValue(pool as never);

    await expect(service.executePostgresSql('db-1', 'select * from events', 'user-1', { maxRows: 2 })).resolves.toEqual(
      {
        results: [
          expect.objectContaining({
            command: 'SELECT',
            rowCount: 3,
            fields: ['id', 'payload'],
            rows: [
              { id: 1, payload: 'a' },
              { id: 2, payload: 'b' },
            ],
            truncated: true,
            maxRows: 2,
          }),
        ],
        truncated: false,
        resultLimit: 10,
      }
    );
    expect(client.release).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'database.postgres.query' }));
  });
});

describe('DatabaseConnectionService interactive query admission', () => {
  it('allows one run per user and three runs per database', async () => {
    const service = new DatabaseConnectionService({} as never, { log: vi.fn() } as never, {} as never);
    const releases: Array<() => void> = [];
    const executeSql = vi.fn(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ results: [], truncated: false, resultLimit: 10 }));
        })
    );
    vi.spyOn(service as unknown as { getRow: () => Promise<unknown> }, 'getRow').mockResolvedValue({
      interactiveQueryBudgetSeconds: 300,
    });
    vi.spyOn(
      service as unknown as { getSqlAdapter: () => Promise<{ executeSql: typeof executeSql }> },
      'getSqlAdapter'
    ).mockResolvedValue({ executeSql });

    const first = service.executeSql('db-1', 'select 1', 'user-1');
    await vi.waitFor(() => expect(executeSql).toHaveBeenCalledTimes(1));
    await expect(service.executeSql('db-1', 'select 2', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DATABASE_QUERY_ALREADY_RUNNING',
    });

    const second = service.executeSql('db-1', 'select 2', 'user-2');
    const third = service.executeSql('db-1', 'select 3', 'user-3');
    await vi.waitFor(() => expect(executeSql).toHaveBeenCalledTimes(3));
    await expect(service.executeSql('db-1', 'select 4', 'user-4')).rejects.toMatchObject({
      statusCode: 429,
      code: 'DATABASE_QUERY_CONCURRENCY_LIMIT',
    });

    for (const release of releases) release();
    await Promise.all([first, second, third]);
  });
});

describe('DatabaseConnectionService.executeRedisCommand', () => {
  it('compacts oversized Redis command results before returning them', async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const service = new DatabaseConnectionService({} as never, { log } as never, {} as never);
    const client = {
      call: vi.fn().mockResolvedValue(Array.from({ length: 600 }, (_, index) => `item-${index}`)),
    };
    vi.spyOn(service, 'getRedisClient').mockResolvedValue(client as never);

    await expect(service.executeRedisCommand('db-1', 'LRANGE queue 0 -1', 'user-1')).resolves.toEqual({
      results: [
        {
          command: 'LRANGE',
          result: Array.from({ length: 500 }, (_, index) => `item-${index}`),
          truncated: true,
        },
      ],
      truncated: false,
      commandLimit: 20,
    });
    expect(client.call).toHaveBeenCalledWith('LRANGE', 'queue', '0', '-1');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'database.redis.command.execute' }));
  });
});

describe('DatabaseConnectionService connection views', () => {
  function encryptedConfig(config: Record<string, unknown>) {
    return JSON.stringify({ payload: JSON.stringify(config) });
  }

  function createService(row: Record<string, unknown>, managed?: Record<string, unknown>) {
    const db = {
      query: {
        databaseConnections: {
          findFirst: vi.fn().mockResolvedValue(row),
        },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(managed ? [managed] : []) })),
          })),
        })),
      })),
    };
    const cryptoService = {
      decryptString: vi.fn((payload: { payload: string }) => payload.payload),
      encryptString: vi.fn((value: string) => ({ payload: value })),
    };
    return new DatabaseConnectionService(db as never, { log: vi.fn() } as never, cryptoService as never);
  }

  it('masks stored database credentials in normal connection views', async () => {
    const service = createService({
      id: 'db-1',
      name: 'Production Postgres',
      type: 'postgres',
      description: null,
      tags: ['prod'],
      manualSizeLimitMb: 1024,
      host: 'db.example.com',
      port: 5432,
      databaseName: 'app',
      username: 'app_user',
      tlsEnabled: true,
      encryptedConfig: encryptedConfig({
        type: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'app',
        username: 'app_user',
        password: 'secret-password',
        sslEnabled: true,
      }),
      healthStatus: 'online',
      lastHealthCheckAt: new Date('2026-06-21T10:00:00.000Z'),
      lastError: null,
      healthHistory: null,
      createdById: 'user-1',
      updatedById: null,
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
      updatedAt: new Date('2026-06-21T10:00:00.000Z'),
    });

    await expect(service.get('db-1')).resolves.toMatchObject({
      id: 'db-1',
      hasStoredPassword: true,
      config: {
        password: '••••••••',
        sslEnabled: true,
      },
    });
  });

  it('reveals credentials with an encoded Postgres connection string', async () => {
    const service = createService({
      id: 'db-1',
      name: 'Production Postgres',
      type: 'postgres',
      description: null,
      tags: [],
      manualSizeLimitMb: null,
      host: 'db.example.com',
      port: 5432,
      databaseName: 'app db',
      username: 'app user',
      tlsEnabled: true,
      encryptedConfig: encryptedConfig({
        type: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'app db',
        username: 'app user',
        password: 'p@ss word',
        sslEnabled: true,
      }),
      healthStatus: 'online',
      lastHealthCheckAt: null,
      lastError: null,
      healthHistory: [],
      createdById: 'user-1',
      updatedById: null,
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
      updatedAt: new Date('2026-06-21T10:00:00.000Z'),
    });

    await expect(service.revealCredentials('db-1')).resolves.toMatchObject({
      password: 'p@ss word',
      connectionString: 'postgresql://app%20user:p%40ss%20word@db.example.com:5432/app%20db?sslmode=require',
    });
  });

  it('masks and reveals ClickHouse credentials with database selection', async () => {
    const service = createService({
      id: 'db-ch-1',
      slug: 'analytics-clickhouse',
      name: 'Analytics ClickHouse',
      type: 'clickhouse',
      description: null,
      tags: [],
      manualSizeLimitMb: null,
      host: 'ch.example.com',
      port: 8443,
      databaseName: 'analytics',
      username: 'reporter',
      tlsEnabled: true,
      encryptedConfig: encryptedConfig({
        type: 'clickhouse',
        url: 'https://ch.example.com/',
        host: 'ch.example.com',
        port: 8443,
        database: 'analytics',
        username: 'reporter',
        password: 'secret password',
        tlsEnabled: true,
      }),
      healthStatus: 'online',
      lastHealthCheckAt: null,
      lastError: null,
      healthHistory: [],
      folderId: null,
      sortOrder: 0,
      createdById: 'user-1',
      updatedById: null,
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
      updatedAt: new Date('2026-06-21T10:00:00.000Z'),
    });

    await expect(service.get('db-ch-1')).resolves.toMatchObject({
      type: 'clickhouse',
      hasStoredPassword: true,
      capabilities: { catalogExplorer: true, rowUpdate: true },
      config: { password: '••••••••', url: 'https://ch.example.com/' },
    });
    await expect(service.revealCredentials('db-ch-1')).resolves.toMatchObject({
      password: 'secret password',
      connectionString: expect.stringContaining('database=analytics'),
    });
  });

  it('does not expose a managed database owner through the generic credential endpoint', async () => {
    const service = createService(
      {
        id: 'db-managed-1',
        type: 'postgres',
        encryptedConfig: encryptedConfig({
          type: 'postgres',
          host: 'managed.gateway.internal',
          port: 5432,
          database: 'app',
          username: 'app_owner',
          password: 'internal-owner-password',
          sslEnabled: false,
        }),
      },
      {
        id: 'managed-1',
        nodeId: 'node-1',
        version: '17.5',
        storageSizeBytes: 1,
        runtimeConfig: {},
        engineConfig: {},
        publishedPort: 32768,
        status: 'ready',
        lastError: null,
        serviceAddress: '127.0.0.1',
        lastHealthReport: null,
        nodeStatus: 'online',
      }
    );

    await expect(service.revealCredentials('db-managed-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MANAGED_DATABASE_CREDENTIALS_REQUIRE_DIRECT_ACCESS',
    });
  });
});

describe('managed ClickHouse query principals', () => {
  const canonicalConfig = {
    type: 'clickhouse' as const,
    url: 'https://owner.internal/',
    host: 'owner.internal',
    port: 8443,
    database: 'app',
    username: 'clickhouse_owner',
    password: 'owner-password',
    tlsEnabled: true,
  };

  function createManagedClickHouseService() {
    const service = new DatabaseConnectionService(
      {} as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn((payload: { payload: string }) => payload.payload) } as never,
      { getEndpoint: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 19443 }) } as never
    );
    const internal = service as any;
    vi.spyOn(internal, 'getRow').mockResolvedValue({
      encryptedConfig: JSON.stringify({ payload: JSON.stringify(canonicalConfig) }),
    });
    vi.spyOn(internal, 'getManagedMetadata').mockResolvedValue({ id: 'managed-clickhouse-1' });
    return { service, internal };
  }

  it('uses the reader identity instead of the canonical owner for read-scoped ClickHouse SQL', async () => {
    const { service, internal } = createManagedClickHouseService();
    const principal = vi.spyOn(internal, 'getManagedClickHouseQueryPrincipal').mockResolvedValue({
      username: 'gw_clickhouse_query_reader',
      password: 'reader-password',
    });

    await expect(service.getDecryptedConfig('db-1', 'interactive', 'read')).resolves.toMatchObject({
      username: 'gw_clickhouse_query_reader',
      password: 'reader-password',
      host: '127.0.0.1',
      port: 19443,
      tlsEnabled: false,
    });
    expect(principal).toHaveBeenCalledWith('db-1', 'read');
  });

  it('fails closed instead of falling back to the owner when the secure reader is unavailable', async () => {
    const { service, internal } = createManagedClickHouseService();
    vi.spyOn(internal, 'getManagedClickHouseQueryPrincipal').mockResolvedValue(undefined);

    await expect(service.getDecryptedConfig('db-1', 'interactive', 'read')).rejects.toMatchObject({
      code: 'MANAGED_CLICKHOUSE_QUERY_ACCESS_UNAVAILABLE',
    });
  });
});

describe('managed PostgreSQL tunnel TLS', () => {
  it('preserves PostgreSQL SSL negotiation through the opaque managed tunnel', async () => {
    const config = {
      type: 'postgres' as const,
      host: 'managed.gateway.internal',
      port: 5432,
      database: 'app',
      username: 'postgres_owner',
      password: 'owner-password',
      sslEnabled: true,
    };
    const service = new DatabaseConnectionService(
      {} as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn((payload: { payload: string }) => payload.payload) } as never,
      { getEndpoint: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 15432 }) } as never
    );
    const internal = service as any;
    vi.spyOn(internal, 'getRow').mockResolvedValue({
      encryptedConfig: JSON.stringify({ payload: JSON.stringify(config) }),
    });
    vi.spyOn(internal, 'getManagedMetadata').mockResolvedValue({ id: 'managed-postgres-1' });

    await expect(service.getDecryptedConfig('db-1', 'monitoring')).resolves.toMatchObject({
      host: '127.0.0.1',
      port: 15432,
      sslEnabled: true,
    });
  });
});

describe('DatabaseConnectionService credential retargeting guard', () => {
  function encryptedConfig(config: Record<string, unknown>) {
    return JSON.stringify({ payload: JSON.stringify(config) });
  }

  function createUpdateService(rowOverride: Record<string, unknown> = {}) {
    const row = {
      id: 'db-1',
      name: 'Production Postgres',
      type: 'postgres',
      description: null,
      tags: [],
      manualSizeLimitMb: null,
      host: 'db.example.com',
      port: 5432,
      databaseName: 'app',
      username: 'app_user',
      tlsEnabled: true,
      encryptedConfig: encryptedConfig({
        type: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'app',
        username: 'app_user',
        password: 'secret-password',
        sslEnabled: true,
      }),
      healthStatus: 'online',
      lastHealthCheckAt: null,
      lastError: null,
      healthHistory: [],
      createdById: 'user-1',
      updatedById: null,
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
      updatedAt: new Date('2026-06-21T10:00:00.000Z'),
      ...rowOverride,
    };
    const capturedUpdates: Record<string, unknown>[] = [];
    const db = {
      query: {
        databaseConnections: {
          findFirst: vi.fn().mockResolvedValue(row),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn((updates: Record<string, unknown>) => {
          capturedUpdates.push(updates);
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ ...row, ...updates }]),
            })),
          };
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
          })),
        })),
      })),
    };
    const cryptoService = {
      decryptString: vi.fn((payload: { payload: string }) => payload.payload),
      encryptString: vi.fn((value: string) => ({ payload: value })),
    };
    const service = new DatabaseConnectionService(
      db as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      cryptoService as never
    );
    const testNormalizedConnection = vi
      .spyOn(
        service as unknown as { testNormalizedConnection: (config: unknown) => Promise<unknown> },
        'testNormalizedConnection'
      )
      .mockResolvedValue({ status: 'online', responseMs: 1 });
    return { capturedUpdates, cryptoService, db, service, testNormalizedConnection };
  }

  function decryptCapturedConfig(capturedUpdates: Record<string, unknown>[], cryptoService: { decryptString: any }) {
    const encryptedConfig = capturedUpdates[0]?.encryptedConfig as string;
    const encryptedPayload = JSON.parse(encryptedConfig) as { payload: string };
    return JSON.parse(cryptoService.decryptString(encryptedPayload));
  }

  it('preserves the stored password for metadata-only edits', async () => {
    const { capturedUpdates, cryptoService, service } = createUpdateService();

    await service.update('db-1', { name: 'Renamed Postgres' }, 'user-1');

    const config = decryptCapturedConfig(capturedUpdates, cryptoService);
    expect(config.password).toBe('secret-password');
    expect(config.host).toBe('db.example.com');
  });

  it('clears legacy manual size limits when a ClickHouse connection is updated', async () => {
    const { capturedUpdates, service } = createUpdateService({
      type: 'clickhouse',
      name: 'Analytics ClickHouse',
      manualSizeLimitMb: 2048,
      host: 'ch.example.com',
      port: 8443,
      databaseName: 'analytics',
      username: 'reporter',
      tlsEnabled: true,
      encryptedConfig: encryptedConfig({
        type: 'clickhouse',
        url: 'https://ch.example.com:8443/',
        host: 'ch.example.com',
        port: 8443,
        database: 'analytics',
        username: 'reporter',
        password: 'secret-password',
        tlsEnabled: true,
      }),
    });

    await service.update('db-1', { name: 'Renamed ClickHouse' }, 'user-1');

    expect(capturedUpdates[0]?.manualSizeLimitMb).toBeNull();
  });

  it('rejects target-changing edits without a replacement password before testing the connection', async () => {
    const { db, service, testNormalizedConnection } = createUpdateService();

    await expect(service.update('db-1', { config: { host: 'db-alt.example.com' } }, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CREDENTIAL_REENTRY_REQUIRED',
    });
    expect(testNormalizedConnection).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows target-changing edits with a replacement password', async () => {
    const { capturedUpdates, cryptoService, service } = createUpdateService();

    await service.update('db-1', { config: { host: 'db-alt.example.com', password: 'new-secret-password' } }, 'user-1');

    const config = decryptCapturedConfig(capturedUpdates, cryptoService);
    expect(config.host).toBe('db-alt.example.com');
    expect(config.password).toBe('new-secret-password');
  });

  it('uses a password embedded in a replacement connection string instead of the old saved password', async () => {
    const { capturedUpdates, cryptoService, service } = createUpdateService();

    await service.update(
      'db-1',
      {
        config: {
          connectionString: 'postgresql://app_user:embedded-secret@db-alt.example.com:5432/app?sslmode=require',
        },
      },
      'user-1'
    );

    const config = decryptCapturedConfig(capturedUpdates, cryptoService);
    expect(config.host).toBe('db-alt.example.com');
    expect(config.password).toBe('embedded-secret');
  });
});
