import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceCoreClient } from './inference-core.client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('core live discovery outcomes', () => {
  const client = () => new InferenceCoreClient('http://core', 'mock');
  it.each([
    null,
    { ok: false },
    { ok: true },
    'invalid',
  ])('rejects failed or malformed discovery instead of reporting success: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(client().coreProviderLiveModels('provider')).rejects.toThrow();
  });
  it('reserves null for explicit not-applicable discovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ applicable: false, reason: 'static_catalog' })));
    expect(await client().coreProviderLiveModels('provider')).toBeNull();
  });
  it('uses a discovery timeout longer than the core 8-second upstream budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, modelIds: ['one'] })));
    expect(await client().coreProviderLiveModels('provider')).toEqual([{ id: 'one' }]);
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
  it('keeps live model metadata alongside discovered ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ok: true,
          modelIds: ['gpt-6-sol'],
          modelDetails: [
            {
              id: 'gpt-6-sol',
              displayName: 'GPT-6 Sol',
              contextWindow: 1_050_000,
              maxInputTokens: 922_000,
              maxOutputTokens: 128_000,
              reasoningEfforts: ['low', 'high'],
              inputModalities: ['text', 'image'],
              capabilities: ['tools', 'reasoning'],
            },
          ],
        })
      )
    );
    await expect(client().coreProviderLiveModels('provider')).resolves.toEqual([
      {
        id: 'gpt-6-sol',
        displayName: 'GPT-6 Sol',
        contextWindow: 1_050_000,
        maxInputTokens: 922_000,
        maxOutputTokens: 128_000,
        reasoningEfforts: ['low', 'high'],
        inputModalities: ['text', 'image'],
        capabilities: ['tools', 'reasoning'],
      },
    ]);
  });

  it('removes the core provider namespace from upstream model ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ok: true,
          modelIds: ['anthropic/claude-sonnet-5-5'],
          modelDetails: [
            {
              id: 'anthropic/claude-sonnet-5-5',
              displayName: 'anthropic/claude-sonnet-5-5',
              contextWindow: 1_000_000,
              inputModalities: ['text'],
              capabilities: ['reasoning'],
            },
          ],
        })
      )
    );

    await expect(client().coreProviderLiveModels('anthropic')).resolves.toEqual([
      {
        id: 'claude-sonnet-5-5',
        displayName: 'claude-sonnet-5-5',
        contextWindow: 1_000_000,
        inputModalities: ['text'],
        capabilities: ['reasoning'],
      },
    ]);
  });
});
