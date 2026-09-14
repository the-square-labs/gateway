export type BackupEngine = "postgres" | "redis" | "clickhouse";
export type BackupRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackupLimits {
  workspaceBytes: number;
  timeoutSeconds: number;
  cpuCores: number;
  memoryMb: number;
}

export interface BackupPolicy {
  id: string;
  databaseConnectionId: string;
  destinationId: string;
  bucket: string;
  prefix: string;
  stagingStorageConnectionId: string | null;
  stagingBucket: string | null;
  executorNodeId: string;
  schedule: string | null;
  timezone: string;
  retentionCount: number;
  limits: BackupLimits;
  enabled: boolean;
}

export interface BackupManifest {
  engine: BackupEngine;
  version: 1;
  sourceIdentity: string;
  sourceDatabase?: string;
  artifactKeys: string[];
  sizes: Record<string, number>;
  engineVersion: string;
  fileChecksums: Record<string, string>;
  manifestSha256: string;
  ownedPrefix: string;
  nativeStagePrefix?: string;
}

export interface BackupRun {
  id: string;
  policyId: string | null;
  databaseConnectionId: string;
  destinationId: string;
  destinationBucket: string;
  destinationPrefix: string;
  stagingStorageConnectionId: string | null;
  stagingBucket: string | null;
  timezone: string;
  executorNodeId: string;
  direction: "backup" | "restore";
  engine: BackupEngine;
  status: BackupRunStatus;
  phase: string;
  bytes: string;
  manifest: BackupManifest | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  artifactsDeletedAt: string | null;
  createdAt: string;
}

export interface BackupPolicyInput {
  destinationId: string;
  bucket: string;
  prefix: string;
  stagingStorageConnectionId?: string | null;
  stagingBucket?: string | null;
  executorNodeId: string;
  schedule?: string | null;
  timezone: string;
  retentionCount: number;
  limits: BackupLimits;
  enabled?: boolean;
}

export interface BackupRestoreInput {
  executorNodeId: string;
  newManagedDatabaseName?: string;
  restoreTargetConnectionId?: string;
  overwrite?: false;
  limits?: Partial<BackupLimits>;
}
