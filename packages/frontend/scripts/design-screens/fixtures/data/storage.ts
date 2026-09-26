/**
 * Object storage of the fictional installation: the catalog `assets` bucket on
 * S3 and the managed `backups` cluster on storage-1, plus a few external
 * connections with one needing attention.
 */
import type {
  ManagedObjectStorage,
  ManagedObjectStorageCatalogEntry,
  ObjectStorageConfig,
  ObjectStorageConnection,
  ResourceFolderTreeNode,
} from "@/types";
import { people, storages as catalogStorages } from "../catalog";
import { nodeBySlug } from "../nodes";
import { ago, uuid } from "../time";

const GiB = 1024 ** 3;

const storageNode = nodeBySlug("storage-1")!;
const [assetsCatalog, backupsCatalog] = catalogStorages;

const noSecrets: ObjectStorageConfig = {
  secretAccessKey: null,
  sessionToken: null,
  password: null,
  privateKey: null,
  passphrase: null,
  caPem: null,
};

const mediaFolderId = uuid(4101);

export const storageFolders: ResourceFolderTreeNode[] = [
  {
    id: mediaFolderId,
    name: "Media",
    parentId: null,
    sortOrder: 0,
    depth: 0,
    createdAt: ago(150, "d"),
    updatedAt: ago(20, "d"),
    children: [],
  },
];

function storage(
  overrides: Partial<ObjectStorageConnection> &
    Pick<ObjectStorageConnection, "id" | "slug" | "name" | "provider">
): ObjectStorageConnection {
  return {
    origin: "user",
    description: null,
    tags: [],
    endpoint: null,
    region: null,
    accessKeyId: "AKIAEXAMPLE0NORTHWIND",
    defaultBucket: null,
    forcePathStyle: false,
    host: null,
    port: null,
    username: null,
    basePath: null,
    implicitTls: false,
    healthStatus: "online",
    lastHealthCheckAt: ago(50, "s"),
    lastError: null,
    folderId: null,
    sortOrder: 0,
    hasStoredSecret: true,
    hasStoredSessionToken: false,
    hasStoredPassword: false,
    hasStoredPrivateKey: false,
    hasStoredCaPem: false,
    config: noSecrets,
    createdById: people[0].id,
    updatedById: people[2].id,
    createdAt: ago(170, "d"),
    updatedAt: ago(6, "d"),
    ...overrides,
  };
}

export const assetsStorage = storage({
  id: assetsCatalog.id,
  slug: assetsCatalog.slug,
  name: assetsCatalog.name,
  provider: "aws",
  description: "Product images and static assets served through app.example.com.",
  tags: ["green:production", "blue:cdn"],
  region: "eu-central-1",
  defaultBucket: "northwind-assets",
  folderId: mediaFolderId,
  sortOrder: 0,
  lastHealthCheckAt: ago(40, "s"),
});

export const backupsStorage = storage({
  id: backupsCatalog.id,
  slug: backupsCatalog.slug,
  name: backupsCatalog.name,
  provider: "seaweedfs",
  origin: "managed",
  description: "Nightly database and volume backups.",
  tags: ["green:production", "backups"],
  endpoint: "https://198.51.100.16:9000",
  defaultBucket: "db-backups",
  forcePathStyle: true,
  accessKeyId: "gw-backups-admin",
  sortOrder: 0,
  lastHealthCheckAt: ago(20, "s"),
  managed: {
    id: uuid(4111),
    nodeId: storageNode.id,
    engine: "seaweedfs",
    version: "4.47",
    storageSizeBytes: 500 * GiB,
    runtimeConfig: { cpuCores: 2, memoryMb: 2048, swapMb: 0 },
    publishS3: true,
    publishedPort: 9000,
    status: "ready",
    lastError: null,
  },
});

export const mediaStorage = storage({
  id: uuid(4103),
  slug: "user-uploads",
  name: "user-uploads",
  provider: "cloudflare_r2",
  description: "Customer uploads (avatars, attachments).",
  tags: ["green:production", "pii"],
  endpoint: "https://r2.example.net",
  region: "auto",
  defaultBucket: "uploads",
  folderId: mediaFolderId,
  sortOrder: 1,
  lastHealthCheckAt: ago(1, "m"),
});

export const logsStorage = storage({
  id: uuid(4104),
  slug: "logs-archive",
  name: "logs-archive",
  provider: "minio",
  description: "Cold archive for access logs older than 30 days.",
  tags: ["gray:archive", "logs"],
  endpoint: "https://minio.example.com",
  defaultBucket: "access-logs",
  forcePathStyle: true,
  sortOrder: 1,
  healthStatus: "degraded",
  lastHealthCheckAt: ago(2, "m"),
  lastError: "ListBuckets took 2 410 ms (slow threshold 1 500 ms)",
});

export const partnerStorage = storage({
  id: uuid(4105),
  slug: "partner-exports",
  name: "partner-exports",
  provider: "sftp",
  description: "Daily order exports picked up by the fulfilment partner.",
  tags: ["orange:external"],
  accessKeyId: null,
  host: "sftp.example.org",
  port: 22,
  username: "northwind",
  basePath: "/incoming/orders",
  hasStoredSecret: false,
  hasStoredPrivateKey: true,
  sortOrder: 2,
  healthStatus: "offline",
  lastHealthCheckAt: ago(5, "m"),
  lastError: "ssh: handshake failed: connection reset by 192.0.2.44:22",
});

export const storageRows: ObjectStorageConnection[] = [
  backupsStorage,
  logsStorage,
  partnerStorage,
  assetsStorage,
  mediaStorage,
];

export const managedStorages: ManagedObjectStorage[] = [
  {
    id: backupsStorage.managed!.id,
    name: backupsStorage.name,
    slug: backupsStorage.slug,
    nodeId: storageNode.id,
    engine: "seaweedfs",
    version: "4.47",
    storageSizeBytes: 500 * GiB,
    publishS3: true,
    publishedPort: 9000,
    sftpEnabled: false,
    sftpPort: null,
    ftpEnabled: false,
    ftpPort: null,
    ftpPassivePortStart: null,
    ftpPassivePortCount: null,
    status: "ready",
    lastError: null,
    objectStorageConnectionId: backupsStorage.id,
    createdAt: backupsStorage.createdAt,
    updatedAt: backupsStorage.updatedAt,
  },
];

export const managedStorageCatalog: ManagedObjectStorageCatalogEntry[] = [
  { type: "seaweedfs", versions: ["4.47", "4.41"] },
  { type: "minio", versions: ["2025-04-22"] },
];
