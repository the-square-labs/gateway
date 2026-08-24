import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialStore } from './credentials.js';
import { runInteractiveLogin } from './interactive-login.js';
import type { InteractiveCliUi } from './interactive-ui.js';
import type { Output } from './output.js';
import { ProfileStore } from './profiles.js';
import type { OAuthCredential, RuntimeCredential } from './types.js';

class MemoryCredentials implements CredentialStore {
  value: OAuthCredential | null = null;

  async get() {
    return this.value;
  }

  async set(_profile: string, value: OAuthCredential) {
    this.value = value;
  }

  async delete() {
    this.value = null;
  }

  async getRuntime(): Promise<RuntimeCredential | null> {
    return null;
  }

  async setRuntime(): Promise<void> {}

  async deleteRuntime(): Promise<void> {}
}

describe('interactive Gateway login', () => {
  it('offers OAuth or a masked token path and stores a validated existing token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-inference-interactive-login-'));
    const profiles = new ProfileStore(join(root, 'profiles.json'));
    const credentials = new MemoryCredentials();
    const ui = createUi('token', 'gwi_existing-secret');
    const openBrowser = vi.fn();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
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

    await expect(
      runInteractiveLogin({
        gateway: 'https://gateway.example.com',
        profileName: 'default',
        profiles,
        credentials,
        output: silentOutput(),
        ui,
        fetch: fetcher,
        openBrowser,
      })
    ).resolves.toBe(true);

    expect(ui.select).toHaveBeenCalledWith(
      'How do you want to authenticate?',
      expect.arrayContaining([
        expect.objectContaining({ value: 'oauth', label: 'Browser OAuth' }),
        expect.objectContaining({ value: 'token', label: 'Existing inference token' }),
      ])
    );
    expect(ui.inferenceToken).toHaveBeenCalledOnce();
    expect(ui.info).toHaveBeenCalledWith('Validating Gateway inference token...');
    expect(openBrowser).not.toHaveBeenCalled();
    expect(credentials.value).toMatchObject({ accessToken: 'gwi_existing-secret', authMode: 'inference-token' });
  });

  it('cancels without changing credentials when no authentication method is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-inference-interactive-login-cancel-'));
    const ui = createUi(null, null);

    await expect(
      runInteractiveLogin({
        gateway: 'https://gateway.example.com',
        profileName: 'default',
        profiles: new ProfileStore(join(root, 'profiles.json')),
        credentials: new MemoryCredentials(),
        output: silentOutput(),
        ui,
        cancelMessage: 'Setup cancelled.',
      })
    ).resolves.toBe(false);

    expect(ui.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(ui.inferenceToken).not.toHaveBeenCalled();
  });
});

function createUi(method: string | null, token: string | null) {
  const ui = {
    intro: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    gatewayOrigin: vi.fn(),
    inferenceToken: vi.fn().mockResolvedValue(token),
    select: vi.fn().mockResolvedValue(method),
    confirm: vi.fn(),
    spinner: vi.fn(() => ({ stop: vi.fn(), error: vi.fn() })),
    cancel: vi.fn(),
    outro: vi.fn(),
  } satisfies InteractiveCliUi;
  return ui;
}

function silentOutput(): Output {
  return {
    json: false,
    write(_value: unknown, render: () => string) {
      render();
    },
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
