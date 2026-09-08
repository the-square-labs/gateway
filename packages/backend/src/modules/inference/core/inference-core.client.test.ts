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
    await expect(client().coreProviderLiveModelIds('provider')).rejects.toThrow();
  });
  it('reserves null for explicit not-applicable discovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ applicable: false, reason: 'static_catalog' })));
    expect(await client().coreProviderLiveModelIds('provider')).toBeNull();
  });
  it('uses a discovery timeout longer than the core 8-second upstream budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, modelIds: ['one'] })));
    expect(await client().coreProviderLiveModelIds('provider')).toEqual(['one']);
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
});
