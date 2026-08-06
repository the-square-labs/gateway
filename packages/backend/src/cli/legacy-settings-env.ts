import { parse } from 'dotenv';
import type { Env } from '@/config/env.js';

export interface LegacySettingsEnv {
  env: Env;
  appUrl: string | undefined;
}

export function parseLegacySettingsEnv(runtimeEnv: Env, content: string): LegacySettingsEnv {
  const values = parse(content);
  const optional = (key: string) => {
    const value = values[key]?.trim();
    return value || undefined;
  };
  const integer = (key: string, fallback: number) => {
    const value = optional(key);
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    env: {
      ...runtimeEnv,
      OIDC_ISSUER: optional('OIDC_ISSUER'),
      OIDC_CLIENT_ID: optional('OIDC_CLIENT_ID'),
      OIDC_CLIENT_SECRET: optional('OIDC_CLIENT_SECRET'),
      OIDC_REDIRECT_URI: optional('OIDC_REDIRECT_URI'),
      OIDC_SCOPES: optional('OIDC_SCOPES') ?? runtimeEnv.OIDC_SCOPES,
      CLICKHOUSE_URL: optional('CLICKHOUSE_URL') ?? '',
      CLICKHOUSE_USERNAME: optional('CLICKHOUSE_USERNAME') ?? runtimeEnv.CLICKHOUSE_USERNAME,
      CLICKHOUSE_PASSWORD: optional('CLICKHOUSE_PASSWORD') ?? runtimeEnv.CLICKHOUSE_PASSWORD,
      CLICKHOUSE_DATABASE: optional('CLICKHOUSE_DATABASE') ?? runtimeEnv.CLICKHOUSE_DATABASE,
      CLICKHOUSE_LOGS_TABLE: optional('CLICKHOUSE_LOGS_TABLE') ?? runtimeEnv.CLICKHOUSE_LOGS_TABLE,
      CLICKHOUSE_REQUEST_TIMEOUT_MS: integer('CLICKHOUSE_REQUEST_TIMEOUT_MS', runtimeEnv.CLICKHOUSE_REQUEST_TIMEOUT_MS),
    },
    appUrl: optional('APP_URL'),
  };
}
