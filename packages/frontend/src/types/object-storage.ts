// Object Storage
export type ObjectStorageProvider =
  | "aws"
  | "cloudflare_r2"
  | "minio"
  | "other"
  | "ftp"
  | "ftps"
  | "sftp";

/** Providers reached over a file protocol rather than the S3 API. */
export const FILE_PROTOCOL_PROVIDERS = ["ftp", "ftps", "sftp"] as const;

export function isFileProtocolProvider(provider: ObjectStorageProvider): boolean {
  return (FILE_PROTOCOL_PROVIDERS as readonly string[]).includes(provider);
}
export type ObjectStorageHealthStatus = "online" | "offline" | "degraded" | "unknown";
export type ManagedObjectStorageStatus =
  | "creating"
  | "updating"
  | "ready"
  | "stopped"
  | "error"
  | "deleting";

export interface ObjectStorageHealthEntry {
  ts: string;
  status: ObjectStorageHealthStatus;
  responseMs?: number;
  slow?: boolean;
}

export interface ManagedObjectStorageCatalogEntry {
  type: "minio";
  versions: string[];
}

/** An object storage service provisioned on a dedicated Gateway object-storage node. Credentials are never returned here. */
export interface ManagedObjectStorage {
  id: string;
  name: string;
  slug: string;
  nodeId: string;
  version: string;
  storageSizeBytes: number;
  publishS3?: boolean;
  publishedPort: number;
  sftpEnabled: boolean;
  sftpPort: number | null;
  ftpEnabled: boolean;
  ftpPort: number | null;
  ftpPassivePortStart: number | null;
  ftpPassivePortCount: number | null;
  status: ManagedObjectStorageStatus;
  lastError: string | null;
  objectStorageConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedObjectStorageCreateInput {
  memberNodeIds?: string[];
  drivesPerNode?: number;
  relayEnabled?: boolean;
  name: string;
  version: string;
  nodeId: string;
  storageSizeGb: number;
  cpuCores: number;
  memoryMb: number;
  swapMb: number;
  publishS3?: boolean;
  publishedPort: number;
  tags?: string[];
  accessKey?: string;
  secretKey?: string;
  tlsEnabled?: boolean;
  sftpEnabled?: boolean;
  sftpPort?: number;
  ftpEnabled?: boolean;
  ftpPort?: number;
  ftpPassivePortStart?: number;
  ftpPassivePortCount?: number;
}

/** The access level an IAM key's inline policy grants — `null` only for keys created before this field existed. */
export type ManagedStorageAccessKeyAccess = "read-only" | "read-write";

/** A managed storage IAM (MinIO) access key, as listed — never carries a secret. */
export interface ManagedStorageAccessKey {
  accessKeyId: string;
  name: string | null;
  /** `null` for keys created before access-level tracking existed; treat as "read-write" (MinIO's prior default). */
  access: ManagedStorageAccessKeyAccess | null;
  /** Bucket names this key is scoped to; empty means "all buckets". */
  buckets: string[];
  /** ISO-8601 expiration; `null` means the key never expires. */
  expiresAt: string | null;
  createdAt: string;
}

/** The one-time response from creating a managed storage IAM access key — carries the secret exactly once. */
export interface ManagedStorageAccessKeyCreated {
  accessKeyId: string;
  secretKey: string;
  name: string | null;
  createdAt: string;
}

/** Body for creating a managed storage IAM access key. `buckets` omitted/empty scopes to all buckets. */
export interface ManagedStorageAccessKeyCreateInput {
  name?: string;
  access?: ManagedStorageAccessKeyAccess;
  buckets?: string[];
  /** ISO-8601 expiration; omitted means the key never expires. */
  expiresAt?: string;
}

export interface ObjectStorageConfig {
  secretAccessKey: string | null;
  sessionToken: string | null;
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
  caPem: string | null;
}

export interface ObjectStorageConnection {
  hostKeyFingerprint?: string | null;
  id: string;
  slug: string;
  name: string;
  provider: ObjectStorageProvider;
  origin: "user" | "managed";
  description: string | null;
  tags: string[];
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  defaultBucket: string | null;
  forcePathStyle: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  basePath: string | null;
  implicitTls: boolean;
  healthStatus: ObjectStorageHealthStatus;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  healthHistory?: ObjectStorageHealthEntry[];
  folderId?: string | null;
  sortOrder?: number;
  hasStoredSecret: boolean;
  hasStoredSessionToken: boolean;
  hasStoredPassword: boolean;
  hasStoredPrivateKey: boolean;
  hasStoredCaPem: boolean;
  config: ObjectStorageConfig;
  managed?: {
    id: string;
    nodeId: string;
    version: string;
    storageSizeBytes: number;
    runtimeConfig: { cpuCores: number; memoryMb: number; swapMb: number };
    publishS3?: boolean;
    publishedPort: number;
    status: ManagedObjectStorageStatus;
    lastError: string | null;
  };
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectStorageMetricSnapshot {
  timestamp: string;
  storageId: string;
  provider: ObjectStorageProvider;
  name: string;
  status: ObjectStorageHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}

export interface ObjectStorageBucket {
  name: string;
  creationDate: string | null;
}

export interface ObjectStorageObject {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface ObjectStorageListing {
  prefixes: string[];
  objects: ObjectStorageObject[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

export interface ObjectStorageObjectMetadata {
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  etag: string | null;
  metadata: Record<string, string>;
}

export interface ObjectStoragePresignResult {
  url: string;
  expiresIn: number;
}

export interface ObjectStorageRevealedCredentials {
  provider: ObjectStorageProvider;
  endpoint?: string | null;
  region?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sessionToken?: string | null;
  forcePathStyle?: boolean;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  caPem?: string | null;
  basePath?: string | null;
  implicitTls?: boolean;
  defaultBucket: string | null;
}

export type ManagedStorageBindingTargetType = "container" | "deployment";
export type ManagedStorageBindingStatus = "creating" | "ready" | "error" | "deleting";

/** Environment variable names a binding writes into its target workload. */
export interface ManagedStorageBindingEnvironment {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  region?: string;
}

export interface ManagedStorageBinding {
  id: string;
  clusterId: string;
  targetNodeId: string;
  targetType: ManagedStorageBindingTargetType;
  targetResourceId: string;
  connectorAlias: string;
  environment: ManagedStorageBindingEnvironment;
  buckets: string[];
  accessKeyId: string | null;
  status: ManagedStorageBindingStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedStorageBindingCreateInput {
  targetNodeId: string;
  targetType: ManagedStorageBindingTargetType;
  targetResourceId: string;
  environment: ManagedStorageBindingEnvironment;
  buckets: string[];
  targetEnvironment?: Record<string, string>;
}

export interface ManagedStorageBindingDeleteInput {
  targetEnvironment?: Record<string, string>;
}
