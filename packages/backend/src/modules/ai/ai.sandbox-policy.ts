export type SandboxResourceTier = 'low' | 'medium' | 'high';
export type SandboxRuntime = 'alpine' | 'node' | 'python';
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
export interface ResolvedSandboxPolicy {
  tier: SandboxResourceTier;
  requestedTtlSeconds: number;
  effectiveTtlSeconds: number;
  requiredScopes: string[];
  tierPolicy: SandboxTierPolicy;
}
