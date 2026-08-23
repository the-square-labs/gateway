import { readFile } from 'node:fs/promises';
import { CLI_VERSION, discoverInference } from './discovery.js';

const enabledDiscovery = {
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
} as const;

const disabledDiscovery = { ...enabledDiscovery, enabled: false } as const;

const legacyDiscovery = {
  schemaVersion: 1,
  enabled: true,
  minimumCliVersion: '0.1.0',
  oauth: enabledDiscovery.oauth,
  adapters: {
    openai: { baseUrl: 'https://gateway.example.com/api/inference/v1' },
    codex: {
      baseUrl: 'https://gateway.example.com/api/inference/codex/v1',
      catalogUrl: 'https://gateway.example.com/api/inference/codex/v1/models',
    },
    anthropic: { baseUrl: 'https://gateway.example.com/api/inference/anthropic' },
  },
  harnessSpecificEndpointsEnabled: false,
  harnesses: { codex: { supported: false } },
} as const;

describe('inference discovery', () => {
  it('keeps the runtime version aligned with package.json', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
    };
    expect(CLI_VERSION).toBe(packageJson.version);
    expect(packageJson.bin).toEqual({ 'gateway-inference': 'dist/cli.js' });
  });

  it('accepts the schema version 2 discovery document', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(enabledDiscovery))) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).resolves.toMatchObject({
      schemaVersion: 2,
      adapters: {
        openai: { baseUrl: 'https://gateway.example.com/api/inference/v1' },
        anthropic: { baseUrl: 'https://gateway.example.com/api/inference' },
      },
    });
  });

  it('normalizes schema version 1 without selecting its legacy harness endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(legacyDiscovery))) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).resolves.toEqual({
      schemaVersion: 1,
      enabled: true,
      minimumCliVersion: '0.1.0',
      oauth: legacyDiscovery.oauth,
      adapters: {
        openai: legacyDiscovery.adapters.openai,
        anthropic: legacyDiscovery.adapters.anthropic,
      },
    });
  });

  it('rejects schema version 2 documents without both adapter base URLs', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...enabledDiscovery,
            adapters: { openai: enabledDiscovery.adapters.openai },
          })
        )
    ) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_GATEWAY',
    });
  });

  it('stops login before authentication when inference is disabled', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(disabledDiscovery))) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).rejects.toMatchObject({
      code: 'INFERENCE_DISABLED',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('permits disabled discovery for logout revocation metadata', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(disabledDiscovery))) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher, false)).resolves.toMatchObject({
      enabled: false,
    });
  });

  it('rejects cross-origin OAuth discovery', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...enabledDiscovery,
            oauth: { ...enabledDiscovery.oauth, authorizationServer: 'https://attacker.example.com' },
          })
        )
    ) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).rejects.toMatchObject({
      code: 'UNTRUSTED_OAUTH_ENDPOINT',
    });
  });

  it('rejects cross-origin adapter endpoints before storing a Gateway token', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...enabledDiscovery,
            adapters: {
              ...enabledDiscovery.adapters,
              openai: { baseUrl: 'https://attacker.example.com/v1' },
            },
          })
        )
    ) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).rejects.toMatchObject({
      code: 'UNTRUSTED_OAUTH_ENDPOINT',
    });
  });
});
