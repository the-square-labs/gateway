import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import type { CredentialStore } from './credentials.js';
import type { InteractiveCliUi } from './interactive-ui.js';
import type { Output } from './output.js';
import type { CliPaths } from './paths.js';
import { ProfileStore } from './profiles.js';
import type { OAuthCredential, RuntimeCredential } from './types.js';

const CATALOG = {
  models: [
    {
      slug: 'gateway-model',
      display_name: 'Gateway Model',
      description: 'Test',
      visibility: 'list',
      supported_in_api: true,
      base_instructions: 'Use tools.',
      context_window: 128_000,
      auto_compact_token_limit: 100_000,
      input_modalities: ['text'],
      supported_reasoning_levels: [],
    },
  ],
};

class MemoryCredentials implements CredentialStore {
  oauth: OAuthCredential | null = {
    accessToken: 'gwo_setup-secret',
    refreshToken: 'gwr_refresh-secret',
    expiresAt: '2099-07-28T00:00:00Z',
    tokenType: 'Bearer',
    scope: 'inference:setup',
  };
  runtime: RuntimeCredential | null = null;
  async get() {
    return this.oauth;
  }
  async set(_profile: string, value: OAuthCredential) {
    this.oauth = value;
  }
  async delete() {
    this.oauth = null;
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

describe('@wiolett/gateway Codex commands', () => {
  it('sets up, serves command-backed auth, and surgically removes Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-cli-command-'));
    const paths: CliPaths = {
      configDir: join(root, 'config'),
      dataDir: join(root, 'data'),
      profilesFile: join(root, 'config', 'profiles.json'),
      fileCredentialsFile: join(root, 'data', 'credentials.json'),
      runtimeDir: join(root, 'data', 'runtime'),
      runtimeFile: join(root, 'data', 'runtime', 'gateway-cli.js'),
    };
    const codexHome = join(root, 'codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), '[features]\nfast_mode = true\n');
    const runtimeSource = join(root, 'source.js');
    await writeFile(runtimeSource, '#!/usr/bin/env node\n');
    const profiles = new ProfileStore(paths.profilesFile);
    const profile = await profiles.upsert('work', 'https://gateway.example.com', { clientId: 'goc_cli' });
    const credentials = new MemoryCredentials();
    const values: unknown[] = [];
    const human: string[] = [];
    const output: Output = {
      json: false,
      write(value, render) {
        values.push(value);
        human.push(render());
      },
    };
    const discovery = {
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
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/wiolett-inference')) return json(discovery);
      if (url.endsWith('/.well-known/oauth-authorization-server/api/inference/setup')) {
        return json({
          issuer: 'https://gateway.example.com',
          authorization_endpoint: 'https://gateway.example.com/api/oauth/authorize/api/inference/setup',
          token_endpoint: 'https://gateway.example.com/api/oauth/token',
          registration_endpoint: 'https://gateway.example.com/api/oauth/register',
          revocation_endpoint: 'https://gateway.example.com/api/oauth/revoke',
          scopes_supported: ['inference:setup'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.endsWith('/api/inference/setup/me')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gwo_setup-secret');
        return json({
          user: { id: 'user-1', name: 'User', email: 'user@example.com', role: 'Administrators' },
          inference: { enabled: true, allowed: true },
          adapters: discovery.adapters,
          catalogVersion: 'v1',
        });
      }
      if (url.endsWith('/api/inference/setup/tokens') && init?.method === 'POST') {
        return json(
          {
            id: 'token-1',
            name: 'Codex',
            prefix: 'gwi_runtime',
            token: 'gwi_runtime-secret',
            harness: 'codex',
            deviceName: 'test',
            installationId: profile.installationId,
            createdAt: '2026-07-28T00:00:00Z',
          },
          201
        );
      }
      if (url.endsWith('/api/inference/setup/tokens')) return json({ data: [] });
      if (url.includes('/api/inference/codex/v1/models')) {
        return new Response(JSON.stringify(CATALOG), { headers: { ETag: '"v1"' } });
      }
      if (url.endsWith('/api/oauth/revoke')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const commandRunner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.145.0', stderr: '' }
        : { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' }
    );
    const dependencies = {
      paths,
      profiles,
      credentials,
      output,
      fetch: fetcher,
      commandRunner,
      runtimeSource,
      env: { CODEX_HOME: codexHome },
      home: root,
      interactive: true,
      interactiveUi: {
        intro: vi.fn(),
        info: vi.fn(),
        gatewayOrigin: vi.fn(),
        select: vi.fn().mockResolvedValue('codex'),
        spinner: vi.fn(() => ({ stop: vi.fn(), error: vi.fn() })),
        cancel: vi.fn(),
        outro: vi.fn(),
      } satisfies InteractiveCliUi,
    };

    expect(await runCli(['inference', 'setup', '--profile', 'work'], { ...dependencies, interactive: false })).toBe(1);
    expect(values.at(-1)).toMatchObject({ error: { code: 'HARNESS_REQUIRED' } });

    expect(await runCli(['inference', 'setup', '--profile', 'work'], dependencies)).toBe(0);
    expect(dependencies.interactiveUi.select).toHaveBeenCalledOnce();
    expect(dependencies.interactiveUi.outro).toHaveBeenCalledWith(expect.stringContaining('Gateway models'));
    expect(credentials.runtime?.tokenId).toBe('token-1');

    expect(await runCli(['inference', 'setup', 'codex', '--profile', 'work'], dependencies)).toBe(0);
    expect(credentials.runtime?.tokenId).toBe('token-1');
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain('model_provider = "wiolett-work-');
    expect(human.at(-1)).toContain('changes apply to the next Codex process');

    dependencies.interactiveUi.info.mockClear();
    dependencies.interactiveUi.select.mockReset().mockResolvedValueOnce('inference').mockResolvedValueOnce(null);
    expect(await runCli([], dependencies)).toBe(0);
    expect(dependencies.interactiveUi.intro).toHaveBeenCalledWith('Wiolett Gateway');
    expect(dependencies.interactiveUi.select).toHaveBeenNthCalledWith(
      1,
      'Choose a module',
      expect.arrayContaining([expect.objectContaining({ value: 'inference', label: 'Inference' })])
    );
    expect(dependencies.interactiveUi.info).not.toHaveBeenCalledWith('Profile: work');

    dependencies.interactiveUi.select.mockReset().mockResolvedValueOnce(null);
    expect(await runCli(['inference', '--profile', 'work'], dependencies)).toBe(0);
    expect(dependencies.interactiveUi.info).toHaveBeenCalledWith('Profile: work');

    dependencies.interactiveUi.select.mockReset().mockResolvedValueOnce('sync').mockResolvedValueOnce(null);
    expect(await runCli(['inference'], dependencies)).toBe(0);
    expect(dependencies.interactiveUi.info).toHaveBeenCalledWith('Account: user@example.com (User) Administrators');
    expect(dependencies.interactiveUi.info).toHaveBeenCalledWith('Models: gateway-model');
    expect(dependencies.interactiveUi.select).toHaveBeenCalledTimes(2);
    const syncSpinner = dependencies.interactiveUi.spinner.mock.results.at(-1)!.value;
    expect(syncSpinner.stop).toHaveBeenCalledWith('Model catalog updated · 1 models');

    expect(await runCli(['inference', 'doctor', 'codex', '--profile', 'work'], dependencies)).toBe(0);
    expect(values.at(-1)).toMatchObject({ ok: true, degraded: false });

    const setupCredential = credentials.oauth;
    credentials.oauth = null;
    expect(await runCli(['inference', 'doctor', 'codex', '--profile', 'work'], dependencies)).toBe(1);
    expect(values.at(-1)).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([expect.objectContaining({ name: 'setup-auth', status: 'error' })]),
    });
    credentials.oauth = setupCredential;

    expect(await runCli(['inference', 'auth', 'codex', '--profile', 'work'], dependencies)).toBe(0);
    expect(human.at(-1)).toBe('gwi_runtime-secret');

    expect(await runCli(['inference', 'remove', 'codex', '--profile', 'work'], dependencies)).toBe(0);
    expect(credentials.runtime).toBeNull();
    const restored = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(restored).toBe('[features]\nfast_mode = true\n');
    expect(JSON.stringify(values[0])).not.toContain('gwi_runtime-secret');

    dependencies.interactiveUi.select.mockReset().mockResolvedValueOnce('logout');
    expect(await runCli(['inference'], dependencies)).toBe(0);
    expect(credentials.oauth).toBeNull();

    dependencies.interactiveUi.select.mockReset().mockResolvedValueOnce(null);
    expect(await runCli(['inference'], dependencies)).toBe(0);
    const actionOptions = dependencies.interactiveUi.select.mock.calls[0]![1];
    expect(actionOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'authenticate' }),
        expect.objectContaining({ value: 'setup' }),
      ])
    );
    expect(actionOptions).not.toEqual(expect.arrayContaining([expect.objectContaining({ value: 'logout' })]));
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
