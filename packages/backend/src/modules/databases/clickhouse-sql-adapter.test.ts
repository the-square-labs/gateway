import { describe, expect, it, vi } from 'vitest';
import { ClickHouseSqlAdapter } from './clickhouse-sql-adapter.js';

function result<T>(data: T, queryId = 'query-1') {
  return {
    query_id: queryId,
    json: vi.fn().mockResolvedValue(data),
  };
}

function createAdapter(query: ReturnType<typeof vi.fn>, command = vi.fn()) {
  const auditLog = vi.fn().mockResolvedValue(undefined);
  const emitChange = vi.fn();
  const client = { query, command };
  const adapter = new ClickHouseSqlAdapter({
    withClient: async (_id, _operation, run) => run(client as never),
    auditLog,
    emitChange,
  });
  return { adapter, auditLog, command, emitChange };
}

function mutableTableQuery(matched = 1) {
  return vi.fn(async ({ query: sql }: { query: string }) => {
    if (sql.includes('FROM system.tables') && sql.includes('AND name')) {
      return result([
        {
          engine: 'MergeTree',
          sorting_key: 'id',
          primary_key: 'id',
          partition_key: '',
          total_rows: '3',
          total_bytes: '128',
          create_table_query:
            'CREATE TABLE analytics.events (id UInt64, name String) ENGINE = MergeTree ORDER BY id SETTINGS enable_block_number_column = 1',
          server_version: '26.2.10.10',
        },
      ]);
    }
    if (sql.includes('FROM system.columns')) {
      return result([
        {
          name: 'id',
          type: 'UInt64',
          default_kind: '',
          default_expression: '',
          comment: '',
          is_in_primary_key: 1,
          is_in_sorting_key: 1,
          is_in_partition_key: 0,
        },
        {
          name: 'name',
          type: 'String',
          default_kind: '',
          default_expression: '',
          comment: '',
          is_in_primary_key: 0,
          is_in_sorting_key: 0,
          is_in_partition_key: 0,
        },
      ]);
    }
    if (sql.includes('SELECT count() AS matched')) return result([{ matched }]);
    throw new Error(`Unexpected query: ${sql}`);
  });
}

describe('ClickHouseSqlAdapter', () => {
  it('lists accessible namespaces and preserves system classification', async () => {
    const query = vi.fn().mockResolvedValue(result([{ name: 'analytics' }, { name: 'system' }]));
    const { adapter } = createAdapter(query);

    await expect(adapter.listNamespaces('db-1')).resolves.toEqual([
      { name: 'analytics', system: false },
      { name: 'system', system: true },
    ]);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ format: 'JSONEachRow' }));
  });

  it('returns ClickHouse metadata and bounded read-only rows without an exact count', async () => {
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      if (sql.includes('FROM system.tables') && sql.includes('AND name')) {
        return result([
          {
            engine: 'MergeTree',
            sorting_key: 'id',
            primary_key: 'id',
            partition_key: 'toDate(ts)',
            total_rows: '1200',
            total_bytes: '4096',
            create_table_query:
              'CREATE TABLE analytics.events (id UInt64) ENGINE = MergeTree ORDER BY id SETTINGS enable_block_number_column = 1',
            server_version: '26.2.10.10',
          },
        ]);
      }
      if (sql.includes('FROM system.columns')) {
        return result([
          {
            name: 'id',
            type: 'UInt64',
            default_kind: '',
            default_expression: '',
            comment: '',
            is_in_primary_key: 1,
            is_in_sorting_key: 1,
            is_in_partition_key: 0,
          },
        ]);
      }
      return result({
        data: [{ id: '9007199254740993' }],
        meta: [{ name: 'id', type: 'UInt64' }],
        rows: 1,
        statistics: { elapsed: 0.002, rows_read: 1, bytes_read: 8 },
      });
    });
    const { adapter } = createAdapter(query);

    await expect(adapter.browseRows('db-1', 'analytics', 'events', 1, 100)).resolves.toMatchObject({
      rows: [{ id: '9007199254740993' }],
      total: 1200,
      totalKind: 'approximate',
      truncated: false,
      metadata: {
        provider: 'clickhouse',
        namespace: 'analytics',
        table: 'events',
        engine: 'MergeTree',
        primaryKey: ['id'],
        mutations: expect.objectContaining({ rowInsert: true, rowUpdate: true, rowDelete: true }),
      },
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.objectContaining({
        format: 'JSON',
        clickhouse_settings: expect.objectContaining({ readonly: '1', max_result_rows: '100' }),
      })
    );
  });

  it('inserts a parameterized ClickHouse row and audits the mutation', async () => {
    const query = mutableTableQuery();
    const command = vi.fn().mockResolvedValue({ query_id: 'insert-1' });
    const { adapter, auditLog, emitChange } = createAdapter(query, command);

    await expect(
      adapter.insertRow('db-1', 'analytics', 'events', { id: '4', name: 'signup' }, 'user-1')
    ).resolves.toEqual({ success: true, affectedRows: 1, queryId: 'insert-1' });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('INSERT INTO "analytics"."events"'),
        query_params: { value_0: '4', value_1: 'signup' },
      })
    );
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'database.clickhouse.row.insert' }));
    expect(emitChange).toHaveBeenCalledWith(
      'db-1',
      'data.updated',
      expect.objectContaining({ provider: 'clickhouse' })
    );
  });

  it('keeps lightweight UPDATE disabled when the table lacks block-number columns', async () => {
    const query = mutableTableQuery();
    query.mockImplementation(async ({ query: sql }: { query: string }) => {
      if (sql.includes('FROM system.tables') && sql.includes('AND name')) {
        return result([
          {
            engine: 'MergeTree',
            sorting_key: 'id',
            primary_key: 'id',
            partition_key: '',
            total_rows: '3',
            total_bytes: '128',
            create_table_query: 'CREATE TABLE analytics.events (id UInt64, name String) ENGINE = MergeTree ORDER BY id',
            server_version: '26.2.10.10',
          },
        ]);
      }
      if (sql.includes('FROM system.columns')) {
        return result([
          {
            name: 'id',
            type: 'UInt64',
            default_kind: '',
            default_expression: '',
            comment: '',
            is_in_primary_key: 1,
            is_in_sorting_key: 1,
            is_in_partition_key: 0,
          },
          {
            name: 'name',
            type: 'String',
            default_kind: '',
            default_expression: '',
            comment: '',
            is_in_primary_key: 0,
            is_in_sorting_key: 0,
            is_in_partition_key: 0,
          },
        ]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const command = vi.fn();
    const { adapter } = createAdapter(query, command);

    await expect(adapter.getTableMetadata('db-1', 'analytics', 'events')).resolves.toMatchObject({
      mutations: {
        rowInsert: true,
        rowUpdate: false,
        rowDelete: true,
        reason: 'Lightweight UPDATE requires enable_block_number_column = 1 on this table',
      },
    });
    await expect(
      adapter.updateRow('db-1', 'analytics', 'events', { id: '2' }, { name: 'purchase' }, 'user-1')
    ).rejects.toMatchObject({ code: 'CLICKHOUSE_ROW_MUTATION_UNSUPPORTED' });
    expect(command).not.toHaveBeenCalled();
  });

  it('updates one uniquely matched row without allowing key-column changes', async () => {
    const query = mutableTableQuery(1);
    const command = vi.fn().mockResolvedValue({ query_id: 'update-1' });
    const { adapter } = createAdapter(query, command);

    await expect(
      adapter.updateRow('db-1', 'analytics', 'events', { id: '2' }, { name: 'purchase' }, 'user-1')
    ).resolves.toEqual({ success: true, affectedRows: 1, queryId: 'update-1' });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('UPDATE "analytics"."events" SET "name"'),
        query_params: { identity_0: '2', value_0: 'purchase' },
      })
    );

    await expect(
      adapter.updateRow('db-1', 'analytics', 'events', { id: '2' }, { id: '3' }, 'user-1')
    ).rejects.toMatchObject({ code: 'IMMUTABLE_CLICKHOUSE_COLUMN' });
  });

  it('rejects update and delete when a ClickHouse identity matches multiple rows', async () => {
    const query = mutableTableQuery(2);
    const command = vi.fn();
    const { adapter } = createAdapter(query, command);

    await expect(
      adapter.updateRow('db-1', 'analytics', 'events', { id: '2' }, { name: 'purchase' }, 'user-1')
    ).rejects.toMatchObject({ code: 'ROW_IDENTITY_NOT_UNIQUE' });
    await expect(adapter.deleteRow('db-1', 'analytics', 'events', { id: '2' }, 'user-1')).rejects.toMatchObject({
      code: 'ROW_IDENTITY_NOT_UNIQUE',
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('deletes one uniquely matched ClickHouse row with lightweight DELETE', async () => {
    const query = mutableTableQuery(1);
    const command = vi.fn().mockResolvedValue({ query_id: 'delete-1' });
    const { adapter } = createAdapter(query, command);

    await expect(adapter.deleteRow('db-1', 'analytics', 'events', { id: '2' }, 'user-1')).resolves.toEqual({
      success: true,
      affectedRows: 1,
      queryId: 'delete-1',
    });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining('DELETE FROM "analytics"."events"') })
    );
  });

  it('executes bounded SELECT output and records a provider-specific audit event', async () => {
    const query = vi.fn().mockResolvedValue(
      result({
        query_id: 'select-1',
        data: [{ value: '18446744073709551615' }],
        meta: [{ name: 'value', type: 'UInt64' }],
        rows: 1,
        statistics: { elapsed: 0.003, rows_read: 1, bytes_read: 8 },
      })
    );
    const { adapter, auditLog, emitChange } = createAdapter(query);

    await expect(adapter.executeSql('db-1', 'select 1 as value', 'user-1', { maxRows: 20 })).resolves.toEqual({
      results: [
        expect.objectContaining({
          command: 'SELECT',
          queryId: 'select-1',
          fields: ['value'],
          columns: [{ name: 'value', type: 'UInt64' }],
          rows: [{ value: '18446744073709551615' }],
          maxRows: 20,
        }),
      ],
      truncated: false,
      resultLimit: 10,
    });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'database.clickhouse.query' }));
    expect(emitChange).toHaveBeenCalledWith(
      'db-1',
      'query.executed',
      expect.objectContaining({ provider: 'clickhouse' })
    );
  });

  it('classifies mutations as admin commands and reports written rows', async () => {
    const query = vi.fn();
    const command = vi.fn().mockResolvedValue({
      query_id: 'command-1',
      summary: { written_rows: '3', result_rows: '0' },
    });
    const { adapter } = createAdapter(query, command);

    await expect(adapter.executeSql('db-1', 'alter table events delete where id = 1', 'user-1')).resolves.toMatchObject(
      {
        results: [{ command: 'ALTER', queryId: 'command-1', rowCount: 3 }],
      }
    );
    expect(query).not.toHaveBeenCalled();
  });
});
