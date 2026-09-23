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

describe('MfaService second-factor step-up', () => {
  function createStepUpHarness(options: { hasFactor: boolean; validTotp?: boolean }) {
    const store = new Map<string, unknown>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      incr: vi.fn(async (key: string) => {
        const next = Number(store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      }),
      expire: vi.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const service = new MfaService({} as never, cache, {} as never);
    vi.spyOn(service, 'requiresLocalMfa').mockResolvedValue(options.hasFactor);
    vi.spyOn(service, 'verifyTotp').mockResolvedValue(options.validTotp ?? true);
    return { service, store };
  }

  it('lets an account without any second factor enroll its first one', async () => {
    const { service } = createStepUpHarness({ hasFactor: false });

    await expect(service.assertSecondFactorChangeAllowed('user-1', 'session-1')).resolves.toBeUndefined();
  });

  it('requires a fresh proof before an existing factor can be changed', async () => {
    const { service } = createStepUpHarness({ hasFactor: true });

    await expect(service.assertSecondFactorChangeAllowed('user-1', 'session-1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'MFA_STEP_UP_REQUIRED',
    });
  });

  it('accepts a verified TOTP proof only for the session that produced it', async () => {
    const { service, store } = createStepUpHarness({ hasFactor: true });

    await expect(service.verifyStepUpCode('user-1', 'session-1', { totpCode: '123456' })).resolves.toBe(true);

    await expect(service.assertSecondFactorChangeAllowed('user-1', 'session-1')).resolves.toBeUndefined();
    await expect(service.assertSecondFactorChangeAllowed('user-1', 'session-2')).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
    await expect(service.assertSecondFactorChangeAllowed('user-2', 'session-1')).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
    // The raw session id is never used as a cache key.
    expect([...store.keys()].some((key) => key.includes('session-1'))).toBe(false);
  });

  it('locks step-up verification after repeated invalid codes', async () => {
    const { service } = createStepUpHarness({ hasFactor: true, validTotp: false });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.verifyStepUpCode('user-1', 'session-1', { totpCode: '000000' })).resolves.toBe(false);
    }
    await expect(service.verifyStepUpCode('user-1', 'session-1', { totpCode: '000000' })).rejects.toMatchObject({
      statusCode: 429,
      code: 'MFA_STEP_UP_LOCKED',
    });
    await expect(service.assertSecondFactorChangeAllowed('user-1', 'session-1')).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
  });
});
