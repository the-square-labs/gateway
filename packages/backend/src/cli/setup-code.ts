import 'reflect-metadata';
import 'dotenv/config';

import { createHash, X509Certificate } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import { createDrizzleClient } from '@/db/client.js';
import { certificateAuthorities } from '@/db/schema/index.js';
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
    const generated = await new SetupAccessService(db, cache, policy).generateCode();
    const [systemCa] = await db
      .select({ certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);
    const caFingerprint = systemCa
      ? `sha256:${createHash('sha256').update(new X509Certificate(systemCa.certificatePem).raw).digest('hex')}`
      : null;
    process.stdout.write(`${JSON.stringify({ ...generated, caFingerprint })}\n`);
  } finally {
    await redis.quit();
    await db.$client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
