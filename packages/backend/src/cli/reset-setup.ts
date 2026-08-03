import 'reflect-metadata';
import 'dotenv/config';

import { getEnv } from '@/config/env.js';
import { createDrizzleClient } from '@/db/client.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { CacheService, createRedisClient } from '@/services/cache.service.js';

async function main() {
  const env = getEnv();
  const db = createDrizzleClient(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);
  const cache = new CacheService(redis);
  try {
    const policy = new SetupTokenPolicyService(db, true);
    await policy.reopenSetup();
    await Promise.all([
      cache.deletePattern('session:*'),
      cache.deletePattern('user_sessions:*'),
      cache.deletePattern('setup:session:*'),
    ]);
    const generated = await new SetupAccessService(db, cache, policy).generateCode();
    process.stdout.write(`${JSON.stringify(generated)}\n`);
  } finally {
    await redis.quit();
    await db.$client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
