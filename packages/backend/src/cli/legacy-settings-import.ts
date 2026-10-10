import type { DrizzleClient } from '@/db/client.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { EnvironmentSettingsService } from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { LegacySettingsEnv } from './legacy-settings-env.js';

/**
 * Moves the settings a pre-2.11 install kept in its .env into the database. The updater of the previous release runs
 * this from the target image before it snapshots the database, so a rollback restores what it wrote: every row it
 * writes must stay readable by the previous stable release (rc.10 upgrade run, F-1).
 */
export async function importLegacySettings(db: DrizzleClient, crypto: CryptoService, hostEnv: LegacySettingsEnv) {
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
  await new GeneralSettingsService(db).importLegacyPublicUrl(hostEnv.appUrl);
  return { oidcImported, clickHouseImported, environmentImported };
}
