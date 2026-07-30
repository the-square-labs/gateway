import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexIntegrationService } from './codex-integration.js';
import type { CredentialStore } from './credentials.js';
import type { CliPaths } from './paths.js';
import type { GatewayProfile } from './profiles.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery, OAuthCredential, RuntimeCredential } from './types.js';

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
  oauth: OAuthCredential | null = null;
  runtime: RuntimeCredential | null = null;
  async get() {
    return this.oauth;
  }
  async set(_profile: string, credential: OAuthCredential) {
    this.oauth = credential;
  }
  async delete() {
    this.oauth = null;
  }
  async getRuntime() {
    return this.runtime;
  }
  async setRuntime(_profile: string, credential: RuntimeCredential) {
    this.runtime = credential;
  }
  async deleteRuntime() {
    this.runtime = null;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gateway-codex-integration-'));
  const paths: CliPaths = {
    configDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    profilesFile: join(root, 'config', 'profiles.json'),
    fileCredentialsFile: join(root, 'data', 'credentials.json'),
    runtimeDir: join(root, 'data', 'runtime'),
    runtimeFile: join(root, 'data', 'runtime', 'gateway-cli.js'),
  };
  const runtimeSource = join(root, 'source.js');
  await writeFile(runtimeSource, '#!/usr/bin/env node\n');
  const profile: GatewayProfile = {
    origin: 'https://gateway.example.com',
    installationId: '33333333-3333-4333-8333-333333333333',
    clientId: 'goc_cli',
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z',
  };
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
  return { root, paths, runtimeSource, profile, discovery };
}

describe('CodexIntegrationService', () => {
  it('issues an explicit replacement token, installs runtime, catalog, and secret-free Codex config', async () => {
    const files = await fixture();
    const credentials = new MemoryCredentials();
    const createToken = vi.fn().mockResolvedValue({
      id: 'new-token',
      name: 'Codex · test',
      prefix: 'gwi_newtoken',
      token: 'gwi_runtime-secret',
      harness: 'codex',
      deviceName: 'test',
      installationId: files.profile.installationId,
      createdAt: '2026-07-28T00:00:00Z',
    });
    const client = {
      listTokens: vi.fn().mockResolvedValue([
        {
          id: 'unknown-old-token',
          harness: 'codex',
          installationId: files.profile.installationId,
        },
      ]),
      createToken,
    } as unknown as InferenceSetupClient;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(CATALOG), { headers: { 'Content-Type': 'application/json', ETag: '"v1"' } })
      );
    const fetcher = fetchMock as typeof fetch;
    const commandRunner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.145.0\n', stderr: '' }
        : { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' }
    );
    const service = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: join(files.root, 'codex') },
      home: files.root,
    });

    const result = await service.setup({
      profileName: 'work',
      profile: files.profile,
      discovery: files.discovery,
      client,
    });

    expect(createToken).toHaveBeenCalledWith({
      installationId: files.profile.installationId,
      replaceExisting: true,
    });
    expect(credentials.runtime).toMatchObject({ tokenId: 'new-token', token: 'gwi_runtime-secret' });
    expect(result.catalog).toMatchObject({ status: 'updated', modelCount: 1 });
    const config = await readFile(result.configFile, 'utf8');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('.auth]');
    expect(config).not.toContain('gwi_runtime-secret');
    expect(commandRunner).toHaveBeenCalledWith(
      'codex',
      ['debug', 'models'],
      expect.objectContaining({ CODEX_HOME: join(files.root, 'codex') })
    );

    const healthy = await service.doctor({
      profileName: 'work',
      discovery: files.discovery,
      setupCheck: { status: 'ok', message: 'Authenticated' },
    });
    expect(healthy).toMatchObject({ ok: true, degraded: false });
    expect(healthy.checks).toContainEqual({
      name: 'runtime-probe',
      status: 'ok',
      message: 'Gateway accepted the runtime token',
    });

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await service.doctor({
      profileName: 'work',
      discovery: files.discovery,
      setupCheck: { status: 'warning', message: 'Offline: Gateway is unreachable.' },
    });
    expect(offline).toMatchObject({ ok: true, degraded: true });
    expect(offline.checks).toContainEqual(expect.objectContaining({ name: 'runtime-probe', status: 'warning' }));
  });

  it('does not issue a token during sync and reports revoked runtime credentials', async () => {
    const files = await fixture();
    const credentials = new MemoryCredentials();
    const createToken = vi.fn().mockResolvedValue({
      id: 'token-1',
      prefix: 'gwi_revoked',
      token: 'gwi_revoked',
      harness: 'codex',
      deviceName: 'test',
      installationId: files.profile.installationId,
      name: 'Codex',
      createdAt: '2026-07-28T00:00:00Z',
    });
    const client = {
      listTokens: vi.fn().mockResolvedValue([]),
      createToken,
    } as unknown as InferenceSetupClient;
    const commandRunner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.145.0', stderr: '' }
        : { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' }
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(CATALOG), { headers: { ETag: '"v1"' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 })) as typeof fetch;
    const service = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: join(files.root, 'codex') },
      home: files.root,
    });

    await service.setup({ profileName: 'work', profile: files.profile, discovery: files.discovery, client });
    await expect(service.sync({ profileName: 'work', discovery: files.discovery })).rejects.toMatchObject({
      code: 'RUNTIME_TOKEN_REVOKED',
    });
    const doctor = await service.doctor({
      profileName: 'work',
      discovery: files.discovery,
      setupCheck: { status: 'ok', message: 'Authenticated' },
    });
    expect(doctor.ok).toBe(false);
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({ name: 'runtime-probe', status: 'error', message: expect.stringContaining('HTTP 401') })
    );
    expect(createToken).toHaveBeenCalledTimes(1);
    expect(credentials.runtime?.token).toBe('gwi_revoked');
  });

  it('syncs the catalog even when the package-managed Codex config was edited', async () => {
    const files = await fixture();
    const credentials = new MemoryCredentials();
    const client = {
      listTokens: vi.fn().mockResolvedValue([]),
      createToken: vi.fn().mockResolvedValue({
        id: 'token-1',
        prefix: 'gwi_test',
        token: 'gwi_test',
        harness: 'codex',
        deviceName: 'test',
        installationId: files.profile.installationId,
        name: 'Codex',
        createdAt: '2026-07-28T00:00:00Z',
      }),
    } as unknown as InferenceSetupClient;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG), { headers: { 'Content-Type': 'application/json', ETag: '"v1"' } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 })) as typeof fetch;
    const commandRunner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.145.0', stderr: '' }
        : { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' }
    );
    const codexHome = join(files.root, 'codex');
    const service = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: codexHome },
      home: files.root,
    });

    const setup = await service.setup({
      profileName: 'work',
      profile: files.profile,
      discovery: files.discovery,
      client,
    });
    const edited = (await readFile(setup.configFile, 'utf8')).replace('name = "OpenAI"', 'name = "Edited"');
    await writeFile(setup.configFile, edited);
    await writeFile(files.runtimeSource, 'updated packaged runtime');

    await expect(service.sync({ profileName: 'work', discovery: files.discovery })).resolves.toMatchObject({
      status: 'unchanged',
      modelCount: 1,
    });
    await expect(readFile(files.paths.runtimeFile, 'utf8')).resolves.toBe('updated packaged runtime');
  });

  it('rejects Codex versions without command-backed provider auth', async () => {
    const files = await fixture();
    const credentials = new MemoryCredentials();
    const service = new CodexIntegrationService(files.paths, credentials, {
      commandRunner: vi.fn().mockResolvedValue({ code: 0, stdout: 'codex-cli 0.120.0', stderr: '' }),
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: join(files.root, 'codex') },
      home: files.root,
    });

    await expect(
      service.setup({
        profileName: 'work',
        profile: files.profile,
        discovery: files.discovery,
        client: {} as InferenceSetupClient,
      })
    ).rejects.toMatchObject({ code: 'CODEX_UPDATE_REQUIRED' });
  });
});
