import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { CacheService } from '@/services/cache.service.js';
import { MfaService } from './mfa.service.js';

describe('MfaService login challenge consumption', () => {
  it('creates at most one session claim from concurrent valid TOTP requests', async () => {
    const pending = { userId: 'user-1', authMethod: 'email_otp' as const, attempts: 0 };
    let raw: string | null = JSON.stringify(pending);
    const evalChallenge = vi.fn(async (script: string) => {
      if (script.includes("redis.call('DEL', KEYS[1])\nreturn raw")) {
        const claimed = raw;
        raw = null;
        return claimed ?? '';
      }
      throw new Error('unexpected Redis script');
    });
    const cache = {
      get: vi.fn().mockResolvedValue(pending),
      getClient: () => ({ eval: evalChallenge }),
    } as unknown as CacheService;
    const service = new MfaService({} as never, cache, {} as never);
    vi.spyOn(service, 'verifyTotp').mockResolvedValue(true);

    const results = await Promise.all([
      service.verifyLoginChallenge('challenge-id', { totpCode: '123456' }),
      service.verifyLoginChallenge('challenge-id', { totpCode: '123456' }),
    ]);

    expect(results.filter(Boolean)).toEqual([{ userId: 'user-1', authMethod: 'email_otp' }]);
  });

  it('records invalid attempts atomically instead of rewriting the challenge', async () => {
    const pending = { userId: 'user-1', authMethod: 'password' as const, attempts: 0 };
    const evalChallenge = vi.fn().mockResolvedValue(1);
    const cache = {
      get: vi.fn().mockResolvedValue(pending),
      set: vi.fn(),
      getClient: () => ({ eval: evalChallenge }),
    } as unknown as CacheService;
    const service = new MfaService({} as never, cache, {} as never);
    vi.spyOn(service, 'verifyTotp').mockResolvedValue(false);

    await expect(service.verifyLoginChallenge('challenge-id', { totpCode: 'invalid' })).resolves.toBeNull();

    expect(evalChallenge).toHaveBeenCalledWith(expect.any(String), 1, 'mfa:login:challenge-id', 5);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('atomically consumes a passkey-verified login challenge once', async () => {
    let raw: string | null = JSON.stringify({ userId: 'user-1', authMethod: 'password', attempts: 0 });
    const cache = {
      getClient: () => ({
        eval: vi.fn(async () => {
          const claimed = raw;
          raw = null;
          return claimed ?? '';
        }),
      }),
    } as unknown as CacheService;
    const service = new MfaService({} as never, cache, {} as never);

    const results = await Promise.all([
      service.completeVerifiedLoginChallenge('challenge-id'),
      service.completeVerifiedLoginChallenge('challenge-id'),
    ]);

    expect(results.filter(Boolean)).toEqual([{ userId: 'user-1', authMethod: 'password' }]);
  });

  it('generates recovery codes once for concurrent valid TOTP setup confirmations', async () => {
    const pending = { encryptedSecret: { encryptedKey: 'key', encryptedDek: 'dek', iv: 'iv', authTag: 'tag' } };
    let available = true;
    const cache = {
      get: vi.fn().mockResolvedValue(pending),
      take: vi.fn(async () => {
        if (!available) return null;
        available = false;
        return pending;
      }),
    } as unknown as CacheService;
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    };
    const service = new MfaService(db as never, cache, { decryptString: vi.fn().mockReturnValue('secret') } as never);
    vi.spyOn(service as any, 'isValidTotp').mockReturnValue(true);
    vi.spyOn(service, 'regenerateRecoveryCodes').mockResolvedValue(['winner-code']);

    const results = await Promise.allSettled([
      service.confirmTotpSetup('user-1', '123456'),
      service.confirmTotpSetup('user-1', '123456'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: ['winner-code'] },
    ]);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(service.regenerateRecoveryCodes).toHaveBeenCalledTimes(1);
  });
});
