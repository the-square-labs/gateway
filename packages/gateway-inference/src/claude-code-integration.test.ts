import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { ClaudeCodeIntegrationService } from './claude-code-integration.js';
import type { CredentialStore } from './credentials.js';
import type { CliPaths } from './paths.js';
import type { InferenceDiscovery, RuntimeCredential } from './types.js';

vi.mock('./runtime.js', () => ({
  installPrivateRuntime: vi.fn(async (_source: string, destination: string) => ({
    updated: true,
    path: destination,
  })),
}));

describe('Claude Code integration', () => {
  it('creates a separate token, validates native streaming, and writes Claude settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-claude-integration-'));
    const paths = cliPaths(root);
    let runtime: RuntimeCredential | null = null;
    const credentials = {
      getRuntime: vi.fn(async (_profile: string, harness?: string) => (harness === 'claude-code' ? runtime : null)),
      setRuntime: vi.fn(async (_profile: string, value: RuntimeCredential) => {
        runtime = value;
      }),
      deleteRuntime: vi.fn(async () => {
        runtime = null;
      }),
    } as unknown as CredentialStore;
    const client = {
      listTokens: vi.fn(async () => []),
      createToken: vi.fn(async () => ({
        token: 'gwi_claude-secret',
        id: 'token-1',
        name: 'Claude Code laptop',
        prefix: 'gwi_claude',
        harness: 'claude-code',
        deviceName: 'laptop',
        installationId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-31T00:00:00Z',
      })),
      revokeToken: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/models')) {
        return Response.json({
          data: [{ id: 'claude-gateway-a2ltaS1rMw', display_name: 'Kimi K3' }],
        });
      }
      if (url.includes('/v1/messages')) {
        return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new ClaudeCodeIntegrationService(paths, credentials, {
      fetch: fetcher as typeof fetch,
      commandRunner: vi.fn(async () => ({ code: 0, stdout: '2.1.129 (Claude Code)', stderr: '' })),
      runtimeSource: join(root, 'source.js'),
      home: root,
      env: {},
    });

    const result = await service.setup({
      profileName: 'default',
      profile: {
        origin: 'https://gateway.example.com',
        installationId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-31T00:00:00Z',
        updatedAt: '2026-07-31T00:00:00Z',
      },
      discovery: discovery(),
      client: client as never,
    });

    expect(result).toMatchObject({
      claudeCodeVersion: '2.1.129',
      defaultModel: 'claude-gateway-a2ltaS1rMw',
      modelCount: 1,
    });
    expect(client.createToken).toHaveBeenCalledWith({
      harness: 'claude-code',
      installationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(credentials.setRuntime).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ harness: 'claude-code', token: 'gwi_claude-secret' }),
      'claude-code'
    );
    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://gateway.example.com/api/inference',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-gateway-a2ltaS1rMw',
    });
    expect(settings.apiKeyHelper).toContain('__credential');
    expect(settings.apiKeyHelper).not.toContain('gwi_claude-secret');
  });
});

function discovery(): InferenceDiscovery {
  return {
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
}

function cliPaths(root: string): CliPaths {
  return {
    configDir: root,
    dataDir: root,
    profilesFile: join(root, 'profiles.json'),
    fileCredentialsFile: join(root, 'credentials.json'),
    runtimeDir: join(root, 'runtime'),
    runtimeFile: join(root, 'runtime', 'gateway-cli.js'),
  };
}
