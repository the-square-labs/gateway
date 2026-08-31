import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { CacheService } from '@/services/cache.service.js';
import { LocalAuthService } from './local-auth.service.js';

describe('LocalAuthService challenge consumption', () => {
  it('allows only one concurrent claimant for a one-time challenge', async () => {
    const key = 'local_auth:challenge:challenge-id';
    let raw: string | null = JSON.stringify({
      userId: 'user-1',
      purpose: 'email_otp',
      secretHash: 'hash',
      attempts: 0,
    });
    const evalChallenge = vi.fn(async (_script: string, _keys: number, requestedKey: string) => {
      expect(requestedKey).toBe(key);
      if (!raw) return [0, ''];
      const claimed = raw;
      raw = null;
      return [1, claimed];
    });
    const cache = { getClient: () => ({ eval: evalChallenge }) } as unknown as CacheService;
    const service = new LocalAuthService({} as never, cache, {} as never, {} as never, {} as never, {} as never);

    const results = await Promise.all([
      (service as any).consumeChallenge('challenge-id', 'email_otp', '123456'),
      (service as any).consumeChallenge('challenge-id', 'email_otp', '123456'),
    ]);

    expect(results.filter(Boolean)).toEqual(['user-1']);
    expect(evalChallenge).toHaveBeenCalledTimes(2);
    expect(evalChallenge).toHaveBeenCalledWith(
      expect.any(String),
      1,
      key,
      expect.any(String),
      JSON.stringify(['email_otp']),
      5
    );
  });

  it('does not consume a password link when the password violates policy', async () => {
    const evalChallenge = vi.fn();
    const cache = { getClient: () => ({ eval: evalChallenge }) } as unknown as CacheService;
    const service = new LocalAuthService(
      {} as never,
      cache,
      {} as never,
      {
        getConfig: vi.fn().mockResolvedValue({
          passwordPolicy: {
            minLength: 12,
            maxLength: 128,
            requireUppercase: true,
            requireLowercase: true,
            requireDigit: true,
            requireSymbol: true,
          },
        }),
      } as never,
      {} as never,
      {} as never
    );

    await expect(service.completePasswordLink('challenge-id.secret', 'weak')).rejects.toMatchObject({
      code: 'PASSWORD_POLICY',
    });
    expect(evalChallenge).not.toHaveBeenCalled();
  });
});
