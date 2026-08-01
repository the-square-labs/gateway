import type {
  SqlDatabaseAdapter,
  SqlExecutionResult,
  SqlRowMutationResult,
  SqlTableMetadata,
} from './sql-database-adapter.js';

interface PostgresSqlAdapterContext {
  listSchemas(id: string): Promise<string[]>;
  listTables(id: string, schema: string): Promise<Array<{ name: string; type: 'table' | 'view' }>>;
  getTableMetadata(
    id: string,
    schema: string,
    table: string
  ): Promise<{
    schema: string;
    table: string;
    columns: Array<{
      name: string;
      dataType: string;
      udtName: string;
      udtSchema: string;
      nullable: boolean;
      isPrimaryKey: boolean;
      hasDefault: boolean;
    }>;
    primaryKey: string[];
    hasPrimaryKey: boolean;
  }>;
  browseRows(
    id: string,
    schema: string,
    table: string,
    page: number,
    limit: number,
    sortBy?: string,
    sortOrder?: 'asc' | 'desc',
    search?: {
      column: string;
      operation: 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
      value: string;
    }
  ): Promise<{
    metadata: unknown;
    rows: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
  }>;
  executeSql(id: string, sql: string, userId: string, options?: { maxRows?: number }): Promise<SqlExecutionResult>;
  insertRow(
    id: string,
    schema: string,
    table: string,
    values: Record<string, unknown>,
    userId: string
  ): Promise<unknown>;
  updateRow(
    id: string,
    schema: string,
    table: string,
    primaryKey: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string
  ): Promise<unknown>;
  deleteRow(
    id: string,
    schema: string,
    table: string,
    primaryKey: Record<string, unknown>,
    userId: string
  ): Promise<unknown>;
  inferIntent(sql: string): 'read' | 'write' | 'admin';
}

export class PostgresSqlAdapter implements SqlDatabaseAdapter {
  readonly type = 'postgres' as const;
  readonly capabilities = {
    sqlConsole: true,
    catalogExplorer: true,
    rowInsert: true,
    rowUpdate: true,
    rowDelete: true,
    schemaMutation: true,
    exactRowCount: true,
  } as const;

  constructor(private readonly context: PostgresSqlAdapterContext) {}

  inferIntent(sql: string) {
    return this.context.inferIntent(sql);
  }

  async listNamespaces(id: string) {
    const schemas = await this.context.listSchemas(id);
    return schemas.map((name) => ({ name, system: false }));
  }

  async listObjects(id: string, namespace: string) {
    const tables = await this.context.listTables(id, namespace);
    return tables.map((table) => ({ name: table.name, type: table.type }));
  }

  async getTableMetadata(id: string, namespace: string, table: string): Promise<SqlTableMetadata> {
    const [metadata, objects] = await Promise.all([
      this.context.getTableMetadata(id, namespace, table),
      this.context.listTables(id, namespace),
    ]);
    const objectType = objects.find((object) => object.name === table)?.type ?? 'table';
    return {
      provider: 'postgres',
      namespace,
      table,
      objectType,
      columns: metadata.columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nativeTypeName: column.udtName,
        nativeTypeNamespace: column.udtSchema,
        nullable: column.nullable,
        isPrimaryKey: column.isPrimaryKey,
        hasDefault: column.hasDefault,
      })),
      primaryKey: metadata.primaryKey,
      hasPrimaryKey: metadata.hasPrimaryKey,
      mutations: {
        rowInsert: objectType === 'table',
        rowUpdate: objectType === 'table' && metadata.hasPrimaryKey,
        rowDelete: objectType === 'table' && metadata.hasPrimaryKey,
        identityColumns: metadata.primaryKey,
        immutableColumns: metadata.primaryKey,
        reason:
          objectType !== 'table'
            ? 'Views are browse-only'
            : !metadata.hasPrimaryKey
              ? 'Inline update and delete require a primary key'
              : undefined,
      },
    };
  }

  async browseRows(
    id: string,
    namespace: string,
    table: string,
    page: number,
    limit: number,
    options?: {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      search?: {
        column: string;
        operation: 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
        value: string;
      };
    }
  ) {
    const result = await this.context.browseRows(
      id,
      namespace,
      table,
      page,
      limit,
      options?.sortBy,
      options?.sortOrder,
      options?.search
    );
    return {
      metadata: await this.getTableMetadata(id, namespace, table),
      rows: result.rows,
      total: result.total,
      totalKind: 'exact' as const,
      page: result.page,
      limit: result.limit,
      truncated: false,
    };
  }

  async insertRow(
    id: string,
    namespace: string,
    table: string,
    values: Record<string, unknown>,
    userId: string
  ): Promise<SqlRowMutationResult> {
    await this.context.insertRow(id, namespace, table, values, userId);
    return { success: true, affectedRows: 1 };
  }

  async updateRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string
  ): Promise<SqlRowMutationResult> {
    await this.context.updateRow(id, namespace, table, locator, values, userId);
    return { success: true, affectedRows: 1 };
  }

  async deleteRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    userId: string
  ): Promise<SqlRowMutationResult> {
    await this.context.deleteRow(id, namespace, table, locator, userId);
    return { success: true, affectedRows: 1 };
  }

  executeSql(id: string, sql: string, userId: string, options?: { maxRows?: number }) {
    return this.context.executeSql(id, sql, userId, options);
  }
}
