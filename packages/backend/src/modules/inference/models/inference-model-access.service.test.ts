import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { evaluateModelAccess, InferenceModelAccessService } from './inference-model-access.service.js';

const USER: User = {
  id: 'user-1',
  oidcSubject: 'oidc-user-1',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'Users',
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

describe('inference model access precedence', () => {
  const groupAllow = { subjectType: 'group' as const, groupId: 'group-1', userId: null, effect: 'allow' as const };
  const groupDeny = { ...groupAllow, effect: 'deny' as const };
  const userAllow = { subjectType: 'user' as const, groupId: null, userId: 'user-1', effect: 'allow' as const };
  const userDeny = { ...userAllow, effect: 'deny' as const };

  it('uses default, then group, then explicit user override', () => {
    expect(evaluateModelAccess(true, [], 'user-1', 'group-1')).toBe(true);
    expect(evaluateModelAccess(false, [groupAllow], 'user-1', 'group-1')).toBe(true);
    expect(evaluateModelAccess(true, [groupDeny], 'user-1', 'group-1')).toBe(false);
    expect(evaluateModelAccess(false, [groupDeny, userAllow], 'user-1', 'group-1')).toBe(true);
    expect(evaluateModelAccess(true, [groupAllow, userDeny], 'user-1', 'group-1')).toBe(false);
  });

  it('honors secondary groups and gives conflicting group denies precedence regardless of order', () => {
    const secondaryAllow = { ...groupAllow, groupId: 'group-2' };
    expect(evaluateModelAccess(false, [secondaryAllow], 'user-1', ['group-1', 'group-2'])).toBe(true);
    for (const ids of [
      ['group-1', 'group-2'],
      ['group-2', 'group-1'],
    ]) {
      expect(evaluateModelAccess(true, [secondaryAllow, groupDeny], 'user-1', ids)).toBe(false);
      expect(evaluateModelAccess(false, [groupDeny, secondaryAllow, userAllow], 'user-1', ids)).toBe(true);
    }
  });
});

describe('InferenceModelAccessService', () => {
  it('changes the cache key when secondary membership changes, but not when groups are reordered', async () => {
    const redis = { get: vi.fn().mockResolvedValue('[]') };
    const service = new InferenceModelAccessService({} as never, redis as never);
    await service.allowedModelIds(USER);
    await service.allowedModelIds({ ...USER, groupIds: ['group-1', 'group-2'] });
    await service.allowedModelIds({ ...USER, groupIds: ['group-2', 'group-1'] });
    expect(redis.get.mock.calls[0][0]).not.toBe(redis.get.mock.calls[1][0]);
    expect(redis.get.mock.calls[1][0]).toBe(redis.get.mock.calls[2][0]);
  });
  it('accepts the canonical AI scope for inference model access', async () => {
    const redis = { get: vi.fn().mockResolvedValue(JSON.stringify(['model-1'])) };
    const service = new InferenceModelAccessService({} as never, redis as never);

    await expect(service.allowedModelIds(USER)).resolves.toEqual(new Set(['model-1']));
    expect(redis.get).toHaveBeenCalledOnce();
  });

  it('rejects users without AI access before reading the cache', async () => {
    const redis = { get: vi.fn() };
    const service = new InferenceModelAccessService({} as never, redis as never);

    await expect(service.allowedModelIds({ ...USER, scopes: [] })).resolves.toEqual(new Set());
    expect(redis.get).not.toHaveBeenCalled();
  });
});
