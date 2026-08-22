import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

function setRequiredEnv(overrides: NodeJS.ProcessEnv = {}) {
  const inheritedEnv = { ...ORIGINAL_ENV };
  if (!Object.hasOwn(overrides, 'GRPC_TLS_AUTO_DIR')) {
    delete inheritedEnv.GRPC_TLS_AUTO_DIR;
  }
  if (!Object.hasOwn(overrides, 'DATABASE_CONNECTOR_IMAGE')) {
    delete inheritedEnv.DATABASE_CONNECTOR_IMAGE;
  }
  if (!Object.hasOwn(overrides, 'SECURE_LINK_CONNECTOR_IMAGE')) {
    delete inheritedEnv.SECURE_LINK_CONNECTOR_IMAGE;
  }
  if (!Object.hasOwn(overrides, 'RATE_LIMIT_AI_WS_MAX_REQUESTS')) {
    delete inheritedEnv.RATE_LIMIT_AI_WS_MAX_REQUESTS;
  }
  if (!Object.hasOwn(overrides, 'RATE_LIMIT_INFERENCE_MAX_REQUESTS')) {
    delete inheritedEnv.RATE_LIMIT_INFERENCE_MAX_REQUESTS;
  }
  if (!Object.hasOwn(overrides, 'INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN')) {
    delete inheritedEnv.INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN;
  }
  if (!Object.hasOwn(overrides, 'GITHUB_OAUTH_CLIENT_ID')) {
    delete inheritedEnv.GITHUB_OAUTH_CLIENT_ID;
  }

  process.env = {
    ...inheritedEnv,
    NODE_ENV: 'test',
    DATABASE_URL: 'http://localhost/db',
    REDIS_URL: 'redis://localhost:6379',
    OIDC_ISSUER: 'http://localhost/oidc',
    OIDC_CLIENT_ID: 'test',
    OIDC_CLIENT_SECRET: 'test',
    OIDC_REDIRECT_URI: 'http://localhost/auth/callback',
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

  it('does not require a session secret for Redis-backed browser sessions', async () => {
    const env = await loadEnv({ SESSION_EXPIRY: '600' });

    expect(env.SESSION_EXPIRY).toBe(600);
    expect('SESSION_SECRET' in env).toBe(false);
  });

  it('allows enough websocket handshakes for reconnecting AI Workspace tabs', async () => {
    const env = await loadEnv();

    expect(env.RATE_LIMIT_AI_WS_MAX_REQUESTS).toBe(120);
  });

  it('allows a high inference request rate and supports deployment overrides', async () => {
    const defaults = await loadEnv();
    const overridden = await loadEnv({ RATE_LIMIT_INFERENCE_MAX_REQUESTS: '2400' });

    expect(defaults.RATE_LIMIT_INFERENCE_MAX_REQUESTS).toBe(1800);
    expect(overridden.RATE_LIMIT_INFERENCE_MAX_REQUESTS).toBe(2400);
  });

  it('allows concurrent inference runs and supports deployment overrides', async () => {
    const defaults = await loadEnv();
    const overridden = await loadEnv({ INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN: '48' });

    expect(defaults.INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN).toBe(32);
    expect(overridden.INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN).toBe(48);
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

  it('defaults the fixed local connector image only in development', async () => {
    const development = await loadEnv({ NODE_ENV: 'development' });
    const production = await loadEnv({ NODE_ENV: 'production' });

    expect(development.DATABASE_CONNECTOR_IMAGE).toBe('gateway-database-connector:dev');
    expect(development.SECURE_LINK_CONNECTOR_IMAGE).toBe('gateway-secure-link-connector:dev');
    expect(production.DATABASE_CONNECTOR_IMAGE).toBe('');
    expect(production.SECURE_LINK_CONNECTOR_IMAGE).toBe('');
  });

  it('rejects mutable secure-link connector images in production', async () => {
    await expect(
      loadEnv({ NODE_ENV: 'production', SECURE_LINK_CONNECTOR_IMAGE: 'gateway-secure-link-connector:dev' })
    ).rejects.toThrow('SECURE_LINK_CONNECTOR_IMAGE must use an immutable sha256 digest in production');
  });

  it('accepts an immutable secure-link connector image in production', async () => {
    const image = `registry.example/gateway/secure-link-connector@sha256:${'a'.repeat(64)}`;
    const production = await loadEnv({ NODE_ENV: 'production', SECURE_LINK_CONNECTOR_IMAGE: image });

    expect(production.SECURE_LINK_CONNECTOR_IMAGE).toBe(image);
  });
});
