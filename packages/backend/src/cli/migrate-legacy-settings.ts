import 'reflect-metadata';
import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '@/config/env.js';
import { createDrizzleClient } from '@/db/client.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { parseLegacySettingsEnv } from './legacy-settings-env.js';

async function main() {
  const hostDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const env = getEnv();
  const db = createDrizzleClient(env.DATABASE_URL);
  try {
    const crypto = new CryptoService(env.PKI_MASTER_KEY);
    const hostEnv = hostDir
      ? parseLegacySettingsEnv(env, await fs.readFile(path.join(hostDir, '.env'), 'utf8'))
      : { env, appUrl: process.env.APP_URL };
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
    const general = new GeneralSettingsService(db);
    await general.importLegacyPublicUrl(hostEnv.appUrl);

    if (hostDir) await removeLegacyKeys(path.join(hostDir, '.env'));
    process.stdout.write(`${JSON.stringify({ ok: true, oidcImported, clickHouseImported })}\n`);
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
    .filter((line) => !/^(?:OIDC_|CLICKHOUSE_|APP_URL=|SETUP_TOKEN=)/.test(line))
    .join('\n');
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, next, { mode: stat.mode & 0o777 });
  await fs.rename(temp, filePath);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
