import { InferenceSetupClient } from './tokens.js';

describe('inference setup token client', () => {
  it('uses the locked list/create/revoke schemas', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'token-1',
            name: 'Codex on Laptop',
            prefix: 'gwi_abc',
            token: 'gwi_raw-secret',
            harness: 'codex',
            deviceName: 'Laptop',
            installationId: 'b9723dda-c76b-48d0-a44a-507dc51fbf95',
            createdAt: '2026-07-28T00:00:00.000Z',
          }),
          { status: 201 }
        );
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ data: [] }));
    }) as typeof fetch;
    const client = new InferenceSetupClient('https://gateway.example.com', 'gwo_setup-secret', fetcher);

    expect(await client.listTokens()).toEqual([]);
    await client.createToken({
      installationId: 'b9723dda-c76b-48d0-a44a-507dc51fbf95',
      deviceName: 'Laptop',
      replaceExisting: true,
    });
    await client.revokeToken('token/1');

    expect(calls[0].url).toBe('https://gateway.example.com/api/inference/setup/tokens');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer gwo_setup-secret');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      harness: 'codex',
      deviceName: 'Laptop',
      installationId: 'b9723dda-c76b-48d0-a44a-507dc51fbf95',
      replaceExisting: true,
    });
    expect(calls[2].url.endsWith('/api/inference/setup/tokens/token%2F1')).toBe(true);
  });

  it('preserves a denied-user Gateway error without exposing authorization', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'INFERENCE_SETUP_FORBIDDEN', message: 'Inference setup is not allowed' }), {
          status: 403,
        })
    ) as typeof fetch;
    const client = new InferenceSetupClient('https://gateway.example.com', 'gwo_setup-secret', fetcher);
    await expect(client.me()).rejects.toMatchObject({
      code: 'INFERENCE_SETUP_FORBIDDEN',
      message: 'Inference setup is not allowed',
    });
  });
});
