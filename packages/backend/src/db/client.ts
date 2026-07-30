import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
export type DrizzleTransaction = Parameters<Parameters<DrizzleClient['transaction']>[0]>[0];
export type DrizzleExecutor = DrizzleClient | DrizzleTransaction;

export function createDrizzleClient(connectionString: string): DrizzleClient {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  return drizzle(pool, { schema });
}
