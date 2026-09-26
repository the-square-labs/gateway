import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema/index.js';
import { cleanOperationHistory, EXPIRED_OPERATION_LEASE_GRACE_MS } from '@/services/operation-history-retention.js';
import type { DrizzleClient } from './client.js';
import { OperationLeaseStore } from './operation-lease.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

/** The migrations up to and including `lastTag`, in a folder drizzle's migrator can read. */
function migrationsThrough(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'gateway-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entries = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === lastTag) + 1);
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries)
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  return folder;
}

/**
 * Opt-in, like the other migration DB tests: GATEWAY_MIGRATION_TEST_DATABASE_URL names a disposable local
 * gateway_migration_test_* database. This file works in its own `<name>_leases` database on that server, so it can
 * run next to the others; it migrates to 0207, seeds a settings-row lease, migrates, then runs the lease store.
 */
describe.skipIf(!url)('operation leases on disposable PostgreSQL', () => {
  let admin: pg.Pool;
  const pools: pg.Pool[] = [];
  let databaseName: string;
  let leaseUrl: URL;
  const db = (pool: pg.Pool) => drizzle(pool, { schema }) as unknown as DrizzleClient;

  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !['127.0.0.1', 'localhost'].includes(target.hostname) ||
      !/^\/gateway_migration_test_[a-z0-9_]+$/.test(target.pathname)
    ) {
      throw new Error('Migration DB tests require a local, dedicated gateway_migration_test_* database');
    }
    databaseName = `${target.pathname.slice(1)}_leases`;
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}"`);
    leaseUrl = new URL(url!);
    leaseUrl.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: leaseUrl.toString(), max: 4 });
    pools.push(pool);

    const before = migrationsThrough('0207_uniqueness_guarantees');
    try {
      await migrate(drizzle(pool), { migrationsFolder: before });
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
    await pool.query(`insert into settings (key, value) values ($1, $2), ($3, $4)`, [
      'operation-lease:acme:cert:1',
      JSON.stringify({ token: 't', process: 'p', expiresAt: new Date().toISOString(), data: {} }),
      'general',
      JSON.stringify({ kept: true }),
    ]);
    await migrate(drizzle(pool), { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    await admin?.query(`drop database if exists "${databaseName}" with (force)`);
    await admin?.end();
  });

  it('drops the transient settings-row leases and keeps every other setting', async () => {
    const { rows } = await pools[0]!.query<{ key: string }>('select key from settings order by key');
    expect(rows.map((row) => row.key)).toEqual(['general']);
  });

  it('lets one of two processes claim a key, renews, finishes and releases on the real table', async () => {
    const processA = new OperationLeaseStore(db(pools[0]!));
    const other = new pg.Pool({ connectionString: leaseUrl.toString(), max: 4 });
    pools.push(other);
    const processB = new OperationLeaseStore(db(other));

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) => (index % 2 ? processB : processA).claim(['acme:cert:2'], { index }))
    );
    const winners = claims.filter((claim) => claim.acquired);
    expect(winners).toHaveLength(1);
    const token = (winners[0] as { token: string }).token;

    await expect(processB.renew(['acme:cert:2'], token)).resolves.toEqual(['acme:cert:2']);
    await processA.release(['acme:cert:2'], token, { data: { outcome: 'done' }, retainMs: 60_000 });
    await expect(processB.read('acme:cert:2')).resolves.toMatchObject({ token, data: { outcome: 'done' } });
    await processB.release(['acme:cert:2'], token);
    await expect(processA.read('acme:cert:2')).resolves.toBeNull();
  });

  it('removes lease rows long past their expiry with the operation history retention', async () => {
    const pool = pools[0]!;
    const now = new Date();
    const stale = new Date(now.getTime() - EXPIRED_OPERATION_LEASE_GRACE_MS - 60_000);
    const recent = new Date(now.getTime() - 60_000);
    await pool.query(
      `insert into operation_leases (key, token, holder, data, expires_at)
       values ('stale', gen_random_uuid(), 'gone', '{}', $1), ('recent', gen_random_uuid(), 'gone', '{}', $2)`,
      [stale, recent]
    );

    const result = await cleanOperationHistory(db(pool), 90, now);

    expect(result.removed['expired operation leases']).toBe(1);
    const { rows } = await pool.query<{ key: string }>('select key from operation_leases order by key');
    expect(rows.map((row) => row.key)).toEqual(['recent']);
  });
});
