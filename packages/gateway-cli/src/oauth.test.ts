import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialStore } from './credentials.js';
import { createLoopbackReceiver, type LoopbackReceiver, loginWithBrowser, refreshCredential } from './oauth.js';
import type { InferenceDiscovery, OAuthCredential, OAuthMetadata, RuntimeCredential } from './types.js';

const discovery: InferenceDiscovery = {
  schemaVersion: 1,
  enabled: true,
  minimumCliVersion: '0.1.0',
  oauth: {
    resource: 'https://gateway.example.com/api/inference/setup',
    authorizationServer: 'https://gateway.example.com',
  },
  adapters: {
    openai: { baseUrl: 'https://gateway.example.com/api/inference/openai/v1' },
    codex: {
      baseUrl: 'https://gateway.example.com/api/inference/codex/v1',
      catalogUrl: 'https://gateway.example.com/api/inference/codex/v1/models',
    },
    anthropic: { baseUrl: 'https://gateway.example.com/api/inference/anthropic' },
  },
  harnesses: { codex: { supported: true } },
};

const metadata: OAuthMetadata = {
  issuer: 'https://gateway.example.com',
  authorization_endpoint: 'https://gateway.example.com/api/oauth/authorize/api/inference/setup',
  token_endpoint: 'https://gateway.example.com/api/oauth/token',
  registration_endpoint: 'https://gateway.example.com/api/oauth/register',
  revocation_endpoint: 'https://gateway.example.com/api/oauth/revoke',
  scopes_supported: ['inference:setup'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
};

class MemoryCredentials implements CredentialStore {
  value: OAuthCredential | null = null;
  runtime: RuntimeCredential | null = null;
  async get() {
    return this.value;
  }
  async set(_profile: string, value: OAuthCredential) {
    this.value = value;
  }
  async delete() {
    this.value = null;
  }
  async getRuntime() {
    return this.runtime;
  }
  async setRuntime(_profile: string, value: RuntimeCredential) {
    this.runtime = value;
  }
  async deleteRuntime() {
    this.runtime = null;
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OAuth PKCE login', () => {
  it('registers the random loopback redirect and exchanges the state-validated code', async () => {
    const credentials = new MemoryCredentials();
    let opened: URL | undefined;
    const receiver: LoopbackReceiver = {
      redirectUri: 'http://127.0.0.1:45123/callback',
      async waitForCode(expectedState) {
        expect(opened?.searchParams.get('state')).toBe(expectedState);
        return 'authorization-code';
      },
      async close() {},
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/register')) return jsonResponse({ client_id: 'goc_cli' }, 201);
      return jsonResponse({
        access_token: 'gwo_access-secret',
        refresh_token: 'gwr_refresh-secret',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'inference:setup',
      });
    }) as typeof fetch;

    const result = await loginWithBrowser({
      profile: 'work',
      discovery,
      metadata,
      credentials,
      fetch: fetcher,
      createReceiver: async () => receiver,
      openBrowser: async (url) => {
        opened = new URL(url);
      },
      now: () => new Date('2026-07-28T00:00:00.000Z'),
    });

    const registration = JSON.parse(String(calls[0].init?.body));
    expect(registration.redirect_uris).toEqual([receiver.redirectUri]);
    expect(opened?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(opened?.searchParams.get('resource')).toBe(discovery.oauth.resource);
    expect(String(calls[1].init?.body)).toContain('code_verifier=');
    expect(result.credential.expiresAt).toBe('2026-07-28T01:00:00.000Z');
    expect(credentials.value).toEqual(result.credential);
  });

  it('rotates refresh tokens atomically in the credential store', async () => {
    const credentials = new MemoryCredentials();
    credentials.value = {
      accessToken: 'gwo_old',
      refreshToken: 'gwr_old',
      expiresAt: '2026-07-27T23:00:00.000Z',
      tokenType: 'Bearer',
      scope: 'inference:setup',
    };
    const fetcher = vi.fn(async () =>
      jsonResponse({
        access_token: 'gwo_new',
        refresh_token: 'gwr_rotated',
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'inference:setup',
      })
    ) as typeof fetch;
    const refreshed = await refreshCredential({
      profile: 'work',
      clientId: 'goc_cli',
      resource: discovery.oauth.resource,
      tokenEndpoint: metadata.token_endpoint,
      credentials,
      fetch: fetcher,
      now: () => new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(refreshed.refreshToken).toBe('gwr_rotated');
    expect(credentials.value).toEqual(refreshed);
  });

  it('serializes refresh-token rotation across concurrent Gateway processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-oauth-lock-'));
    const credentials = new MemoryCredentials();
    credentials.value = {
      accessToken: 'gwo_old',
      refreshToken: 'gwr_old',
      expiresAt: '2026-07-27T23:00:00.000Z',
      tokenType: 'Bearer',
      scope: 'inference:setup',
    };
    const fetcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return jsonResponse({
        access_token: 'gwo_new',
        refresh_token: 'gwr_rotated',
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'inference:setup',
      });
    }) as typeof fetch;
    const options = {
      profile: 'work',
      clientId: 'goc_cli',
      resource: discovery.oauth.resource,
      tokenEndpoint: metadata.token_endpoint,
      credentials,
      fetch: fetcher,
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      lockFile: join(directory, 'work.oauth.lock'),
    };

    try {
      const [first, second] = await Promise.all([refreshCredential(options), refreshCredential(options)]);
      expect(first.refreshToken).toBe('gwr_rotated');
      expect(second).toEqual(first);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(credentials.value).toEqual(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports revoked refresh authorization without deleting local evidence', async () => {
    const credentials = new MemoryCredentials();
    credentials.value = {
      accessToken: 'gwo_old',
      refreshToken: 'gwr_revoked',
      expiresAt: '2026-07-27T23:00:00.000Z',
      tokenType: 'Bearer',
      scope: 'inference:setup',
    };
    const fetcher = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token was revoked' }, 400)
    ) as typeof fetch;
    await expect(
      refreshCredential({
        profile: 'work',
        clientId: 'goc_cli',
        resource: discovery.oauth.resource,
        tokenEndpoint: metadata.token_endpoint,
        credentials,
        fetch: fetcher,
        now: () => new Date('2026-07-28T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
    expect(credentials.value?.refreshToken).toBe('gwr_revoked');
  });

  it('rejects a callback with mismatched state and ignores callback-path collisions', async () => {
    const receiver = await createLoopbackReceiver();
    const collisionStatus = await send(receiver.redirectUri.replace('/callback', '/unrelated'));
    expect(collisionStatus).toBe(404);
    const waiting = receiver.waitForCode('expected-state', 1_000);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'OAUTH_STATE_MISMATCH' });
    await send(`${receiver.redirectUri}?code=code&state=wrong-state`);
    await rejected;
    await receiver.close();
  });

  it('times out a callback without leaking server resources', async () => {
    const receiver = await createLoopbackReceiver();
    await expect(receiver.waitForCode('state', 10)).rejects.toMatchObject({ code: 'OAUTH_TIMEOUT' });
    await receiver.close();
  });
});

function send(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}
