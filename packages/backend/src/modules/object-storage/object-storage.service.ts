import type { Readable } from 'node:stream';
import type { DrizzleClient } from '@/db/client.js';
import type { ObjectStorageHealthEntry } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { StorageBackupTargetConfig } from '@/modules/backups/backups.types.js';
import type { StorageBackupHistoryOptions } from '@/modules/object-storage/storage-backup-references.js';
import type { ManagedStorageTunnelProxy } from '@/modules/storage/managed-storage-tunnel-proxy.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
import type { PaginatedResponse } from '@/types.js';
import type {
  CreateObjectStorageConnectionInput,
  ObjectStorageListQuery,
  PresignObjectInput,
  UpdateObjectStorageConnectionInput,
} from './object-storage.schemas.js';
import type {
  ObjectStorageConnectionView,
  ObjectStorageHealthStatus,
  StorageConnectionConfig,
} from './object-storage-connection-view.js';
import type { S3ObjectListing, S3ObjectMetadata, StorageBackendFactory } from './storage-backend.js';

export type {
  ObjectStorageConnectionView,
  ObjectStorageHealthStatus,
  S3ConnectionConfig,
} from './object-storage-connection-view.js';
export class ObjectStorageService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable constructor contract for the private implementation.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _storageCA?: StorageCAService,
    _tunnelProxy?: ManagedStorageTunnelProxy
  ) {}
  setEventBus(_bus: EventBusService): void {}
  setBackendFactory(_factory: StorageBackendFactory): void {}
  async list(
    _query: ObjectStorageListQuery,
    _options?: {
      allowedIds?: string[];
    }
  ): Promise<PaginatedResponse<ObjectStorageConnectionView>> {
    return commercialModuleUnavailable();
  }
  async get(_id: string, _revealCredentials?: boolean): Promise<ObjectStorageConnectionView> {
    return commercialModuleUnavailable();
  }
  async getBySlug(_slug: string): Promise<ObjectStorageConnectionView> {
    return commercialModuleUnavailable();
  }
  async getHealthHistory(_id: string): Promise<ObjectStorageHealthEntry[]> {
    return commercialModuleUnavailable();
  }
  async revealCredentials(_id: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async create(_input: CreateObjectStorageConnectionInput, _userId: string): Promise<ObjectStorageConnectionView> {
    return commercialModuleUnavailable();
  }
  async update(
    _id: string,
    _input: UpdateObjectStorageConnectionInput,
    _userId: string
  ): Promise<ObjectStorageConnectionView> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string, _userId: string, _options?: StorageBackupHistoryOptions): Promise<void> {
    return commercialModuleUnavailable();
  }
  async testSavedConnection(
    _id: string,
    _userId: string
  ): Promise<{
    ok: true;
    responseMs: number;
    status: ObjectStorageHealthStatus;
  }> {
    return commercialModuleUnavailable();
  }
  async listBuckets(_id: string): Promise<import('./storage-backend.js').S3BucketInfo[]> {
    return commercialModuleUnavailable();
  }
  async createBucket(_id: string, _bucket: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteBucket(_id: string, _bucket: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async listObjects(
    _id: string,
    _params: {
      bucket: string;
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
      maxKeys?: number;
    }
  ): Promise<S3ObjectListing> {
    return commercialModuleUnavailable();
  }
  async headObject(_id: string, _bucket: string, _key: string): Promise<S3ObjectMetadata> {
    return commercialModuleUnavailable();
  }
  async presignObject(
    _id: string,
    _input: PresignObjectInput
  ): Promise<{
    url: string;
    expiresIn: number;
  }> {
    return commercialModuleUnavailable();
  }
  async uploadObject(
    _id: string,
    _params: {
      bucket: string;
      key: string;
      body: Buffer | Uint8Array | Readable;
      contentType?: string;
    },
    _userId: string
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getObjectStream(
    _id: string,
    _bucket: string,
    _key: string
  ): Promise<import('./storage-backend.js').ObjectStreamResult> {
    return commercialModuleUnavailable();
  }
  async createPrefix(_id: string, _bucket: string, _prefix: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteBackupArtifacts(_id: string, _bucket: string, _keys: string[]): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteObjects(_id: string, _bucket: string, _keys: string[], _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async listAllRows(): Promise<
    {
      id: string;
      name: string;
      slug: string;
      provider: 'aws' | 'cloudflare_r2' | 'minio' | 'other' | 'ftp' | 'ftps' | 'sftp';
      origin: 'user' | 'managed';
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
      encryptedConfig: string;
      healthStatus: 'online' | 'offline' | 'degraded' | 'unknown';
      lastHealthCheckAt: Date | null;
      lastError: string | null;
      healthHistory: ObjectStorageHealthEntry[];
      folderId: string | null;
      sortOrder: number;
      createdById: string;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async getDecryptedConfig(_id: string): Promise<StorageConnectionConfig> {
    return commercialModuleUnavailable();
  }
  async updateHealth(
    _id: string,
    _patch: {
      status: ObjectStorageHealthStatus;
      responseMs?: number;
      lastError?: string | null;
      forceHistory?: boolean;
    }
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  disposeClient(_id: string): void {}
  shutdown(): void {}
  async getBackupTarget(_id: string): Promise<StorageBackupTargetConfig> {
    return commercialModuleUnavailable();
  }
}
