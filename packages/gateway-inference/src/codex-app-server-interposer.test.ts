import { describe, expect, it, vi } from 'vitest';
import { CodexUsageInterposer, JsonLineDecoder } from './codex-app-server-interposer.js';
import type { GatewayUsageSource } from './codex-usage.js';

const usage = {
  enabled: true,
  api: { configured: false, percentage: 0, recoveryAt: '2026-09-01T00:00:00.000Z' },
  subscription: {
    '5h': { configured: true, percentage: 25, recoveryAt: '2026-08-23T15:00:00.000Z' },
    '7d': { configured: true, percentage: 50, recoveryAt: '2026-08-30T00:00:00.000Z' },
    '30d': { configured: false, percentage: 0, recoveryAt: '2026-09-22T00:00:00.000Z' },
  },
  tokens: { lifetime: 1000, daily: [{ date: '2026-08-23', tokens: 100 }] },
};

function source(overrides: Partial<GatewayUsageSource> = {}) {
  return {
    read: vi.fn().mockResolvedValue(usage),
    changed: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as GatewayUsageSource;
}

describe('Codex app-server usage interposer', () => {
  it('answers rate-limit reads without forwarding them', async () => {
    const result = await new CodexUsageInterposer(source()).handleClientLine(
      JSON.stringify({ id: 7, method: 'account/rateLimits/read', params: null })
    );
    expect(result.forward).toEqual([]);
    expect(JSON.parse(result.respond[0])).toMatchObject({
      id: 7,
      result: { rateLimits: { limitId: 'gateway-subscription' } },
    });
  });

  it('answers account usage reads even when a thread id is supplied', async () => {
    const result = await new CodexUsageInterposer(source()).handleClientLine(
      JSON.stringify({ id: 'usage-1', method: 'account/usage/read', params: { threadId: 'thread-1' } })
    );
    expect(result.forward).toEqual([]);
    expect(JSON.parse(result.respond[0])).toMatchObject({
      id: 'usage-1',
      result: { summary: { lifetimeTokens: 1000 }, threadUsage: null },
    });
  });

  it('passes unrelated and malformed client frames through unchanged', async () => {
    const interposer = new CodexUsageInterposer(source());
    await expect(interposer.handleClientLine('{"id":1,"method":"thread/list"}')).resolves.toEqual({
      forward: ['{"id":1,"method":"thread/list"}'],
      respond: [],
    });
    await expect(interposer.handleClientLine('not-json')).resolves.toEqual({ forward: ['not-json'], respond: [] });
  });

  it('suppresses native OpenAI rate-limit notifications', async () => {
    await expect(
      new CodexUsageInterposer(source()).handleServerLine(
        JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: {} } })
      )
    ).resolves.toEqual({ forward: [], notify: [] });
  });

  it('refreshes after turn completion and deduplicates unchanged notifications', async () => {
    const changed = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const interposer = new CodexUsageInterposer(source({ changed } as never));
    const line = JSON.stringify({ method: 'turn/completed', params: { threadId: 't' } });
    const first = await interposer.handleServerLine(line);
    first.notify = await first.deferredNotify!;
    const second = await interposer.handleServerLine(line);
    second.notify = await second.deferredNotify!;
    expect(first.forward).toEqual([line]);
    expect(first.notify).toHaveLength(1);
    expect(JSON.parse(first.notify[0])).toMatchObject({ method: 'account/rateLimits/updated' });
    expect(second.notify).toEqual([]);
  });

  it('forwards turn completion when the optional usage refresh fails', async () => {
    const interposer = new CodexUsageInterposer(
      source({ read: vi.fn().mockRejectedValue(new Error('offline')) } as never)
    );
    const line = JSON.stringify({ method: 'turn/completed', params: { threadId: 't' } });
    const result = await interposer.handleServerLine(line);
    expect(result.forward).toEqual([line]);
    await expect(result.deferredNotify).resolves.toEqual([]);
  });

  it('returns turn completion before a slow usage refresh settles', async () => {
    let finish!: (value: typeof usage) => void;
    const pending = new Promise<typeof usage>((resolve) => {
      finish = resolve;
    });
    const interposer = new CodexUsageInterposer(source({ read: vi.fn().mockReturnValue(pending) } as never));
    const line = JSON.stringify({ method: 'turn/completed', params: { threadId: 't' } });
    const result = await interposer.handleServerLine(line);
    expect(result.forward).toEqual([line]);
    expect(result.notify).toEqual([]);
    finish(usage);
    await expect(result.deferredNotify).resolves.toHaveLength(1);
  });

  it('returns an app-server error rather than OpenAI usage on initial failure', async () => {
    const interposer = new CodexUsageInterposer(
      source({ read: vi.fn().mockRejectedValue(new Error('offline')) } as never)
    );
    const result = await interposer.safeClientLine(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }));
    expect(result.forward).toEqual([]);
    expect(JSON.parse(result.respond[0])).toEqual({
      id: 2,
      error: { code: -32001, message: 'Gateway usage is unavailable.', data: { code: 'CODEX_USAGE_UNAVAILABLE' } },
    });
  });

  it('bounds JSONL frames and accepts terminal-less EOF frames', () => {
    const decoder = new JsonLineDecoder(8);
    expect(decoder.push('{"a":1}\n')).toEqual(['{"a":1}']);
    expect(decoder.push('last')).toEqual([]);
    expect(decoder.finish()).toEqual(['last']);
    expect(() => new JsonLineDecoder(3).push('four')).toThrowError(/size limit/);
  });
});
