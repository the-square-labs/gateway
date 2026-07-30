import { discoverInference } from './discovery.js';

const disabledDiscovery = {
  schemaVersion: 1,
  enabled: false,
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
} as const;

describe('inference discovery', () => {
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
            ...disabledDiscovery,
            enabled: true,
            oauth: { ...disabledDiscovery.oauth, authorizationServer: 'https://attacker.example.com' },
          })
        )
    ) as typeof fetch;
    await expect(discoverInference('https://gateway.example.com', fetcher)).rejects.toMatchObject({
      code: 'UNTRUSTED_OAUTH_ENDPOINT',
    });
  });
});
