import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { releaseLostCheckedOutClients } from './checked-out-client-errors.js';

const { Pool } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  console.log('Running database migrations...');

  const pool = new Pool({ connectionString });
  // A lost connection fails the migration with its error instead of ending the process as an uncaught exception.
  releaseLostCheckedOutClients(pool);
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: './src/db/migrations' });

  console.log('Migrations completed successfully');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
