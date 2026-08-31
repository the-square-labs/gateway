import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

function setRequiredEnv(overrides: NodeJS.ProcessEnv = {}) {
  const inheritedEnv = { ...ORIGINAL_ENV };
  if (!Object.hasOwn(overrides, 'GRPC_TLS_AUTO_DIR')) {
    delete inheritedEnv.GRPC_TLS_AUTO_DIR;
  }
  if (!Object.hasOwn(overrides, 'SECURE_LINK_CONNECTOR_IMAGE')) {
    delete inheritedEnv.SECURE_LINK_CONNECTOR_IMAGE;
  }
  if (!Object.hasOwn(overrides, 'GITHUB_OAUTH_CLIENT_ID')) {
    delete inheritedEnv.GITHUB_OAUTH_CLIENT_ID;
  }

  process.env = {
    ...inheritedEnv,
    NODE_ENV: 'test',
    DATABASE_URL: 'http://localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    PKI_MASTER_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
    ...overrides,
  };
}

async function loadEnv(overrides: NodeJS.ProcessEnv = {}) {
  vi.resetModules();
  setRequiredEnv(overrides);
  const module = await import('./env.js');
  return module.getEnv();
}

describe('getEnv gRPC TLS config', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  it('treats empty custom gRPC TLS paths as unset', async () => {
    const env = await loadEnv({ GRPC_TLS_CERT: '', GRPC_TLS_KEY: '' });

    expect(env.GRPC_TLS_CERT).toBeUndefined();
    expect(env.GRPC_TLS_KEY).toBeUndefined();
  });

  it('defaults the auto-generated gRPC TLS directory', async () => {
    const env = await loadEnv();

    expect(env.GRPC_TLS_AUTO_DIR).toBe('/var/lib/gateway/tls');
  });

  it('keeps public demo mode strictly opt-in', async () => {
    const unset = await loadEnv();
    const standard = await loadEnv({ GATEWAY_DEPLOYMENT_MODE: 'standard' });
    const demo = await loadEnv({ GATEWAY_DEPLOYMENT_MODE: 'demo' });

    expect(unset.GATEWAY_DEPLOYMENT_MODE).toBe('standard');
    expect(standard.GATEWAY_DEPLOYMENT_MODE).toBe('standard');
    expect(demo.GATEWAY_DEPLOYMENT_MODE).toBe('demo');
  });

  it('fails closed on an invalid deployment mode', async () => {
    await expect(loadEnv({ GATEWAY_DEPLOYMENT_MODE: 'dem0' })).rejects.toThrow('Invalid environment variables');
  });

  it('does not expose browser-owned settings through runtime env', async () => {
    const env = await loadEnv({
      OIDC_ISSUER: 'https://legacy-idp.example.test',
      OIDC_CLIENT_ID: 'legacy-client',
      OIDC_CLIENT_SECRET: 'legacy-secret',
      OIDC_REDIRECT_URI: 'https://gateway.example.test/auth/callback',
      CLICKHOUSE_URL: 'https://legacy-clickhouse.example.test',
      CLICKHOUSE_PASSWORD: 'legacy-password',
      SESSION_EXPIRY: '600',
      RATE_LIMIT_AI_WS_MAX_REQUESTS: '240',
      RATE_LIMIT_INFERENCE_MAX_REQUESTS: '2400',
      INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN: '48',
      INFERENCE_BODY_MAX_BYTES: '67108864',
      ACME_EMAIL: 'legacy@example.test',
      ACME_STAGING: 'true',
    });

    expect('OIDC_ISSUER' in env).toBe(false);
    expect('OIDC_CLIENT_SECRET' in env).toBe(false);
    expect('CLICKHOUSE_URL' in env).toBe(false);
    expect('CLICKHOUSE_PASSWORD' in env).toBe(false);
    expect('SESSION_EXPIRY' in env).toBe(false);
    expect('RATE_LIMIT_AI_WS_MAX_REQUESTS' in env).toBe(false);
    expect('RATE_LIMIT_INFERENCE_MAX_REQUESTS' in env).toBe(false);
    expect('INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN' in env).toBe(false);
    expect('INFERENCE_BODY_MAX_BYTES' in env).toBe(false);
    expect('ACME_EMAIL' in env).toBe(false);
    expect('ACME_STAGING' in env).toBe(false);
    expect('SESSION_SECRET' in env).toBe(false);
  });

  it('uses the built-in GitHub OAuth client ID unless explicitly overridden', async () => {
    const builtIn = await loadEnv();
    const overridden = await loadEnv({ GITHUB_OAUTH_CLIENT_ID: 'custom-client-id' });
    const empty = await loadEnv({ GITHUB_OAUTH_CLIENT_ID: '' });

    expect(builtIn.GITHUB_OAUTH_CLIENT_ID).toBe('Ov23likbDL1gM8asWzfC');
    expect(overridden.GITHUB_OAUTH_CLIENT_ID).toBe('custom-client-id');
    expect(empty.GITHUB_OAUTH_CLIENT_ID).toBe('Ov23likbDL1gM8asWzfC');
  });

  it('defaults the auto-generated gRPC TLS directory when the env value is empty', async () => {
    const env = await loadEnv({ GRPC_TLS_AUTO_DIR: '' });

    expect(env.GRPC_TLS_AUTO_DIR).toBe('/var/lib/gateway/tls');
  });

  it('allows overriding the auto-generated gRPC TLS directory', async () => {
    const env = await loadEnv({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' });

    expect(env.GRPC_TLS_AUTO_DIR).toBe('/tmp/gateway-tls');
  });

  it('defaults the fixed local secure-link connector image only in development', async () => {
    const development = await loadEnv({ NODE_ENV: 'development' });
    const production = await loadEnv({ NODE_ENV: 'production' });

    expect(development.SECURE_LINK_CONNECTOR_IMAGE).toBe('gateway-secure-link-connector:dev');
    expect(production.SECURE_LINK_CONNECTOR_IMAGE).toBe('');
  });

  it('rejects untrusted mutable secure-link connector images in production', async () => {
    await expect(
      loadEnv({ NODE_ENV: 'production', SECURE_LINK_CONNECTOR_IMAGE: 'gateway-secure-link-connector:dev' })
    ).rejects.toThrow(
      'SECURE_LINK_CONNECTOR_IMAGE must use an immutable sha256 digest or an official Gateway Relay release tag in production'
    );
  });

  it('accepts an immutable secure-link connector image in production', async () => {
    const image = `registry.example/gateway/secure-link-connector@sha256:${'a'.repeat(64)}`;
    const production = await loadEnv({ NODE_ENV: 'production', SECURE_LINK_CONNECTOR_IMAGE: image });

    expect(production.SECURE_LINK_CONNECTOR_IMAGE).toBe(image);
  });

  it.each([
    'v2.9.16-relay',
    'v2.10.0-rc.1-relay',
  ])('accepts the official secure-link connector release tag %s in production', async (tag) => {
    const image = `ghcr.io/the-square-labs/gateway/secure-link-connector:${tag}`;
    const production = await loadEnv({ NODE_ENV: 'production', SECURE_LINK_CONNECTOR_IMAGE: image });

    expect(production.SECURE_LINK_CONNECTOR_IMAGE).toBe(image);
  });

  it.each([
    'ghcr.io/the-square-labs/gateway/secure-link-connector:latest',
    'ghcr.io/the-square-labs/gateway/secure-link-connector:v2.9.16',
    'registry.example/gateway/secure-link-connector:v2.9.16-relay',
  ])('rejects non-release secure-link connector tag %s in production', async (image) => {
    await expect(loadEnv({ NODE_ENV: 'production', SECURE_LINK_CONNECTOR_IMAGE: image })).rejects.toThrow(
      'SECURE_LINK_CONNECTOR_IMAGE must use an immutable sha256 digest or an official Gateway Relay release tag in production'
    );
  });
});
