import type {
  DockerArtifactPolicyDecision,
  DockerBuildPolicySnapshot,
  DockerBuildScanSummary,
  DockerBuildStatus,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

export const WORKER_ACTIVE_BUILD_STATUSES: DockerBuildStatus[] = [
  'claimed',
  'checking_out',
  'building',
  'scanning',
  'pushing',
];

export const ACTIVE_BUILD_STATUSES: DockerBuildStatus[] = [...WORKER_ACTIVE_BUILD_STATUSES, 'deploying'];

export const TERMINAL_BUILD_STATUSES: DockerBuildStatus[] = ['succeeded', 'failed', 'cancelled', 'superseded'];

export const BUILD_LOG_CHUNK_MAX_BYTES = 256 * 1024;
export const BUILD_LOG_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_BUILD_LEASE_MS = 60_000;
export const ENFORCED_BUILD_CPU_LIMIT_MILLIS = 2000;
export const ENFORCED_BUILD_MEMORY_LIMIT_BYTES = 4 * 1024 ** 3;
export const ENFORCED_BUILD_DISK_LIMIT_BYTES = 20 * 1024 ** 3;

export interface DockerBuildRolloutProgress {
  operationId: string;
  attempt: number;
  phase: 'accepted' | 'executing';
}

export function readDockerBuildRolloutProgress(progress: unknown): DockerBuildRolloutProgress | null {
  if (!progress || typeof progress !== 'object') return null;
  const rollout = (progress as Record<string, unknown>).rollout;
  if (!rollout || typeof rollout !== 'object') return null;
  const value = rollout as Record<string, unknown>;
  if (
    typeof value.operationId !== 'string' ||
    !value.operationId ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    (value.phase !== 'accepted' && value.phase !== 'executing')
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    attempt: Number(value.attempt),
    phase: value.phase,
  };
}

export const dockerBuildLimits = {
  logChunkMaxBytes: BUILD_LOG_CHUNK_MAX_BYTES,
  logTotalMaxBytes: BUILD_LOG_TOTAL_MAX_BYTES,
  defaultLeaseMs: DEFAULT_BUILD_LEASE_MS,
  enforcedCpuLimitMillis: ENFORCED_BUILD_CPU_LIMIT_MILLIS,
  enforcedMemoryLimitBytes: ENFORCED_BUILD_MEMORY_LIMIT_BYTES,
  enforcedDiskLimitBytes: ENFORCED_BUILD_DISK_LIMIT_BYTES,
};

const BUILD_TRANSITIONS: Record<DockerBuildStatus, readonly DockerBuildStatus[]> = {
  queued: ['claimed', 'cancelled', 'superseded'],
  claimed: ['checking_out', 'failed', 'cancelled', 'superseded'],
  checking_out: ['building', 'failed', 'cancelled', 'superseded'],
  building: ['scanning', 'failed', 'cancelled', 'superseded'],
  scanning: ['pushing', 'failed', 'cancelled', 'superseded'],
  pushing: ['deploying', 'succeeded', 'failed', 'cancelled', 'superseded'],
  deploying: ['succeeded', 'failed', 'cancelled', 'superseded'],
  succeeded: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

export const DEFAULT_BUILDER_PARALLELISM = 1;
export const DEFAULT_BUILDER_TIMEOUT_MINUTES = 30;
export const MAX_BUILDER_PARALLELISM = 16;
export const MAX_BUILDER_TIMEOUT_MINUTES = 360;

export function readBuilderNodeSettings(metadata: unknown): { parallelism: number; timeoutMinutes: number } {
  const record = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const settings =
    record.builderSettings && typeof record.builderSettings === 'object'
      ? (record.builderSettings as Record<string, unknown>)
      : {};
  const parallelism = Number(settings.parallelism);
  const timeoutMinutes = Number(settings.timeoutMinutes);
  return {
    parallelism:
      Number.isSafeInteger(parallelism) && parallelism >= 1 && parallelism <= MAX_BUILDER_PARALLELISM
        ? parallelism
        : DEFAULT_BUILDER_PARALLELISM,
    timeoutMinutes:
      Number.isSafeInteger(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= MAX_BUILDER_TIMEOUT_MINUTES
        ? timeoutMinutes
        : DEFAULT_BUILDER_TIMEOUT_MINUTES,
  };
}

export function assertSupportedDockerBuildResourcePolicy(policy: Record<string, unknown>): void {
  for (const [key, expected] of [
    ['cpuLimitMillis', ENFORCED_BUILD_CPU_LIMIT_MILLIS],
    ['memoryLimitBytes', ENFORCED_BUILD_MEMORY_LIMIT_BYTES],
    ['diskLimitBytes', ENFORCED_BUILD_DISK_LIMIT_BYTES],
  ] as const) {
    if (policy[key] !== undefined && Number(policy[key]) !== expected) {
      throw new AppError(
        409,
        'UNSUPPORTED_BUILD_RESOURCE_PROFILE',
        `Build policy ${key} must use the enforced worker profile value ${expected}`
      );
    }
  }
}

export function parseDockerBuildProgress(value: string): { progress?: Record<string, unknown> } {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { progress: parsed as Record<string, unknown> }
      : {};
  } catch {
    return {};
  }
}

export function parseDockerBuildScanSummary(value: string): DockerBuildScanSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const count = (key: string) => {
      const numeric = Number(parsed[key] ?? 0);
      return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
    };
    const text = (record: Record<string, unknown>, key: string) =>
      typeof record[key] === 'string' ? record[key].slice(0, 512) : '';
    const vulnerabilities = Array.isArray(parsed.vulnerabilities)
      ? parsed.vulnerabilities.slice(0, 100).flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const record = entry as Record<string, unknown>;
          const id = text(record, 'id');
          if (!id) return [];
          return [
            {
              id,
              severity: text(record, 'severity') || 'unknown',
              packageName: text(record, 'packageName'),
              installedVersion: text(record, 'installedVersion'),
              packageType: text(record, 'packageType'),
              fixedVersions: Array.isArray(record.fixedVersions)
                ? record.fixedVersions
                    .filter((item): item is string => typeof item === 'string')
                    .slice(0, 5)
                    .map((item) => item.slice(0, 512))
                : [],
              fixState: text(record, 'fixState'),
              namespace: text(record, 'namespace'),
              dataSource: text(record, 'dataSource'),
            },
          ];
        })
      : [];
    return {
      scanner: typeof parsed.scanner === 'string' ? parsed.scanner : 'grype',
      critical: count('critical'),
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
      unknown: count('unknown') + count('negligible'),
      vulnerabilities,
      vulnerabilitiesTruncated: count('vulnerabilitiesTruncated'),
    };
  } catch {
    return null;
  }
}

export function canTransitionDockerBuild(from: DockerBuildStatus, to: DockerBuildStatus): boolean {
  return BUILD_TRANSITIONS[from].includes(to);
}

export function redactDockerBuildLog(
  content: string,
  options: { secretValues?: readonly string[]; secretNames?: readonly string[] } = {}
): string {
  let redacted = content;
  for (const secret of options.secretValues ?? []) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  redacted = redacted.replace(/(https?:\/\/[^\s/:]+:)[^@\s]+@/gi, '$1[REDACTED]@');
  for (const name of options.secretNames ?? []) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(`(${escaped}\\s*[=:]\\s*)[^\\s]+`, 'gi'), '$1[REDACTED]');
  }
  return redacted;
}

export function expiredDockerBuildDisposition(input: {
  attempt: number;
  maxAttempts: number;
  cancellationRequestedAt: Date | null;
}): 'retry' | 'cancelled' | 'failed' {
  if (input.cancellationRequestedAt) return 'cancelled';
  return input.attempt < input.maxAttempts ? 'retry' : 'failed';
}

export function evaluateDockerArtifactPolicy(
  policy: DockerBuildPolicySnapshot,
  artifact: {
    sbomDigest?: string | null;
    provenanceDigest?: string | null;
    scanSummary?: DockerBuildScanSummary | null;
  }
): { decision: DockerArtifactPolicyDecision; reason: string | null } {
  const threshold = policy.vulnerabilityThreshold ?? 'critical';
  if (threshold === 'none') return { decision: 'approved', reason: null };
  if (!artifact.scanSummary) {
    return { decision: 'error', reason: 'Vulnerability scan result is required' };
  }
  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const thresholdIndex = severities.indexOf(threshold as (typeof severities)[number]);
  const violations = severities
    .slice(0, thresholdIndex + 1)
    .filter((severity) => Number(artifact.scanSummary?.[severity] ?? 0) > 0);
  return violations.length > 0
    ? { decision: 'rejected', reason: `Vulnerabilities at or above ${threshold}: ${violations.join(', ')}` }
    : { decision: 'approved', reason: null };
}
