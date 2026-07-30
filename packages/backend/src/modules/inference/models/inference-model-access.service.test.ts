import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { evaluateModelAccess } from './inference-model-access.service.js';

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
});
