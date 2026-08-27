import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import type { CredentialStore } from './credentials.js';
import { inferenceProxyBaseUrl } from './inference-proxy.js';
import type { InferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import type { InteractiveCliUi } from './interactive-ui.js';
import type { Output } from './output.js';
import type { CliPaths } from './paths.js';
import { ProfileStore } from './profiles.js';
import type { OAuthCredential, RuntimeCredential } from './types.js';

const MODELS = {
  object: 'list',
  data: [
    {
      id: 'gateway-model',
      object: 'model',
      created: 1,
      owned_by: 'gateway',
      display_name: 'Gateway Model',
      context_window: 128_000,
      max_input_tokens: 120_000,
      auto_compact_token_limit: 100_000,
      input_modalities: ['text'],
      capabilities: { tools: true, reasoning: false },
      supported_reasoning_efforts: [],
      default_reasoning_effort: null,
      supported_service_tiers: [],
    },
  ],
};

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

describe('@sqgateway/inference CLI', () => {
  it('exposes only the focused commands and keeps Codex lifecycle operations interactive or private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-inference-cli-'));
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
    const profile = await profiles.upsert('default', 'https://gateway.example.com', { clientId: 'goc_cli' });
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
      if (url.endsWith('/api/inference/v1/models')) {
        return new Response(JSON.stringify(MODELS), { headers: { ETag: '"v1"' } });
      }
      if (url.endsWith('/api/oauth/revoke')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const commandRunner = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
      if (args[0] === 'login') return { code: 1, stdout: 'Not logged in', stderr: '' };
      return { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' };
    });
    const interactiveUi = {
      intro: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      gatewayOrigin: vi.fn(),
      inferenceToken: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      spinner: vi.fn(() => ({ stop: vi.fn(), error: vi.fn() })),
      cancel: vi.fn(),
      outro: vi.fn(),
    } satisfies InteractiveCliUi;
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
      interactiveUi,
      proxyDaemon: {
        ensure: vi.fn(async () => ({ baseUrl: inferenceProxyBaseUrl(paths, 'default') })),
        stop: vi.fn(async () => undefined),
      } satisfies InferenceProxyDaemonManager,
    };

    expect(await runCli(['setup'], { ...dependencies, interactive: false })).toBe(1);
    expect(values.at(-1)).toMatchObject({ error: { code: 'HARNESS_REQUIRED' } });

    interactiveUi.select.mockResolvedValueOnce('codex');
    expect(await runCli(['setup'], dependencies)).toBe(0);
    expect(credentials.runtime?.tokenId).toBe('token-1');
    expect(interactiveUi.outro).toHaveBeenCalledWith(expect.stringContaining('Gateway models'));
    expect(interactiveUi.outro).toHaveBeenCalledWith(expect.stringContaining('not signed in to an OpenAI account'));

    expect(await runCli(['setup', 'codex'], dependencies)).toBe(0);
    expect(human.at(-1)).toContain('default: gateway-model');
    expect(human.at(-1)).toContain('not signed in to an OpenAI account');
    expect(human.at(-1)).toContain('Fully quit and reopen Codex');
    const configured = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(configured).toContain('model_provider = "openai"');
    expect(configured).toContain(`openai_base_url = "${inferenceProxyBaseUrl(paths, 'default')}"`);
    expect(configured).not.toContain('cli_auth_credentials_store');
    expect(configured).toContain('"__mcp"');
    expect(configured).not.toContain('--profile');
    await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    interactiveUi.info.mockClear();
    interactiveUi.select.mockReset().mockResolvedValueOnce('sync').mockResolvedValueOnce(null);
    expect(await runCli([], dependencies)).toBe(0);
    expect(interactiveUi.intro).toHaveBeenCalledWith('Good Gateway Inference');
    expect(interactiveUi.select).not.toHaveBeenCalledWith('Choose a module', expect.anything());
    expect(interactiveUi.info).toHaveBeenCalledWith('Gateway: https://gateway.example.com');
    expect(interactiveUi.info).toHaveBeenCalledWith('Account: user@example.com (User) Administrators');
    expect(interactiveUi.info).toHaveBeenCalledWith('Codex: configured · 1 models');
    const syncSpinner = interactiveUi.spinner.mock.results.at(-1)!.value;
    expect(syncSpinner.stop).toHaveBeenCalledWith('Model catalog updated · 1 models');

    const isolatedHome = join(root, 'isolated-codex');
    const isolatedUi = {
      intro: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      gatewayOrigin: vi.fn(),
      inferenceToken: vi.fn(),
      select: vi.fn().mockResolvedValueOnce(null),
      confirm: vi.fn().mockResolvedValue(true),
      spinner: vi.fn(() => ({ stop: vi.fn(), error: vi.fn() })),
      cancel: vi.fn(),
      outro: vi.fn(),
    } satisfies InteractiveCliUi;
    const isolatedDependencies = {
      ...dependencies,
      env: { CODEX_HOME: isolatedHome },
      interactiveUi: isolatedUi,
    };
    expect(await runCli([], isolatedDependencies)).toBe(0);
    expect(isolatedUi.info).toHaveBeenCalledWith('Codex: not configured');
    await expect(readFile(join(isolatedHome, 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await runCli(['setup', 'codex'], isolatedDependencies)).toBe(0);
    await expect(readFile(join(isolatedHome, 'config.toml'), 'utf8')).resolves.toContain('model_provider = "openai"');
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.toBe(configured);

    isolatedUi.select.mockReset().mockResolvedValueOnce('remove').mockResolvedValueOnce(null);
    expect(await runCli([], isolatedDependencies)).toBe(0);
    expect(credentials.runtime?.tokenId).toBe('token-1');
    await expect(readFile(join(isolatedHome, 'config.toml'), 'utf8')).resolves.not.toContain('Gateway Inference');
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.toBe(configured);

    interactiveUi.error.mockClear();
    interactiveUi.select.mockReset().mockResolvedValueOnce('logout').mockResolvedValueOnce(null);
    expect(await runCli([], dependencies)).toBe(0);
    expect(interactiveUi.error).toHaveBeenCalledWith('Remove the Codex integration before logging out.');
    expect(interactiveUi.select).toHaveBeenCalledTimes(2);
    expect(credentials.oauth).not.toBeNull();

    isolatedUi.outro.mockClear();
    isolatedUi.select.mockReset().mockResolvedValueOnce('logout');
    expect(await runCli([], isolatedDependencies)).toBe(0);
    expect(credentials.oauth).toBeNull();
    expect(isolatedUi.outro).toHaveBeenCalledWith(
      'Logged out. Harness configuration and runtime tokens were left unchanged.'
    );

    interactiveUi.gatewayOrigin.mockResolvedValueOnce(null);
    expect(await runCli(['login'], dependencies)).toBe(0);
    expect(interactiveUi.gatewayOrigin).toHaveBeenCalledOnce();
    expect(interactiveUi.cancel).toHaveBeenCalledWith('Login cancelled.');

    expect(await runCli(['login'], { ...dependencies, interactive: false })).toBe(1);
    expect(values.at(-1)).toMatchObject({ error: { code: 'GATEWAY_REQUIRED' } });

    expect(await runCli([], { ...dependencies, interactive: false })).toBe(1);
    expect(values.at(-1)).toMatchObject({ error: { code: 'INTERACTIVE_TTY_REQUIRED' } });

    const outputCountBeforeInteractiveErrors = values.length;
    interactiveUi.error.mockClear();
    expect(await runCli(['status'], dependencies)).toBe(1);
    expect(interactiveUi.error).toHaveBeenCalledWith('Error [UNKNOWN_COMMAND]: Unknown command: status');
    expect(await runCli(['inference'], dependencies)).toBe(1);
    expect(interactiveUi.error).toHaveBeenCalledWith('Error [UNKNOWN_COMMAND]: Unknown command: inference');
    expect(values).toHaveLength(outputCountBeforeInteractiveErrors);

    expect(await runCli(['status'], { ...dependencies, interactive: false })).toBe(1);
    expect(values.at(-1)).toMatchObject({ error: { code: 'UNKNOWN_COMMAND' } });
    expect(await runCli(['--profile', 'work'], dependencies)).toBe(1);
    expect(values.at(-1)).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });

    expect(await runCli(['--help'], dependencies)).toBe(0);
    expect(human.at(-1)).toContain('npx @sqgateway/inference');
    expect(human.at(-1)).not.toMatch(/\n {2}(status|inference|tokens|doctor|sync|remove|mcp|auth)\b/i);
    expect(human.at(-1)).not.toContain('--profile');

    expect(await runCli(['logout'], dependencies)).toBe(0);
    expect(credentials.oauth).toBeNull();
    expect(credentials.runtime?.tokenId).toBe('token-1');

    await writeFile(
      join(codexHome, 'config.toml'),
      configured.replace(
        `openai_base_url = "${inferenceProxyBaseUrl(paths, 'default')}"`,
        'openai_base_url = "http://127.0.0.1:59999/v1"'
      )
    );
    interactiveUi.info.mockClear();
    interactiveUi.spinner.mockClear();
    interactiveUi.select.mockReset().mockResolvedValueOnce('remove').mockResolvedValueOnce(null);
    expect(await runCli([], dependencies)).toBe(0);
    const conflictedRemovalSpinner = interactiveUi.spinner.mock.results.at(-1)!.value;
    expect(conflictedRemovalSpinner.error).toHaveBeenCalledWith('Codex integration was not removed');
    expect(interactiveUi.info).toHaveBeenCalledWith('Preserved conflicting configuration: active Codex selection');
    expect(credentials.runtime?.tokenId).toBe('token-1');
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain('127.0.0.1:59999');

    await writeFile(join(codexHome, 'config.toml'), configured);
    interactiveUi.select.mockReset().mockResolvedValueOnce('remove').mockResolvedValueOnce(null);
    expect(await runCli([], dependencies)).toBe(0);
    expect(interactiveUi.confirm).toHaveBeenCalledWith(
      'Remove the package-managed Codex integration from this device?'
    );
    expect(credentials.runtime).toBeNull();
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe('[features]\nfast_mode = true\n');
    expect(JSON.stringify(values)).not.toContain('gwi_runtime-secret');
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
