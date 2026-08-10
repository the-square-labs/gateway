import { describe, expect, it, vi } from 'vitest';
import { createService, USER } from './mcp-ai-audit.test-helpers.js';

describe('AIService MCP database audit behavior', () => {
  it('requires database view scope in addition to query scope before executing database tools', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      executePostgresSql: vi.fn().mockResolvedValue({ rows: [{ ok: true }] }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const deniedUser = { ...USER, scopes: ['databases:query:read'] };
    const denied = await service.executeTool(
      deniedUser,
      'query_postgres_read',
      { databaseId: 'db-1', sql: 'select 1' },
      { source: 'mcp', scopes: deniedUser.scopes }
    );

    expect(denied.error).toContain('PERMISSION_DENIED: Missing required scope databases:view:db-1');
    expect(databaseService.executePostgresSql).not.toHaveBeenCalled();

    const allowedUser = { ...USER, scopes: ['databases:view', 'databases:query:read'] };
    const allowed = await service.executeTool(
      allowedUser,
      'query_postgres_read',
      { databaseId: 'db-1', sql: 'select 1' },
      { source: 'mcp', scopes: allowedUser.scopes }
    );

    expect(allowed.error).toBeUndefined();
    expect(databaseService.executePostgresSql).toHaveBeenCalledWith('db-1', 'select 1', USER.id);
  });

  it('blocks non-read Postgres SQL through the read-only database tool', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      executePostgresSql: vi.fn().mockResolvedValue({ rows: [{ ok: true }] }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['databases:view', 'databases:query:read'] },
      'query_postgres_read',
      {
        databaseId: 'db-1',
        sql: 'delete from users where id = 1',
      }
    );

    expect(result.error).toContain('INVALID_SQL_INTENT');
    expect(databaseService.executePostgresSql).not.toHaveBeenCalled();
  });

  it('requires admin query scope for administrative Postgres SQL through AI/MCP execution', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      executePostgresSql: vi.fn().mockResolvedValue({ rows: [{ ok: true }] }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const deniedUser = { ...USER, scopes: ['databases:view', 'databases:query:write'] };
    const denied = await service.executeTool(
      deniedUser,
      'execute_postgres_sql',
      {
        databaseId: 'db-1',
        sql: 'alter table users add column disabled boolean',
      },
      { source: 'mcp', scopes: deniedUser.scopes }
    );

    expect(denied.error).toContain('PERMISSION_DENIED: Missing required scope databases:query:admin:db-1');
    expect(databaseService.executePostgresSql).not.toHaveBeenCalled();

    const allowedUser = { ...USER, scopes: ['databases:view', 'databases:query:admin'] };
    const allowed = await service.executeTool(
      allowedUser,
      'execute_postgres_sql',
      {
        databaseId: 'db-1',
        sql: 'alter table users add column disabled boolean',
      },
      { source: 'mcp', scopes: allowedUser.scopes }
    );

    expect(allowed.error).toBeUndefined();
    expect(databaseService.executePostgresSql).toHaveBeenCalledWith(
      'db-1',
      'alter table users add column disabled boolean',
      USER.id
    );
  });

  it('allows read-only SQL through the generic Postgres execution tool with read query scope', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      executePostgresSql: vi.fn().mockResolvedValue({ rows: [{ ok: true }] }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['databases:view:db-1', 'databases:query:read:db-1'] },
      'execute_postgres_sql',
      {
        databaseId: 'db-1',
        sql: 'select 1',
      }
    );

    expect(result.error).toBeUndefined();
    expect(databaseService.executePostgresSql).toHaveBeenCalledWith('db-1', 'select 1', USER.id);
  });

  it('allows write SQL through the generic Postgres execution tool with write query scope', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      executePostgresSql: vi.fn().mockResolvedValue({ rows: [{ ok: true }] }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['databases:view:db-1', 'databases:query:write:db-1'] },
      'execute_postgres_sql',
      {
        databaseId: 'db-1',
        sql: 'update users set disabled = true where id = 1',
      }
    );

    expect(result.error).toBeUndefined();
    expect(databaseService.executePostgresSql).toHaveBeenCalledWith(
      'db-1',
      'update users set disabled = true where id = 1',
      USER.id
    );
  });

  it('filters database list tools to delegated resource-scoped view grants', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'db-1' }], pagination: { page: 1, limit: 100, total: 1 } }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['databases:view:db-1'] },
      'list_databases',
      { search: 'prod' },
      { source: 'mcp', scopes: ['databases:view:db-1'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(result.error).toBeUndefined();
    expect(databaseService.list).toHaveBeenCalledWith(
      { page: 1, limit: 100, search: 'prod', type: undefined, healthStatus: undefined },
      { allowedIds: ['db-1'] }
    );
  });

  it('does not treat database query scopes as view grants for database list tools', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      list: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, limit: 100, total: 0 } }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['databases:query:read:db-1'] },
      'list_databases',
      {},
      {
        source: 'mcp',
        scopes: ['databases:query:read:db-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(result.error).toContain('PERMISSION_DENIED');
    expect(databaseService.list).not.toHaveBeenCalled();
  });

  it('requires admin query scope for Postgres schema changes through aggregate tools', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const databaseService = {
      addPostgresColumn: vi.fn().mockResolvedValue({ ok: true }),
    };
    const service = createService({ nodesService: {}, databaseService, auditService });

    const denied = await service.executeTool(
      { ...USER, scopes: ['databases:view:db-1', 'databases:query:write:db-1'] },
      'manage_postgres_data',
      {
        operation: 'add_column',
        databaseId: 'db-1',
        schema: 'public',
        table: 'users',
        column: 'flags',
        dataType: 'jsonb',
      },
      {
        source: 'mcp',
        scopes: ['databases:view:db-1', 'databases:query:write:db-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(denied.error).toContain('PERMISSION_DENIED');
    expect(databaseService.addPostgresColumn).not.toHaveBeenCalled();

    const allowed = await service.executeTool(
      { ...USER, scopes: ['databases:view:db-1', 'databases:query:admin:db-1'] },
      'manage_postgres_data',
      {
        operation: 'add_column',
        databaseId: 'db-1',
        schema: 'public',
        table: 'users',
        column: 'flags',
        dataType: 'jsonb',
      },
      {
        source: 'mcp',
        scopes: ['databases:view:db-1', 'databases:query:admin:db-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(allowed.error).toBeUndefined();
    expect(databaseService.addPostgresColumn).toHaveBeenCalledWith(
      'db-1',
      'public',
      'users',
      'flags',
      'jsonb',
      USER.id
    );
  });
});
