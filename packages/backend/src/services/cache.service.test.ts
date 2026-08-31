import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service.js';

describe('CacheService.take', () => {
  it('atomically returns and deletes a cached JSON value', async () => {
    const evalScript = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ challenge: 'challenge-1' }))
      .mockResolvedValueOnce(null);
    const cache = new CacheService({ eval: evalScript } as never);

    await expect(cache.take<{ challenge: string }>('passkey:authentication:challenge-1')).resolves.toEqual({
      challenge: 'challenge-1',
    });
    await expect(cache.take('passkey:authentication:challenge-1')).resolves.toBeNull();
    expect(evalScript).toHaveBeenCalledWith(expect.any(String), 1, 'passkey:authentication:challenge-1');
  });
});
