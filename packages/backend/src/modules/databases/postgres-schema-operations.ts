import type pg from 'pg';
import { AppError } from '@/middleware/error-handler.js';
import type { DatabaseOperation } from './database-error-mapping.js';
import type { PostgresTableMetadata } from './postgres-row-operations.js';

export interface PostgresSchemaOperationContext {
  withPostgresPool<T>(id: string, operation: DatabaseOperation, fn: (pool: pg.Pool) => Promise<T>): Promise<T>;
}

export async function listPostgresSchemas(context: PostgresSchemaOperationContext, id: string) {
  return context.withPostgresPool(id, 'query', async (pool) => {
    const result = await pool.query<{ schema_name: string }>(
      `select distinct table_schema as schema_name
           from information_schema.tables
         where table_schema not in ('information_schema', 'pg_catalog')
         order by schema_name asc`
    );
    return result.rows.map((row) => row.schema_name);
  });
}

export async function listPostgresTables(context: PostgresSchemaOperationContext, id: string, schema: string) {
  return context.withPostgresPool(id, 'query', async (pool) => {
    const result = await pool.query<{
      table_name: string;
      table_type: string;
    }>(
      `select table_name, table_type
           from information_schema.tables
          where table_schema = $1
          order by table_name asc`,
      [schema]
    );
    return result.rows.map((row) => ({
      name: row.table_name,
      type: row.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  });
}

export async function getPostgresTableMetadata(
  context: PostgresSchemaOperationContext,
  id: string,
  schema: string,
  table: string
): Promise<PostgresTableMetadata> {
  return context.withPostgresPool(id, 'query', async (pool) => {
    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      udt_schema: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
      is_identity: 'YES' | 'NO';
      is_generated: 'ALWAYS' | 'NEVER';
      ordinal_position: number;
    }>(
      `select column_name, data_type, udt_name, udt_schema, is_nullable, column_default, is_identity, is_generated, ordinal_position
           from information_schema.columns
          where table_schema = $1 and table_name = $2
          order by ordinal_position asc`,
      [schema, table]
    );
    if (columns.rows.length === 0) {
      throw new AppError(404, 'TABLE_NOT_FOUND', 'Table or view not found');
    }

    const primaryKeys = await pool.query<{ column_name: string }>(
      `select kcu.column_name
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on tc.constraint_name = kcu.constraint_name
            and tc.table_schema = kcu.table_schema
          where tc.constraint_type = 'PRIMARY KEY'
            and tc.table_schema = $1
            and tc.table_name = $2
          order by kcu.ordinal_position asc`,
      [schema, table]
    );

    const pkSet = new Set(primaryKeys.rows.map((row) => row.column_name));
    return {
      schema,
      table,
      columns: columns.rows.map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
        udtName: column.udt_name,
        udtSchema: column.udt_schema,
        nullable: column.is_nullable === 'YES',
        isPrimaryKey: pkSet.has(column.column_name),
        hasDefault: column.column_default !== null || column.is_identity === 'YES' || column.is_generated === 'ALWAYS',
      })),
      primaryKey: primaryKeys.rows.map((row) => row.column_name),
      hasPrimaryKey: primaryKeys.rows.length > 0,
    };
  });
}
