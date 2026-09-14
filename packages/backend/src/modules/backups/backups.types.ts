import type { BackupDirection, BackupEngine, BackupManifest, BackupRunStatus } from '@/db/schema/backups.js';

export interface BackupLimits {
  workspaceBytes: number;
  timeoutSeconds: number;
  cpuCores: number;
  memoryMb: number;
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
  /** Restore never overwrites an existing nonempty target. */
  overwrite?: false;
  limits?: Partial<BackupLimits>;
}

export interface BackupRunView {
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
  direction: BackupDirection;
  engine: BackupEngine;
  status: BackupRunStatus;
  phase: string;
  bytes: string;
  manifest: BackupManifest | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  artifactsDeletedAt: Date | null;
  createdAt: Date;
}

export interface BackupRuntimeConnection {
  connectionId: string;
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  tls?: boolean;
  caPem?: string;
  serverName?: string;
  relayRouteId?: string;
  managedDatabaseId?: string;
}

export interface BackupDestination extends BackupRuntimeConnection {
  provider: 's3' | 'ftp' | 'ftps' | 'sftp';
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  privateKey?: string;
  passphrase?: string;
  hostKeyFingerprint?: string;
  basePath?: string;
  implicitTls?: boolean;
  forcePathStyle?: boolean;
  relayRouteId?: string;
}

/** Structural view of ObjectStorageService.getBackupTarget; central storage owns the concrete type. */
export interface StorageBackupTargetConfig {
  connectionId: string;
  provider: 'aws' | 'cloudflare_r2' | 'minio' | 'other' | 'ftp' | 'ftps' | 'sftp';
  endpoint?: string;
  host?: string;
  port?: number;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  caPem?: string;
  hostKeyFingerprint?: string;
  basePath?: string;
  implicitTls?: boolean;
  forcePathStyle?: boolean;
  managedClusterId?: string;
  managedNodeId?: string;
}

export interface BackupRuntimePayload {
  runId: string;
  version: 1;
  direction: BackupDirection;
  engine: BackupEngine;
  source?: BackupRuntimeConnection;
  destination: BackupDestination;
  staging?: BackupDestination;
  restoreTarget?: BackupRuntimeConnection & { newManagedDatabaseName?: string };
  limits: BackupLimits;
  toolImage: string;
  redisStageImage?: string;
  /** Server-approved executor address reachable from an external Redis target. */
  redisStageAdvertiseHost?: string;
  restoreArtifact?: BackupManifest;
}
