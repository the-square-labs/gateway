import { describe, expect, it } from 'vitest';
import type { Env } from '@/config/env.js';
import { parseLegacySettingsEnv } from './legacy-settings-env.js';

const runtimeEnv = {
  OIDC_ISSUER: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  OIDC_SCOPES: 'openid email profile',
  CLICKHOUSE_URL: '',
  CLICKHOUSE_USERNAME: 'default',
  CLICKHOUSE_PASSWORD: '',
  CLICKHOUSE_DATABASE: 'gateway_logs',
  CLICKHOUSE_LOGS_TABLE: 'logs',
  CLICKHOUSE_REQUEST_TIMEOUT_MS: 5000,
} as Env;

describe('parseLegacySettingsEnv', () => {
  it('reads legacy OIDC, ClickHouse, and public URL values from the host env file', () => {
    const { env, appUrl } = parseLegacySettingsEnv(
      runtimeEnv,
      [
        'OIDC_ISSUER=https://idp.example.test',
        'OIDC_CLIENT_ID=gateway',
        'OIDC_CLIENT_SECRET=super-secret',
        'OIDC_REDIRECT_URI=https://gateway.example.test/auth/callback',
        'OIDC_SCOPES=openid email profile groups',
        'CLICKHOUSE_URL=https://clickhouse.example.test:8443',
        'CLICKHOUSE_USERNAME=gateway',
        'CLICKHOUSE_PASSWORD=logging-secret',
        'CLICKHOUSE_DATABASE=logs',
        'CLICKHOUSE_LOGS_TABLE=events',
        'CLICKHOUSE_REQUEST_TIMEOUT_MS=9000',
        'APP_URL=https://gateway.example.test',
      ].join('\n')
    );

    expect(env.OIDC_CLIENT_SECRET).toBe('super-secret');
    expect(env.CLICKHOUSE_URL).toBe('https://clickhouse.example.test:8443');
    expect(env.CLICKHOUSE_REQUEST_TIMEOUT_MS).toBe(9000);
    expect(appUrl).toBe('https://gateway.example.test');
  });

  it('does not inherit removed legacy values from the candidate runtime environment', () => {
    const { env, appUrl } = parseLegacySettingsEnv(
      { ...runtimeEnv, OIDC_ISSUER: 'https://runtime.example.test', CLICKHOUSE_URL: 'https://runtime.example.test' },
      ''
    );

    expect(env.OIDC_ISSUER).toBeUndefined();
    expect(env.CLICKHOUSE_URL).toBe('');
    expect(appUrl).toBeUndefined();
  });
});
