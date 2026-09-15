import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { expect, it } from 'vitest';
import * as schema from '@/db/schema/index.js';
import { modelPoolBurnMultiplier } from './inference-pool-budget.js';

const url = process.env.INFERENCE_POOL_TEST_DATABASE_URL;
it.skipIf(!url)('reads only the current model pool and each account latest batch in PostgreSQL', async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Session-local fixtures shadow production table names; no application data
    // or persistent schema is modified, even if a caller supplies an existing DB.
    await client.query(`BEGIN;
      CREATE TEMP TABLE inference_models (id text, public_id text);
      CREATE TEMP TABLE inference_provider_connections (id text, provider_id text, account_external_id text, enabled boolean, status text, deleted_at timestamptz);
      CREATE TEMP TABLE inference_model_sources (model_id text, connection_id text, upstream_model_id text, enabled boolean, source_type text);
      CREATE TEMP TABLE inference_quota_snapshots (connection_id text, dimension text, model_bucket text, remaining_fraction numeric, limit_value numeric, reset_at timestamptz, fetched_at timestamptz, valid_until timestamptz);
      INSERT INTO inference_models VALUES ('astra', 'gpt-6-astra'), ('other', 'other');
      INSERT INTO inference_provider_connections VALUES
        ('a', 'openai', 'physical-a', true, 'quota_hot', null),
        ('b', 'openai', 'physical-b', true, 'healthy', null),
        ('disabled', 'openai', null, false, 'healthy', null),
        ('revoked', 'openai', null, true, 'reauth_required', null),
        ('deleted', 'openai', null, true, 'healthy', now()),
        ('api', 'openai', null, true, 'healthy', null),
        ('unrelated', 'openai', null, true, 'healthy', null);
      INSERT INTO inference_model_sources VALUES
        ('astra','a','gpt-6-astra',true,'subscription'),
        ('astra','a','alias',true,'subscription'),
        ('astra','b','gpt-6-astra',true,'subscription'),
        ('astra','disabled','gpt-6-astra',true,'subscription'),
        ('astra','revoked','gpt-6-astra',true,'subscription'),
        ('astra','deleted','gpt-6-astra',true,'subscription'),
        ('astra','api','gpt-6-astra',true,'api'),
        ('other','unrelated','other',true,'subscription');
    `);
    const now = new Date('2026-09-15T14:00:00Z');
    const reset = new Date(now.getTime() + 7 * 86_400_000 * 0.55);
    for (const [id, remaining, offset] of [
      ['a', '0.03', -60_000],
      ['b', '0.19', 0],
      ['a', '1', -120_000],
      ['disabled', '1', 0],
      ['revoked', '1', 0],
      ['deleted', '1', 0],
      ['api', '1', 0],
      ['unrelated', '1', 0],
    ] as const) {
      await client.query('INSERT INTO inference_quota_snapshots VALUES ($1, $2, null, $3, null, $4, $5, $6)', [
        id,
        '7d',
        remaining,
        reset,
        new Date(now.getTime() + offset),
        new Date(now.getTime() + 60_000),
      ]);
    }
    const db = drizzle(client, { schema });
    expect(await modelPoolBurnMultiplier(db, 'astra', now)).toBeCloseTo(5);
    await client.query("UPDATE inference_provider_connections SET status='unavailable' WHERE id='a'");
    expect(await modelPoolBurnMultiplier(db, 'astra', now)).toBeCloseTo(5);
    await client.query("UPDATE inference_model_sources SET enabled=false WHERE connection_id='a'");
    expect(await modelPoolBurnMultiplier(db, 'astra', now)).toBeCloseTo(0.55 / 0.19);
    expect(await modelPoolBurnMultiplier(db, 'astra', now, true)).toBe(1);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
