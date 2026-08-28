import 'reflect-metadata';
import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '@/config/env.js';
import { createDrizzleClient } from '@/db/client.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { EnvironmentSettingsService } from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { parseLegacySettingsEnv } from './legacy-settings-env.js';

async function main() {
  const hostDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!hostDir) throw new Error('Legacy settings migration requires a host directory');
  const env = getEnv();
  const db = createDrizzleClient(env.DATABASE_URL);
  try {
    const crypto = new CryptoService(env.PKI_MASTER_KEY);
    const hostEnv = parseLegacySettingsEnv(await fs.readFile(path.join(hostDir, '.env'), 'utf8'));
    const oidcValues = [
      hostEnv.env.OIDC_ISSUER,
      hostEnv.env.OIDC_CLIENT_ID,
      hostEnv.env.OIDC_CLIENT_SECRET,
      hostEnv.env.OIDC_REDIRECT_URI,
    ];
    if (oidcValues.some(Boolean) && !oidcValues.every(Boolean)) {
      throw new Error('Refusing to remove an incomplete legacy OIDC configuration');
    }

    const oidcImported = await new OidcSettingsService(db, crypto).importLegacyEnv(hostEnv.env);
    const clickHouseImported = await new LoggingSettingsService(db, crypto).importLegacyEnv(hostEnv.env);
    const environmentImported = await new EnvironmentSettingsService(db).importLegacy(hostEnv.environment);
    const general = new GeneralSettingsService(db);
    await general.importLegacyPublicUrl(hostEnv.appUrl);

    await removeLegacyKeys(path.join(hostDir, '.env'));
    process.stdout.write(`${JSON.stringify({ ok: true, oidcImported, clickHouseImported, environmentImported })}\n`);
  } finally {
    await db.$client.end();
  }
}

async function removeLegacyKeys(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath, 'utf8');
  const next = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(
      (line) =>
        !/^(?:OIDC_|CLICKHOUSE_|RATE_LIMIT_|LOGGING_(?:INGEST|RATE_LIMIT|GLOBAL|TOKEN)_|REQUEST_BODY_MAX_BYTES=|OAUTH_BODY_MAX_BYTES=|DOCKER_FILE_WRITE_MAX_BODY_BYTES=|INFERENCE_(?:BODY_MAX_BYTES|MAX_CONCURRENT_REQUESTS_PER_TOKEN|CONCURRENCY_LEASE_SECONDS|CONTINUATION_MAX_BYTES|CONTINUATION_TTL_SECONDS)=|SESSION_EXPIRY=|DEFAULT_CRL_VALIDITY_HOURS=|DEFAULT_OCSP_VALIDITY_MINUTES=|EXPIRY_WARNING_DAYS=|EXPIRY_CRITICAL_DAYS=|ACME_EMAIL=|ACME_STAGING=|APP_URL=|SETUP_TOKEN=)/.test(
          line
        )
    )
    .join('\n');
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, next, { mode: stat.mode & 0o777 });
  await fs.rename(temp, filePath);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
