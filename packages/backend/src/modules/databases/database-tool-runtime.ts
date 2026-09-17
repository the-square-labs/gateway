import { hasScope } from '@/lib/permissions.js';
import { directResourceIdsForScopes } from '@/modules/ai/ai.service-helpers.js';
import {
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  DeletePostgresColumnSchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  UpdateDatabaseConnectionSchema,
  UpdatePostgresColumnTypeSchema,
} from '@/modules/databases/databases.schemas.js';
export const databaseToolRuntime = {
  hasScope,
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  DeletePostgresColumnSchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  UpdateDatabaseConnectionSchema,
  UpdatePostgresColumnTypeSchema,
  directResourceIdsForScopes,
};
