import { createClient } from '@clickhouse/client';
import { asc, count, eq, ilike, inArray, or } from 'drizzle-orm';
import Redis from 'ioredis';
import pg from 'pg';
import { databaseConnections, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { getEffectiveNodeServiceAddress, getEffectivePublishedNodeIP } from '@/modules/nodes/node-service-address.js';

const { Pool } = pg;
const logger = createChildLogger('DatabaseConnectionService');

export type { ClickHouseClient } from '@clickhouse/client';
export type { SQL } from 'drizzle-orm';
export type { default as RedisClient } from 'ioredis';
export type { default as pg } from 'pg';
export type { DatabaseHealthEntry } from '@/db/schema/index.js';
export const databaseCommercialRuntime = {
  asc,
  count,
  eq,
  ilike,
  inArray,
  or,
  databaseConnections,
  grantCreatedResourcePermissions,
  writeWithAllocatedSlug,
  buildWhere,
  createClient,
  Redis,
  managedDatabaseInstances,
  nodes,
  compactHealthHistory,
  getEffectiveNodeServiceAddress,
  getEffectivePublishedNodeIP,
  createChildLogger,
  Pool,
  logger,
};
