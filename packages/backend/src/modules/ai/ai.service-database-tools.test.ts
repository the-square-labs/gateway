import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService(databaseService: Record<string, unknown>) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    databaseService as never,
    {} as never
  );
}

describe('AIService database tool routing', () => {
  it('lists only database connections allowed by direct resource-scoped view grants', async () => {
    const databaseService = {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'db-1' }], total: 1 }),
    };
    const service = createService(databaseService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['databases:view:db-1'] }, 'list_databases', {
        search: 'prod',
        type: 'postgres',
        healthStatus: 'online',
      })
    ).resolves.toEqual({
      result: { data: [{ id: 'db-1' }], total: 1 },
      invalidateStores: [],
    });
    expect(databaseService.list).toHaveBeenCalledWith(
      {
        page: 1,
        limit: 100,
        search: 'prod',
        type: 'postgres',
        healthStatus: 'online',
      },
      { allowedIds: ['db-1'] }
    );
  });

  it('rejects direct database reads for a different resource id after tool-level filtering passes', async () => {
    const databaseService = {
      get: vi.fn(),
    };
    const service = createService(databaseService);

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['databases:view:db-2'] },
      'get_database_connection',
      { databaseId: 'db-1' }
    );

    expect(result.error).toBe('PERMISSION_DENIED: Missing required scope databases:view:db-1');
    expect(databaseService.get).not.toHaveBeenCalled();
  });

  it('requires database edit scope before testing a saved connection', async () => {
    const databaseService = {
      testSavedConnection: vi.fn().mockResolvedValue({ ok: true }),
    };
    const service = createService(databaseService);

    const viewResult = await service.executeTool(
      { ...BASE_USER, scopes: ['databases:view:db-1'] },
      'manage_database_connection',
      { operation: 'test', databaseId: 'db-1' }
    );
    expect(viewResult.error).toBe('PERMISSION_DENIED: Missing required scope databases:edit:db-1');
    expect(databaseService.testSavedConnection).not.toHaveBeenCalled();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['databases:edit:db-1'] }, 'manage_database_connection', {
        operation: 'test',
        databaseId: 'db-1',
      })
    ).resolves.toMatchObject({ result: { ok: true } });
    expect(databaseService.testSavedConnection).toHaveBeenCalledWith('db-1', 'user-1');
  });

  it('keeps query_postgres_read read-only even when the user has read query scope', async () => {
    const databaseService = {
      executePostgresSql: vi.fn(),
    };
    const service = createService(databaseService);

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['databases:view:db-1', 'databases:query:read:db-1'] },
      'query_postgres_read',
      { databaseId: 'db-1', sql: 'update users set role = admin' }
    );

    expect(result.error).toBe('INVALID_SQL_INTENT: query_postgres_read only allows read-only Postgres SQL');
    expect(databaseService.executePostgresSql).not.toHaveBeenCalled();
  });

  it('infers stronger Postgres query scope before executing SQL', async () => {
    const databaseService = {
      executePostgresSql: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
    };
    const service = createService(databaseService);

    const readOnlyUser = { ...BASE_USER, scopes: ['databases:view:db-1', 'databases:query:read:db-1'] };
    const writeResult = await service.executeTool(readOnlyUser, 'execute_postgres_sql', {
      databaseId: 'db-1',
      sql: 'insert into users (id) values (1)',
    });

    expect(writeResult.error).toBe('PERMISSION_DENIED: Missing required scope databases:query:write:db-1');
    expect(databaseService.executePostgresSql).not.toHaveBeenCalled();

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['databases:view:db-1', 'databases:query:write:db-1'] },
        'execute_postgres_sql',
        { databaseId: 'db-1', sql: 'insert into users (id) values (1)' }
      )
    ).resolves.toMatchObject({
      result: { rows: [{ id: 1 }] },
      invalidateStores: [],
    });
    expect(databaseService.executePostgresSql).toHaveBeenCalledWith(
      'db-1',
      'insert into users (id) values (1)',
      'user-1'
    );
  });

  it('routes Postgres row edits with parsed table coordinates and unchanged value payloads', async () => {
    const databaseService = {
      insertPostgresRow: vi.fn().mockResolvedValue({ inserted: 1 }),
    };
    const service = createService(databaseService);
    const values = { status: 'active', priority: 3, dueDate: '2026-06-21' };

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['databases:view:db-1', 'databases:query:write:db-1'] },
        'manage_postgres_data',
        {
          operation: 'insert_row',
          databaseId: 'db-1',
          schema: 'public',
          table: 'tasks',
          values,
        }
      )
    ).resolves.toMatchObject({
      result: { inserted: 1 },
      invalidateStores: [],
    });
    expect(databaseService.insertPostgresRow).toHaveBeenCalledWith('db-1', 'public', 'tasks', values, 'user-1');
  });

  it('infers Redis command scope before execution', async () => {
    const databaseService = {
      executeRedisCommand: vi.fn().mockResolvedValue({ ok: true }),
    };
    const service = createService(databaseService);

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['databases:view:db-1', 'databases:query:read:db-1'] },
      'manage_redis_data',
      { operation: 'execute_command', databaseId: 'db-1', command: 'CONFIG GET *' }
    );

    expect(result.error).toBe('PERMISSION_DENIED: Missing required scope databases:query:admin:db-1');
    expect(databaseService.executeRedisCommand).not.toHaveBeenCalled();

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['databases:view:db-1', 'databases:query:admin:db-1'] },
        'manage_redis_data',
        { operation: 'execute_command', databaseId: 'db-1', command: 'CONFIG GET *' }
      )
    ).resolves.toMatchObject({
      result: { ok: true },
      invalidateStores: [],
    });
    expect(databaseService.executeRedisCommand).toHaveBeenCalledWith('db-1', 'CONFIG GET *', 'user-1');
  });
});
