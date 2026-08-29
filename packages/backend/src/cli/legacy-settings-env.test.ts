import { describe, expect, it } from 'vitest';
import { parseLegacySettingsEnv } from './legacy-settings-env.js';

describe('parseLegacySettingsEnv', () => {
  it('reads legacy OIDC, ClickHouse, and public URL values from the host env file', () => {
    const { env, environment, appUrl } = parseLegacySettingsEnv(
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
        'RATE_LIMIT_MAX_REQUESTS=2400',
        'RATE_LIMIT_SETUP_MAX_REQUESTS=35',
        'INFERENCE_BODY_MAX_BYTES=41943040',
        'SESSION_EXPIRY=86400',
        'EXPIRY_WARNING_DAYS=45',
        'APP_URL=https://gateway.example.test',
      ].join('\n')
    );

    expect(env.OIDC_CLIENT_SECRET).toBe('super-secret');
    expect(env.CLICKHOUSE_URL).toBe('https://clickhouse.example.test:8443');
    expect(env.CLICKHOUSE_REQUEST_TIMEOUT_MS).toBe(9000);
    expect(environment.rateLimits?.maxRequests).toBe(2400);
    expect(environment.rateLimits?.setupMaxRequests).toBe(35);
    expect(environment.requestLimits?.inferenceHttpBodyMaxBytes).toBe(41_943_040);
    expect(environment.requestLimits?.inferenceWebSocketMaxPayloadBytes).toBe(41_943_040);
    expect(environment.sessions?.expirySeconds).toBe(86_400);
    expect(environment.pkiDefaults?.expiryWarningDays).toBe(45);
    expect(appUrl).toBe('https://gateway.example.test');
  });

  it('uses migration-only defaults when legacy keys are absent', () => {
    const { env, appUrl } = parseLegacySettingsEnv('');

    expect(env.OIDC_ISSUER).toBeUndefined();
    expect(env.CLICKHOUSE_URL).toBe('');
    expect(env.OIDC_SCOPES).toBe('openid email profile');
    expect(env.CLICKHOUSE_DATABASE).toBe('gateway_logs');
    expect(appUrl).toBeUndefined();
  });

  it('does not preserve the retired 50 MiB WebSocket ceiling during legacy import', () => {
    const { environment } = parseLegacySettingsEnv(`INFERENCE_BODY_MAX_BYTES=${600 * 1024 * 1024}`);

    expect(environment.requestLimits?.inferenceHttpBodyMaxBytes).toBe(600 * 1024 * 1024);
    expect(environment.requestLimits?.inferenceWebSocketMaxPayloadBytes).toBe(512 * 1024 * 1024);
  });
});
