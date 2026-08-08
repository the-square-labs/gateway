import { hasScope } from '@/lib/permissions.js';

export const SANDBOX_USE_SCOPE = 'ai:sandbox:use';
export const SANDBOX_MEDIUM_SCOPE = 'ai:sandbox:tier:medium';
export const SANDBOX_HIGH_SCOPE = 'ai:sandbox:tier:high';
export const SANDBOX_MANAGE_SCOPE = 'ai:sandbox:manage';

export const SANDBOX_RESOURCE_TIERS = ['low', 'medium', 'high'] as const;
export type SandboxResourceTier = (typeof SANDBOX_RESOURCE_TIERS)[number];

export const SANDBOX_RUNTIMES = ['alpine', 'node', 'python'] as const;
export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

export type SandboxJobKind = 'script' | 'process';
export type SandboxJobStatus =
  | 'queued'
  | 'running'
  | 'exited'
  | 'killed'
  | 'timeout'
  | 'failed'
  | 'revoked'
  | 'expired';

export interface SandboxTierPolicy {
  tier: SandboxResourceTier;
  requiredScopes: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  cpuQuota: number;
  memoryBytes: number;
  workspaceBytes: number;
  pidsLimit: number;
}

export const SANDBOX_TIER_POLICIES: Record<SandboxResourceTier, SandboxTierPolicy> = {
  low: {
    tier: 'low',
    requiredScopes: [SANDBOX_USE_SCOPE],
    defaultTtlSeconds: 60,
    maxTtlSeconds: 4 * 60 * 60,
    cpuQuota: 25_000,
    memoryBytes: 256 * 1024 * 1024,
    workspaceBytes: 2 * 1024 * 1024 * 1024,
    pidsLimit: 64,
  },
  medium: {
    tier: 'medium',
    requiredScopes: [SANDBOX_USE_SCOPE, SANDBOX_MEDIUM_SCOPE],
    defaultTtlSeconds: 180,
    maxTtlSeconds: 12 * 60 * 60,
    cpuQuota: 50_000,
    memoryBytes: 512 * 1024 * 1024,
    workspaceBytes: 4 * 1024 * 1024 * 1024,
    pidsLimit: 128,
  },
  high: {
    tier: 'high',
    requiredScopes: [SANDBOX_USE_SCOPE, SANDBOX_HIGH_SCOPE],
    defaultTtlSeconds: 300,
    maxTtlSeconds: 24 * 60 * 60,
    cpuQuota: 100_000,
    memoryBytes: 1024 * 1024 * 1024,
    workspaceBytes: 6 * 1024 * 1024 * 1024,
    pidsLimit: 256,
  },
};

export interface ResolvedSandboxPolicy {
  tier: SandboxResourceTier;
  requestedTtlSeconds: number;
  effectiveTtlSeconds: number;
  requiredScopes: string[];
  tierPolicy: SandboxTierPolicy;
}

export function normalizeSandboxTier(value: unknown): SandboxResourceTier {
  return SANDBOX_RESOURCE_TIERS.includes(value as SandboxResourceTier) ? (value as SandboxResourceTier) : 'low';
}

export function normalizeSandboxRuntime(value: unknown): SandboxRuntime {
  return SANDBOX_RUNTIMES.includes(value as SandboxRuntime) ? (value as SandboxRuntime) : 'alpine';
}

export function resolveSandboxPolicy(
  userScopes: string[],
  tierInput: unknown,
  ttlInput: unknown
): ResolvedSandboxPolicy {
  const tier = normalizeSandboxTier(tierInput);
  const tierPolicy = SANDBOX_TIER_POLICIES[tier];
  const requestedTtlSeconds =
    typeof ttlInput === 'number' && Number.isFinite(ttlInput)
      ? Math.max(1, Math.floor(ttlInput))
      : tierPolicy.defaultTtlSeconds;
  const effectiveTtlSeconds = Math.min(requestedTtlSeconds, tierPolicy.maxTtlSeconds);
  const missingScope = tierPolicy.requiredScopes.find((scope) => !hasScope(userScopes, scope));

  if (missingScope) {
    throw new Error(`Sandbox tier "${tier}" requires scope "${missingScope}"`);
  }

  return {
    tier,
    requestedTtlSeconds,
    effectiveTtlSeconds,
    requiredScopes: [...tierPolicy.requiredScopes],
    tierPolicy,
  };
}

export function hasSandboxAccess(userScopes: string[]): boolean {
  return hasScope(userScopes, SANDBOX_USE_SCOPE);
}

export function hasSandboxManageAccess(userScopes: string[]): boolean {
  return hasScope(userScopes, SANDBOX_MANAGE_SCOPE);
}

export function sandboxScopesSatisfied(userScopes: string[], requiredScopes: readonly string[]): boolean {
  return requiredScopes.every((scope) => hasScope(userScopes, scope));
}
