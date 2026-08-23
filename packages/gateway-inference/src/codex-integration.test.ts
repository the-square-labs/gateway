import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_ACCOUNT_LOGIN_WARNING, CodexIntegrationService } from './codex-integration.js';
import type { CredentialStore } from './credentials.js';
import { inferenceProxyBaseUrl } from './inference-proxy.js';
import type { InferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import type { CliPaths } from './paths.js';
import type { GatewayProfile } from './profiles.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery, OAuthCredential, RuntimeCredential } from './types.js';

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
      base_instructions: 'Official bundled test instructions.',
      context_window: 128_000,
      auto_compact_token_limit: 100_000,
      input_modalities: ['text'],
      supported_reasoning_levels: [],
    },
  ],
};

const NOOP_PROXY_DAEMON: InferenceProxyDaemonManager = {
  ensure: vi.fn(async ({ paths, profileName }) => ({ baseUrl: inferenceProxyBaseUrl(paths, profileName) })),
  stop: vi.fn(async () => undefined),
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
  return { root, paths, runtimeSource, profile, discovery };
}

describe('CodexIntegrationService', () => {
  it('issues an explicit replacement token and configures the built-in OpenAI provider for Gateway', async () => {
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
        new Response(JSON.stringify(MODELS), { headers: { 'Content-Type': 'application/json', ETag: '"v1"' } })
      );
    const fetcher = fetchMock as typeof fetch;
    const commandRunner = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.145.0\n', stderr: '' };
      if (args[0] === 'login') return { code: 1, stdout: 'Not logged in\n', stderr: '' };
      return { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' };
    });
    const service = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: join(files.root, 'codex') },
      home: files.root,
      proxyDaemon: NOOP_PROXY_DAEMON,
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
    expect(result.defaultModel).toBe('gateway-model');
    expect(result.warning).toBe(CODEX_ACCOUNT_LOGIN_WARNING);
    const config = await readFile(result.configFile, 'utf8');
    expect(config).toContain('model = "gateway-model"');
    expect(config).toContain('model_provider = "openai"');
    expect(config).toContain(`openai_base_url = "${inferenceProxyBaseUrl(files.paths, 'work')}"`);
    expect(config).not.toContain('cli_auth_credentials_store');
    expect(config).not.toContain('gwi_runtime-secret');
    expect(JSON.parse(await readFile(result.catalogFile, 'utf8')).models[0].base_instructions).toBe(
      'Official bundled test instructions.'
    );
    await expect(readFile(join(files.root, 'codex', 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(commandRunner).toHaveBeenCalledWith(
      'codex',
      ['debug', 'models', '--bundled'],
      expect.objectContaining({ CODEX_HOME: join(files.root, 'codex') })
    );
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
      .mockResolvedValueOnce(new Response(JSON.stringify(MODELS), { headers: { ETag: '"v1"' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 })) as typeof fetch;
    const service = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: join(files.root, 'codex') },
      home: files.root,
      proxyDaemon: NOOP_PROXY_DAEMON,
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
        new Response(JSON.stringify(MODELS), { headers: { 'Content-Type': 'application/json', ETag: '"v1"' } })
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
      proxyDaemon: NOOP_PROXY_DAEMON,
    });

    const setup = await service.setup({
      profileName: 'work',
      profile: files.profile,
      discovery: files.discovery,
      client,
    });
    const edited = (await readFile(setup.configFile, 'utf8')).replace(
      `openai_base_url = "${inferenceProxyBaseUrl(files.paths, 'work')}"`,
      'openai_base_url = "http://127.0.0.1:59999/v1"'
    );
    await writeFile(setup.configFile, edited);
    await writeFile(files.runtimeSource, 'updated packaged runtime');
    vi.mocked(NOOP_PROXY_DAEMON.ensure).mockClear();

    await expect(service.sync({ profileName: 'work', discovery: files.discovery })).resolves.toMatchObject({
      status: 'unchanged',
      modelCount: 1,
    });
    await expect(readFile(files.paths.runtimeFile, 'utf8')).resolves.toBe('updated packaged runtime');
    expect(NOOP_PROXY_DAEMON.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: files.paths,
        profileName: 'work',
        remoteBaseUrl: files.discovery.adapters.openai.baseUrl,
        runtimeFile: files.paths.runtimeFile,
      })
    );
  });

  it('keeps shared runtime assets until the last configured Codex home is removed', async () => {
    const files = await fixture();
    const credentials = new MemoryCredentials();
    let configFileAtRevoke = '';
    const activeTokens: Array<{ id: string; harness: string; installationId: string }> = [];
    const createToken = vi.fn(async () => {
      const token = {
        id: 'shared-token',
        prefix: 'gwi_shared',
        token: 'gwi_shared-secret',
        harness: 'codex' as const,
        deviceName: 'test',
        installationId: files.profile.installationId,
        name: 'Codex',
        createdAt: '2026-07-28T00:00:00Z',
      };
      activeTokens.splice(0, activeTokens.length, token);
      return token;
    });
    const revokeToken = vi.fn(async (tokenId: string) => {
      expect(await readFile(configFileAtRevoke, 'utf8')).not.toContain('model_provider = "openai"');
      const index = activeTokens.findIndex((token) => token.id === tokenId);
      if (index >= 0) activeTokens.splice(index, 1);
    });
    const client = {
      listTokens: vi.fn(async () => [...activeTokens]),
      createToken,
      revokeToken,
    } as unknown as InferenceSetupClient;
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(MODELS), {
          headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
        })
    ) as typeof fetch;
    const commandRunner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.145.0', stderr: '' }
        : { code: 0, stdout: JSON.stringify(CATALOG), stderr: '' }
    );
    const homeA = join(files.root, 'codex-a');
    const homeB = join(files.root, 'codex-b');
    const serviceA = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: homeA },
      home: files.root,
      proxyDaemon: NOOP_PROXY_DAEMON,
    });
    const serviceB = new CodexIntegrationService(files.paths, credentials, {
      fetch: fetcher,
      commandRunner,
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: homeB },
      home: files.root,
      proxyDaemon: NOOP_PROXY_DAEMON,
    });

    const setupA = await serviceA.setup({
      profileName: 'work',
      profile: files.profile,
      discovery: files.discovery,
      client,
    });
    const setupB = await serviceB.setup({
      profileName: 'work',
      profile: files.profile,
      discovery: files.discovery,
      client,
    });

    expect(createToken).toHaveBeenCalledTimes(1);
    expect(setupA.configFile).toBe(join(homeA, 'config.toml'));
    expect(setupB.configFile).toBe(join(homeB, 'config.toml'));
    expect(credentials.runtime?.tokenId).toBe('shared-token');

    configFileAtRevoke = setupA.configFile;
    await expect(serviceB.remove({ profileName: 'work', removeToken: true, client })).resolves.toMatchObject({
      removed: true,
      tokenRevoked: false,
    });
    expect(revokeToken).not.toHaveBeenCalled();
    expect(credentials.runtime?.tokenId).toBe('shared-token');
    await expect(readFile(setupA.catalogFile, 'utf8')).resolves.toContain('gateway-model');
    await expect(readFile(setupA.configFile, 'utf8')).resolves.toContain('model_provider = "openai"');

    await expect(serviceA.remove({ profileName: 'work', removeToken: true, client })).resolves.toMatchObject({
      removed: true,
      tokenRevoked: true,
    });
    expect(revokeToken).toHaveBeenCalledOnce();
    expect(credentials.runtime).toBeNull();
    await expect(readFile(setupA.catalogFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Codex versions without the required model catalog support', async () => {
    const files = await fixture();
    const credentials = new MemoryCredentials();
    const service = new CodexIntegrationService(files.paths, credentials, {
      commandRunner: vi.fn().mockResolvedValue({ code: 0, stdout: 'codex-cli 0.120.0', stderr: '' }),
      runtimeSource: files.runtimeSource,
      env: { CODEX_HOME: join(files.root, 'codex') },
      home: files.root,
      proxyDaemon: NOOP_PROXY_DAEMON,
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
