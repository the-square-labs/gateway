import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './cli.js';
import type { CredentialStore } from './credentials.js';
import { loginWithInferenceTokenCommand, logoutCommand } from './login-command.js';
import type { Output } from './output.js';
import { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';
import type { OAuthCredential, RuntimeCredential } from './types.js';

class MemoryCredentials implements CredentialStore {
  oauth: OAuthCredential | null = null;

  async get() {
    return this.oauth;
  }

  async set(_profile: string, credential: OAuthCredential) {
    this.oauth = credential;
  }

  async delete() {
    this.oauth = null;
  }

  async getRuntime(): Promise<RuntimeCredential | null> {
    return null;
  }

  async setRuntime(): Promise<void> {}

  async deleteRuntime(): Promise<void> {}
}

describe('Gateway inference token login', () => {
  it('parses the portable home and token options without treating option names as values', () => {
    expect(
      parseArgs(['--home', '/data/inference', 'login', 'https://gateway.example.com', '--token=gwi_test'])
    ).toEqual({
      command: ['login', 'https://gateway.example.com'],
      home: '/data/inference',
      token: 'gwi_test',
    });
    expect(() => parseArgs(['--home', '--token', 'gwi_test', 'login'])).toThrow(/requires a directory path/i);
    expect(() => parseArgs(['setup', 'codex', '--token', 'gwi_test'])).toThrow(/only with the login command/i);
    expect(parseArgs(['setup', 'codex', '--url', 'https://gateway.example.com', '--startup'])).toEqual({
      command: ['setup', 'codex'],
      url: 'https://gateway.example.com',
      startup: true,
    });
    expect(parseArgs(['--url=https://gateway.example.com'])).toEqual({
      command: [],
      url: 'https://gateway.example.com',
    });
    expect(() => parseArgs(['login', 'https://one.example.com', '--url', 'https://two.example.com'])).toThrow(
      /either positionally or with --url/i
    );
    expect(() => parseArgs(['setup', 'claude-code', '--startup'])).toThrow(/only with setup codex/i);
  });

  it('binds the existing token to its Gateway user without OAuth or an email argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-inference-token-login-'));
    const profiles = new ProfileStore(join(root, 'profiles.json'));
    await profiles.upsert('default', 'https://gateway.example.com', { clientId: 'legacy-oauth-client' });
    const credentials = new MemoryCredentials();
    const writes: unknown[] = [];
    const human: string[] = [];
    const output: Output = {
      json: false,
      write(value, render) {
        writes.push(value);
        human.push(render());
      },
    };
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/.well-known/wiolett-inference')) {
        return json({
          schemaVersion: 2,
          enabled: true,
          minimumCliVersion: '0.3.0',
          oauth: {
            resource: 'https://gateway.example.com/api/inference/setup',
            authorizationServer: 'https://gateway.example.com',
          },
          adapters: {
            openai: { baseUrl: 'https://gateway.example.com/api/inference/v1' },
            anthropic: { baseUrl: 'https://gateway.example.com/api/inference' },
          },
        });
      }
      if (url.endsWith('/api/inference/setup/me')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gwi_existing-secret');
        return json({
          user: { id: 'user-1', name: 'User', email: 'user@example.com', role: 'Administrators' },
          inference: { enabled: true, allowed: true },
          adapters: {
            openai: { baseUrl: 'https://gateway.example.com/api/inference/v1' },
            anthropic: { baseUrl: 'https://gateway.example.com/api/inference' },
          },
          catalogVersion: 'v1',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await loginWithInferenceTokenCommand(
      { gateway: 'https://gateway.example.com', token: 'gwi_existing-secret' },
      'default',
      profiles,
      credentials,
      output,
      fetcher
    );

    expect(credentials.oauth).toMatchObject({
      accessToken: 'gwi_existing-secret',
      authMode: 'inference-token',
      tokenType: 'Bearer',
    });
    expect(await profiles.getRequired('default')).not.toHaveProperty('clientId');
    expect(writes.at(-1)).toMatchObject({ authMode: 'token', user: { email: 'user@example.com' } });

    const session = await authenticatedSetupClient('default', profiles, credentials, fetcher);
    await session.client.me();
    await logoutCommand('default', profiles, credentials, output, fetcher);
    expect(credentials.oauth).toBeNull();
    expect(human.at(-1)).toBe('Removed local authorization; the existing Gateway inference token was not revoked.');
    expect(requests.some((url) => url.includes('oauth-authorization-server'))).toBe(false);
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
