import type pg from 'pg';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DatabaseOperation } from './database-error-mapping.js';
export interface PostgresTableMetadata {
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
}
export interface PostgresRowOperationContext {
  withPostgresPool<T>(id: string, operation: DatabaseOperation, fn: (pool: pg.Pool) => Promise<T>): Promise<T>;
  getPostgresTableMetadata(id: string, schema: string, table: string): Promise<PostgresTableMetadata>;
  auditLog: AuditService['log'];
  emitChange(id: string, action: string, extra?: Record<string, unknown>): void;
}
export declare function insertPostgresRow(
  context: PostgresRowOperationContext,
  id: string,
  schema: string,
  table: string,
  values: Record<string, unknown>,
  userId: string
): Promise<any>;
export declare function updatePostgresRow(
  context: PostgresRowOperationContext,
  id: string,
  schema: string,
  table: string,
  primaryKey: Record<string, unknown>,
  values: Record<string, unknown>,
  userId: string
): Promise<any>;
export declare function deletePostgresRow(
  context: PostgresRowOperationContext,
  id: string,
  schema: string,
  table: string,
  primaryKey: Record<string, unknown>,
  userId: string
): Promise<{
  success: boolean;
}>;
