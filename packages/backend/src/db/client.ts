import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createChildLogger } from '@/lib/logger.js';
import { firstShutdownReport, isShuttingDown } from '@/services/shutdown-state.js';
import * as schema from './schema/index.js';

const logger = createChildLogger('Database');
const IDLE_CONNECTION_LOSS_LOG_INTERVAL_MS = 60_000;

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
  // pg re-emits the error of an idle client whose connection the server ended (postgres stops or restarts: 57P01)
  // on the pool. Without a listener it was an uncaught exception, 13 of them at a host shutdown (N-19), and one
  // could end the process in the middle of its drain. The pool replaces the client on the next query.
  let lastReported = 0;
  pool.on('error', (error) => {
    if (isShuttingDown()) {
      if (firstShutdownReport('postgres')) {
        logger.info('Database connections closed while Gateway shuts down', { error: error.message });
      }
      return;
    }
    const now = Date.now();
    if (now - lastReported < IDLE_CONNECTION_LOSS_LOG_INTERVAL_MS) return;
    lastReported = now;
    logger.warn('An idle database connection was lost; the next query opens a new one', { error: error.message });
  });

  return drizzle(pool, { schema });
}
