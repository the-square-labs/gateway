import { container } from '@/container.js';
import { hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { directResourceIdsForScopes } from '@/modules/ai/ai.service-helpers.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import {
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  BrowseSqlRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  DeletePostgresColumnSchema,
  DeleteSqlRowSchema,
  ExecuteSqlSchema,
  InsertSqlRowSchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  SqlTableQuerySchema,
  UpdateDatabaseConnectionSchema,
  UpdatePostgresColumnTypeSchema,
  UpdateSqlRowSchema,
} from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
export const databaseToolRuntime = {
  container,
  hasScope,
  hasScopeBase,
  hasScopeForCreation,
  AppError,
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  BrowseSqlRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  DeletePostgresColumnSchema,
  DeleteSqlRowSchema,
  ExecuteSqlSchema,
  InsertSqlRowSchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  SqlTableQuerySchema,
  UpdateDatabaseConnectionSchema,
  UpdatePostgresColumnTypeSchema,
  UpdateSqlRowSchema,
  DatabaseFolderService,
  DatabaseMonitoringService,
  ManagedDatabaseService,
  directResourceIdsForScopes,
};
