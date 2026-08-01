import { z } from 'zod';

const nameSchema = z.string().trim().min(1).max(255);
const optionalTextSchema = z.string().trim().max(10_000).optional().nullable();
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).optional();

const postgresConnectionFields = z.object({
  connectionString: z.string().trim().min(1).max(4096).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(4096).optional(),
  sslEnabled: z.boolean().optional(),
});

const redisConnectionFields = z.object({
  connectionString: z.string().trim().min(1).max(4096).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(4096).optional(),
  db: z.number().int().min(0).max(15).optional(),
  tlsEnabled: z.boolean().optional(),
});

const clickHouseConnectionFields = z.object({
  connectionString: z.string().trim().min(1).max(4096).optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(4096).optional(),
  tlsEnabled: z.boolean().optional(),
});

export const DatabaseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().optional(),
  type: z.enum(['postgres', 'redis', 'clickhouse']).optional(),
  healthStatus: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
});

export const CreateDatabaseConnectionSchema = z.discriminatedUnion('type', [
  z.object({
    name: nameSchema,
    description: optionalTextSchema,
    tags: tagsSchema,
    manualSizeLimitMb: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional()
      .nullable(),
    type: z.literal('postgres'),
    config: postgresConnectionFields,
  }),
  z.object({
    name: nameSchema,
    description: optionalTextSchema,
    tags: tagsSchema,
    type: z.literal('redis'),
    config: redisConnectionFields,
  }),
  z.object({
    name: nameSchema,
    description: optionalTextSchema,
    tags: tagsSchema,
    type: z.literal('clickhouse'),
    config: clickHouseConnectionFields,
  }),
]);

export const UpdateDatabaseConnectionSchema = z
  .object({
    name: nameSchema.optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    manualSizeLimitMb: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional()
      .nullable(),
    config: z
      .object({
        connectionString: z.string().trim().min(1).max(4096).optional(),
        url: z.string().trim().min(1).max(4096).optional(),
        host: z.string().trim().min(1).max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        database: z.string().trim().min(1).max(255).optional(),
        username: z.string().trim().min(1).max(255).optional(),
        password: z.string().max(4096).optional(),
        sslEnabled: z.boolean().optional(),
        db: z.number().int().min(0).max(15).optional(),
        tlsEnabled: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((data) => !!data.name || data.description !== undefined || !!data.tags || !!data.config, {
    message: 'At least one field must be provided',
  });

export const BrowsePostgresRowsQuerySchema = z.object({
  schema: z.string().trim().min(1).max(255),
  table: z.string().trim().min(1).max(255),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sortBy: z.string().trim().min(1).max(255).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  searchColumn: z.string().trim().min(1).max(255).optional(),
  searchOperation: z.enum(['like', 'equals', 'notEquals', 'greaterThan', 'lessThan']).optional(),
  searchValue: z.string().trim().max(1024).optional(),
});

export const PostgresObjectSchema = z.record(z.string(), z.any());

const PostgresColumnBaseSchema = BrowsePostgresRowsQuerySchema.pick({
  schema: true,
  table: true,
}).extend({
  column: z.string().trim().min(1).max(255),
});

export const AddPostgresColumnSchema = PostgresColumnBaseSchema.extend({
  dataType: z.string().trim().min(1).max(64),
});

export const UpdatePostgresColumnTypeSchema = PostgresColumnBaseSchema.extend({
  dataType: z.string().trim().min(1).max(64),
});

export const DeletePostgresColumnSchema = PostgresColumnBaseSchema;

export const ExecutePostgresSqlSchema = z.object({
  sql: z.string().trim().min(1).max(100_000),
  maxRows: z.number().int().min(1).max(2000).default(500),
});

export const SqlTableQuerySchema = z.object({
  namespace: z.string().trim().min(1).max(255),
  table: z.string().trim().min(1).max(255),
});

export const SqlObjectSchema = z
  .record(z.string(), z.any())
  .refine((value) => Object.keys(value).length > 0, 'At least one column value is required');

export const InsertSqlRowSchema = SqlTableQuerySchema.extend({
  values: SqlObjectSchema,
});

export const UpdateSqlRowSchema = InsertSqlRowSchema.extend({
  locator: SqlObjectSchema,
});

export const DeleteSqlRowSchema = SqlTableQuerySchema.extend({
  locator: SqlObjectSchema,
});

export const BrowseSqlRowsQuerySchema = SqlTableQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sortBy: z.string().trim().min(1).max(255).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  searchColumn: z.string().trim().min(1).max(255).optional(),
  searchOperation: z.enum(['like', 'equals', 'notEquals', 'greaterThan', 'lessThan']).optional(),
  searchValue: z.string().trim().max(1024).optional(),
});

export const ExecuteSqlSchema = ExecutePostgresSqlSchema;

export const RedisScanKeysQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  search: z.string().trim().optional(),
  type: z.string().trim().optional(),
});

export const RedisGetKeyQuerySchema = z.object({
  key: z.string().min(1).max(4096),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  maxStringBytes: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(64 * 1024),
});

export const RedisSetKeySchema = z.object({
  key: z.string().min(1).max(4096),
  type: z.enum(['string', 'hash', 'list', 'set', 'zset']),
  ttlSeconds: z.number().int().min(-1).max(31_536_000).optional(),
  value: z.any(),
});

export const RedisExpireKeySchema = z.object({
  key: z.string().min(1).max(4096),
  ttlSeconds: z.number().int().min(-1).max(31_536_000),
});

export const ExecuteRedisCommandSchema = z.object({
  command: z.string().trim().min(1).max(10_000),
});

export type DatabaseListQuery = z.infer<typeof DatabaseListQuerySchema>;
export type CreateDatabaseConnectionInput = z.infer<typeof CreateDatabaseConnectionSchema>;
export type UpdateDatabaseConnectionInput = z.infer<typeof UpdateDatabaseConnectionSchema>;
