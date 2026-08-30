import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { User } from '@/types.js';

let demoMode = false;
const resolvedUsers = new Map<string, User>();

vi.mock('./demo-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demo-mode.js')>()),
  isDemoMode: () => demoMode,
}));

vi.mock('@/modules/auth/live-session-user.js', () => ({
  resolveLiveUser: vi.fn(async (_db: unknown, id: string) => resolvedUsers.get(id) ?? null),
}));

const { DemoAuthService, __testOnly } = await import('./demo-auth.service.js');

interface IdentityRow {
  id: string;
  authMethod: string;
  groupName: string;
  isBlocked: boolean;
}

function fakeDb(identityRows: Array<IdentityRow | null>) {
  const insert = vi.fn();
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  insert.mockReturnValue({ values });
  const limit = vi.fn(async () => {
    const next = identityRows.shift() ?? null;
    return next ? [next] : [];
  });
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  const db = {
    select,
    insert,
    query: {
      permissionGroups: {
        findFirst: vi.fn().mockResolvedValue({ id: 'demo-group', name: 'demo-admin', isBuiltin: true }),
      },
    },
  } as unknown as DrizzleClient;
  return { db, insert, values, onConflictDoNothing, select };
}

function dependencies(identityRows: Array<IdentityRow | null>) {
  const database = fakeDb(identityRows);
  const cacheValues = new Map<string, unknown>();
  const evalChallenge = vi.fn(
    async (_script: string, _keyCount: number, key: string, secretHash: string, maxAttempts: number) => {
      const challenge = cacheValues.get(key) as { secretHash: string; attempts: number } | undefined;
      if (!challenge || challenge.attempts >= maxAttempts) return [0, ''];
      if (challenge.secretHash === secretHash) {
        cacheValues.delete(key);
        return [1, JSON.stringify(challenge)];
      }
      challenge.attempts += 1;
      if (challenge.attempts >= maxAttempts) cacheValues.delete(key);
      return [0, ''];
    }
  );
  const cache = {
    set: vi.fn(async (key: string, value: unknown) => {
      cacheValues.set(key, value);
    }),
    get: vi.fn(async (key: string) => cacheValues.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      cacheValues.delete(key);
    }),
    getClient: vi.fn(() => ({ eval: evalChallenge })),
  } as unknown as CacheService;
  const mail = { sendSecurityEmail: vi.fn().mockResolvedValue(undefined) } as unknown as AuthMailService;
  return { ...database, cache, evalChallenge, mail, service: new DemoAuthService(database.db, cache, mail) };
}

describe('DemoAuthService isolation', () => {
  beforeEach(() => {
    demoMode = false;
    resolvedUsers.clear();
  });

  it('has zero database, cache, and email side effects outside demo mode', async () => {
    const { service, select, insert, cache, mail } = dependencies([]);

    await expect(service.requestCode('new@example.test')).resolves.toBeNull();

    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(mail.sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('sends a namespaced challenge without creating an identity before mailbox proof', async () => {
    demoMode = true;
    const { service, insert, cache, mail } = dependencies([null]);

    const challengeId = await service.requestCode(' New@Example.Test ');

    expect(challengeId).toEqual(expect.any(String));
    expect(insert).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      `${__testOnly.DEMO_CHALLENGE_PREFIX}${challengeId}`,
      expect.objectContaining({ email: 'new@example.test', attempts: 0 }),
      __testOnly.DEMO_CHALLENGE_TTL_SECONDS
    );
    expect(mail.sendSecurityEmail).toHaveBeenCalledWith('new@example.test', {
      kind: 'email_otp',
      code: expect.stringMatching(/^\d{6}$/),
    });
  });

  it('race-safely creates the demo identity only after a valid code', async () => {
    demoMode = true;
    const created: IdentityRow = {
      id: 'demo-user',
      authMethod: 'demo_email_otp',
      groupName: 'demo-admin',
      isBlocked: false,
    };
    resolvedUsers.set('demo-user', {
      id: 'demo-user',
      oidcSubject: null,
      authMethod: 'demo_email_otp',
      email: 'new@example.test',
      name: 'new@example.test',
      avatarUrl: null,
      groupId: 'demo-group',
      groupName: 'demo-admin',
      scopes: [],
      isBlocked: false,
    });
    const { service, values, onConflictDoNothing, mail } = dependencies([null, null, created]);
    const challengeId = await service.requestCode('new@example.test');
    const code = (vi.mocked(mail.sendSecurityEmail).mock.calls[0]![1] as { kind: 'email_otp'; code: string }).code;

    await expect(service.verifyCode(challengeId!, code)).resolves.toMatchObject({ id: 'demo-user' });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'demo_email_otp', email: 'new@example.test', groupId: 'demo-group' })
    );
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('does not convert or email an existing non-demo identity', async () => {
    demoMode = true;
    const existing: IdentityRow = {
      id: 'ordinary-user',
      authMethod: 'email_otp',
      groupName: 'admin',
      isBlocked: false,
    };
    const { service, insert, cache, mail } = dependencies([existing]);

    await expect(service.requestCode('existing@example.test')).resolves.toBeNull();

    expect(insert).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(mail.sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('rejects an on-conflict winner that is not a demo identity', async () => {
    demoMode = true;
    const raced: IdentityRow = {
      id: 'raced-user',
      authMethod: 'password',
      groupName: 'admin',
      isBlocked: false,
    };
    const { service, onConflictDoNothing, mail } = dependencies([null, null, raced]);

    const challengeId = await service.requestCode('race@example.test');
    const code = (vi.mocked(mail.sendSecurityEmail).mock.calls[0]![1] as { kind: 'email_otp'; code: string }).code;
    await expect(service.verifyCode(challengeId!, code)).resolves.toBeNull();

    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('does not reinterpret OIDC or password system-admin identities as email OTP', async () => {
    demoMode = true;
    const systemAdmin: IdentityRow = {
      id: 'system-admin',
      authMethod: 'oidc',
      groupName: 'system-admin',
      isBlocked: false,
    };
    const { service, insert, mail } = dependencies([systemAdmin]);

    await expect(service.requestCode('owner@example.test')).resolves.toBeNull();
    expect(insert).not.toHaveBeenCalled();
    expect(mail.sendSecurityEmail).not.toHaveBeenCalled();
  });
});
