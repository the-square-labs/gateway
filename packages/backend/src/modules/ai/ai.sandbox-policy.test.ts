import { describe, expect, it } from 'vitest';
import {
  resolveSandboxPolicy,
  SANDBOX_HIGH_SCOPE,
  SANDBOX_MAX_SCOPE,
  SANDBOX_MEDIUM_SCOPE,
  SANDBOX_USE_SCOPE,
  sandboxScopesSatisfied,
} from './ai.sandbox-policy.js';

describe('sandbox policy', () => {
  it('allows low tier with the base sandbox scope and clamps TTL to the tier cap', () => {
    const policy = resolveSandboxPolicy([SANDBOX_USE_SCOPE], 'low', 99_999);

    expect(policy.tier).toBe('low');
    expect(policy.requestedTtlSeconds).toBe(99_999);
    expect(policy.effectiveTtlSeconds).toBe(4 * 60 * 60);
    expect(policy.requiredScopes).toEqual([SANDBOX_USE_SCOPE]);
  });

  it('requires separate scopes for medium, high, and max tiers', () => {
    expect(() => resolveSandboxPolicy([SANDBOX_USE_SCOPE], 'medium', 60)).toThrow(SANDBOX_MEDIUM_SCOPE);
    expect(() => resolveSandboxPolicy([SANDBOX_USE_SCOPE], 'high', 60)).toThrow(SANDBOX_HIGH_SCOPE);
    expect(() => resolveSandboxPolicy([SANDBOX_USE_SCOPE], 'max', 60)).toThrow(SANDBOX_MAX_SCOPE);

    expect(
      resolveSandboxPolicy([SANDBOX_USE_SCOPE, SANDBOX_MEDIUM_SCOPE], 'medium', undefined).effectiveTtlSeconds
    ).toBe(180);
    expect(resolveSandboxPolicy([SANDBOX_USE_SCOPE, SANDBOX_HIGH_SCOPE], 'high', 90_000).effectiveTtlSeconds).toBe(
      24 * 60 * 60
    );
    expect(resolveSandboxPolicy([SANDBOX_USE_SCOPE, SANDBOX_MAX_SCOPE], 'max', 90_000).effectiveTtlSeconds).toBe(
      12 * 60 * 60
    );
  });

  it('checks persisted required scopes during revocation/reconciliation decisions', () => {
    expect(sandboxScopesSatisfied([SANDBOX_USE_SCOPE, SANDBOX_MEDIUM_SCOPE], [SANDBOX_USE_SCOPE])).toBe(true);
    expect(sandboxScopesSatisfied([SANDBOX_USE_SCOPE], [SANDBOX_USE_SCOPE, SANDBOX_MEDIUM_SCOPE])).toBe(false);
  });
});
