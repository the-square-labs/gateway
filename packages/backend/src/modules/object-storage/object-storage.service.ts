import { Agent } from 'node:https';
import type { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { asc, count, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type ManagedStorageClusterRow,
  managedStorageClusters,
  type ObjectStorageHealthEntry,
  objectStorageConnections,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { StorageBackupTargetConfig } from '@/modules/backups/backups.types.js';
import type { ManagedStorageTunnelProxy } from '@/modules/storage/managed-storage-tunnel-proxy.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
import type { PaginatedResponse } from '@/types.js';
import { FtpStorageBackend } from './ftp-storage-backend.js';
import type {
  CreateObjectStorageConnectionInput,
  ObjectStorageListQuery,
  PresignObjectInput,
  StorageProvider,
  UpdateObjectStorageConnectionInput,
} from './object-storage.schemas.js';
import {
  type FileProtocolConnectionConfig,
  isFileProtocolConfig,
  type ObjectStorageConnectionView,
  type ObjectStorageHealthStatus,
  type S3ConnectionConfig,
  type StorageConnectionConfig,
  type StoredSecretConfig,
  toObjectStorageConnectionView,
} from './object-storage-connection-view.js';
import { isStorageWarmupError, mapObjectStorageError } from './object-storage-error-mapping.js';
import {
  type FileProtocolProvider,
  isFileProtocolProvider,
  resolveFileProtocolPort,
} from './object-storage-protocol.js';
import type { S3ObjectListing, S3ObjectMetadata } from './s3-object-operations.js';
import { S3StorageBackend } from './s3-storage-backend.js';
import { SftpStorageBackend } from './sftp-storage-backend.js';
import type { StorageBackend } from './storage-backend.js';
import { assertStorageHasNoBackupReferences } from './storage-backup-references.js';

export type {
  ObjectStorageConnectionView,
  ObjectStorageHealthStatus,
  S3ConnectionConfig,
} from './object-storage-connection-view.js';

const STORAGE_HEALTH_HISTORY_MIN_INTERVAL_MS = 30_000;
const SLOW_THRESHOLD_MS = 2_000;
// Bounded so a genuinely unreachable cluster still fails fast; a warming MinIO
// starts accepting within a second or so.
const STORAGE_WARMUP_RETRIES = 3;
const STORAGE_WARMUP_RETRY_DELAY_MS = 400;

/** Providers that cannot resolve an endpoint from region alone and require an explicit one. */
const ENDPOINT_REQUIRED_PROVIDERS: ReadonlySet<StorageProvider> = new Set(['minio', 'cloudflare_r2', 'other']);

export type NormalizeS3ConfigInput = Partial<{
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
  defaultBucket: string | null;
  forcePathStyle: boolean;
}>;

/**
 * Merge incoming config over the current stored config and validate required fields.
 * The secret is preserved when the caller omits it (undefined or empty string), so a
 * masked view is never round-tripped back into storage. Pure and unit-testable.
 */
export function normalizeS3Config(
  provider: StorageProvider,
  input: NormalizeS3ConfigInput,
  current: S3ConnectionConfig | null
): S3ConnectionConfig {
  const secretAccessKey =
    input.secretAccessKey !== undefined && input.secretAccessKey !== ''
      ? input.secretAccessKey
      : current?.secretAccessKey;
  if (!secretAccessKey) {
    throw new AppError(400, 'STORAGE_SECRET_REQUIRED', 'secretAccessKey is required');
  }
  const region = input.region ?? current?.region;
  const accessKeyId = input.accessKeyId ?? current?.accessKeyId;
  if (!region) throw new AppError(400, 'STORAGE_REGION_REQUIRED', 'region is required');
  if (!accessKeyId) throw new AppError(400, 'STORAGE_ACCESS_KEY_REQUIRED', 'accessKeyId is required');

  const endpoint = input.endpoint !== undefined ? input.endpoint || null : (current?.endpoint ?? null);
  const forcePathStyle =
    input.forcePathStyle !== undefined ? input.forcePathStyle : (current?.forcePathStyle ?? provider === 'minio');
  const defaultBucket =
    input.defaultBucket !== undefined ? input.defaultBucket || null : (current?.defaultBucket ?? null);
  const sessionToken = input.sessionToken !== undefined ? input.sessionToken || null : (current?.sessionToken ?? null);

  if (ENDPOINT_REQUIRED_PROVIDERS.has(provider) && !endpoint) {
    throw new AppError(400, 'STORAGE_ENDPOINT_REQUIRED', 'endpoint is required for this provider');
  }

  return { provider, endpoint, region, accessKeyId, secretAccessKey, sessionToken, defaultBucket, forcePathStyle };
}

export type NormalizeFileProtocolConfigInput = Partial<{
  hostKeyFingerprint: string;
  host: string;
  port: number | null;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  caPem: string | null;
  basePath: string | null;
  implicitTls: boolean;
  defaultBucket: string | null;
}>;

/**
 * Merge incoming file-protocol config over the stored one and validate it.
 *
 * Secrets follow the same rule as S3: omitted (undefined or empty) means "keep
 * what is stored", so a masked view never round-trips back into storage.
 * Supplying a private key clears any stored password and vice versa — the two
 * are alternative auth methods, and keeping a stale one around would leave a
 * credential nobody expects to still be live.
 */
export function normalizeFileProtocolConfig(
  provider: FileProtocolProvider,
  input: NormalizeFileProtocolConfigInput,
  current: FileProtocolConnectionConfig | null
): FileProtocolConnectionConfig {
  const host = input.host ?? current?.host;
  if (!host) throw new AppError(400, 'STORAGE_HOST_REQUIRED', 'host is required');

  const username = input.username ?? current?.username ?? '';
  const implicitTls = input.implicitTls ?? current?.implicitTls ?? false;
  const port = resolveFileProtocolPort(provider, input.port ?? current?.port ?? null, implicitTls);

  const suppliedPassword = input.password !== undefined && input.password !== '' ? input.password : undefined;
  const suppliedPrivateKey = input.privateKey !== undefined && input.privateKey !== '' ? input.privateKey : undefined;
  const switchedAuthMethod = suppliedPassword !== undefined || suppliedPrivateKey !== undefined;

  const password = switchedAuthMethod ? (suppliedPassword ?? null) : (current?.password ?? null);
  const privateKey = switchedAuthMethod ? (suppliedPrivateKey ?? null) : (current?.privateKey ?? null);
  const passphrase =
    input.passphrase !== undefined && input.passphrase !== '' ? input.passphrase : (current?.passphrase ?? null);

  if (provider === 'sftp' && !password && !privateKey) {
    throw new AppError(400, 'STORAGE_SECRET_REQUIRED', 'SFTP requires either a password or a private key');
  }

  return {
    provider,
    host,
    port,
    username,
    password,
    privateKey,
    // A passphrase without a key protects nothing and would only confuse a
    // later reveal, so it is dropped along with the key it belonged to.
    passphrase: privateKey ? passphrase : null,
    hostKeyFingerprint: input.hostKeyFingerprint ?? current?.hostKeyFingerprint ?? null,
    caPem: input.caPem !== undefined ? input.caPem || null : (current?.caPem ?? null),
    basePath: input.basePath !== undefined ? input.basePath || null : (current?.basePath ?? null),
    implicitTls,
    defaultBucket: input.defaultBucket !== undefined ? input.defaultBucket || null : (current?.defaultBucket ?? null),
  };
}

/**
 * Builds an https.Agent that trusts the given CA pem for TLS verification.
 * Used exclusively for managed-storage connections talking to the internal
 * Storage CA — external S3/MinIO connections never go through this and keep
 * using the system trust store. Verification stays fully on: this narrows
 * the trust anchor, it never disables it (never `rejectUnauthorized: false`).
 */
export function buildInternalCaHttpsAgent(caPem: string): Agent {
  return new Agent({ ca: caPem, keepAlive: true });
}

export class ObjectStorageService {
  private eventBus?: EventBusService;
  private readonly clients = new Map<string, StorageBackend>();
  private storageCaPemPromise?: Promise<string | null>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly storageCA?: StorageCAService,
    // Optional/defaulted (undefined = today's behavior: no relay resolution,
    // `getClient` always uses the persisted endpoint) so existing call sites
    // keep compiling untouched. `bootstrap.ts` wires in the one shared
    // instance also used by `ManagedStorageService`'s create/delete relay
    // dispatch.
    private readonly tunnelProxy?: ManagedStorageTunnelProxy
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  async list(
    query: ObjectStorageListQuery,
    options?: { allowedIds?: string[] }
  ): Promise<PaginatedResponse<ObjectStorageConnectionView>> {
    const conditions: (SQL | undefined)[] = [];
    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return { data: [], pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 } };
      }
      conditions.push(inArray(objectStorageConnections.id, options.allowedIds));
    }
    if (query.search) {
      conditions.push(
        or(
          ilike(objectStorageConnections.name, `%${query.search}%`),
          ilike(objectStorageConnections.endpoint, `%${query.search}%`),
          ilike(objectStorageConnections.defaultBucket, `%${query.search}%`)
        )
      );
    }
    if (query.provider) conditions.push(eq(objectStorageConnections.provider, query.provider));
    if (query.healthStatus) conditions.push(eq(objectStorageConnections.healthStatus, query.healthStatus));

    const where = buildWhere(conditions);
    const [rows, [{ count: totalCount }]] = await Promise.all([
      this.db
        .select()
        .from(objectStorageConnections)
        .where(where)
        .orderBy(
          asc(objectStorageConnections.sortOrder),
          asc(objectStorageConnections.name),
          asc(objectStorageConnections.id)
        )
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ count: count() }).from(objectStorageConnections).where(where),
    ]);

    const connectionIds = rows.map((row) => row.id);
    const clusterRows = connectionIds.length
      ? await this.db
          .select()
          .from(managedStorageClusters)
          .where(inArray(managedStorageClusters.objectStorageConnectionId, connectionIds))
      : [];
    const clusterByConnectionId = new Map(clusterRows.map((cluster) => [cluster.objectStorageConnectionId, cluster]));

    const data = rows.map((row) =>
      toObjectStorageConnectionView(
        row,
        this.decryptSecret(row.encryptedConfig),
        false,
        false,
        clusterByConnectionId.get(row.id) ?? null
      )
    );
    const total = Number(totalCount);
    return {
      data,
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async get(id: string, revealCredentials = false): Promise<ObjectStorageConnectionView> {
    const row = await this.getRow(id);
    const managedCluster = await this.getManagedCluster(row.id);
    return toObjectStorageConnectionView(
      row,
      this.decryptSecret(row.encryptedConfig),
      revealCredentials,
      false,
      managedCluster
    );
  }

  async getBySlug(slug: string): Promise<ObjectStorageConnectionView> {
    const row = await this.db.query.objectStorageConnections.findFirst({
      where: eq(objectStorageConnections.slug, slug),
    });
    if (!row) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Object storage connection not found');
    const managedCluster = await this.getManagedCluster(row.id);
    return toObjectStorageConnectionView(row, this.decryptSecret(row.encryptedConfig), false, false, managedCluster);
  }

  async getHealthHistory(id: string): Promise<ObjectStorageHealthEntry[]> {
    const row = await this.getRow(id);
    return (row.healthHistory as ObjectStorageHealthEntry[] | null) ?? [];
  }

  async revealCredentials(id: string): Promise<Record<string, unknown>> {
    const config = await this.getDecryptedConfig(id);
    if (isFileProtocolConfig(config)) {
      return {
        provider: config.provider,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password ?? null,
        privateKey: config.privateKey ?? null,
        passphrase: config.passphrase ?? null,
        caPem: config.caPem ?? null,
        basePath: config.basePath,
        implicitTls: config.implicitTls,
        defaultBucket: config.defaultBucket,
      };
    }
    return {
      provider: config.provider,
      endpoint: config.endpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken ?? null,
      forcePathStyle: config.forcePathStyle,
      defaultBucket: config.defaultBucket,
    };
  }

  async create(input: CreateObjectStorageConnectionInput, userId: string): Promise<ObjectStorageConnectionView> {
    const config = this.normalizeConfig(input.provider, input.config, null);
    const testResult = await this.probe(config);
    const secret = this.toStoredSecret(config);
    const columns = this.toStoredColumns(config);

    const row = await writeWithAllocatedSlug({
      source: input.name,
      fallback: 'storage',
      constraint: 'object_storage_connections_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(objectStorageConnections)
          .values({
            name: input.name,
            slug,
            provider: input.provider,
            folderId: input.folderId ?? null,
            description: input.description ?? null,
            tags: input.tags ?? [],
            ...columns,
            encryptedConfig: this.encryptSecret(secret),
            healthStatus: testResult.status,
            lastHealthCheckAt: new Date(),
            lastError: testResult.status === 'offline' ? testResult.error : null,
            healthHistory: [
              {
                ts: new Date().toISOString(),
                status: testResult.status,
                responseMs: testResult.responseMs,
                slow: testResult.status === 'degraded',
              },
            ],
            createdById: userId,
            updatedById: userId,
          })
          .returning();
        return created;
      },
    });

    await this.auditService.log({
      userId,
      action: 'storage.connection.create',
      resourceType: 'object_storage',
      resourceId: row.id,
      details: { name: row.name, provider: row.provider, endpoint: row.endpoint, region: row.region },
    });
    await grantCreatedResourcePermissions(userId, 'storage', row.id);
    this.emitChange(row.id, 'created', { name: row.name, provider: row.provider, healthStatus: row.healthStatus });
    return toObjectStorageConnectionView(row, secret, false, false);
  }

  async update(
    id: string,
    input: UpdateObjectStorageConnectionInput,
    userId: string
  ): Promise<ObjectStorageConnectionView> {
    const existing = await this.getRow(id);
    if (existing.origin === 'managed') {
      throw new AppError(
        409,
        'OBJECT_STORAGE_MANAGED_READONLY',
        'Managed storage connections are managed through their cluster'
      );
    }
    const currentConfig = this.decryptConfigFromRow(existing);
    const provider = input.provider ?? existing.provider;
    const mergedConfig = this.normalizeConfig(provider, input.config ?? {}, currentConfig);

    const connectionFieldsChanged =
      JSON.stringify(this.configFingerprint(currentConfig)) !== JSON.stringify(this.configFingerprint(mergedConfig));
    let statusUpdate: Partial<typeof objectStorageConnections.$inferInsert> = {};
    if (connectionFieldsChanged) {
      const testResult = await this.probe(mergedConfig);
      statusUpdate = {
        healthStatus: testResult.status,
        lastHealthCheckAt: new Date(),
        lastError: testResult.status === 'offline' ? testResult.error : null,
      };
    }

    const secret = this.toStoredSecret(mergedConfig);
    const updateData = {
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : (input.description ?? null),
      tags: input.tags ?? (existing.tags as string[]),
      provider,
      ...this.toStoredColumns(mergedConfig),
      encryptedConfig: this.encryptSecret(secret),
      updatedById: userId,
      updatedAt: new Date(),
      ...statusUpdate,
    };
    const updateConnection = async (slug?: string) => {
      const [updated] = await this.db
        .update(objectStorageConnections)
        .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
        .where(eq(objectStorageConnections.id, id))
        .returning();
      return updated;
    };
    const row =
      input.name !== undefined && input.name !== existing.name
        ? await writeWithAllocatedSlug({
            source: input.name,
            fallback: 'storage',
            constraint: 'object_storage_connections_slug_unique',
            write: updateConnection,
          })
        : await updateConnection();

    this.disposeClient(id);

    await this.auditService.log({
      userId,
      action: 'storage.connection.update',
      resourceType: 'object_storage',
      resourceId: id,
      details: {
        name: row.name,
        provider: row.provider,
        connectionChanged: connectionFieldsChanged,
        fields: Object.keys(input),
      },
    });
    this.emitChange(id, 'updated', {
      name: row.name,
      provider: row.provider,
      healthStatus: row.healthStatus,
      ...(row.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: row.slug }),
    });
    return toObjectStorageConnectionView(row, secret, false, false);
  }

  async delete(id: string, userId: string): Promise<void> {
    const existing = await this.getRow(id);
    if (existing.origin === 'managed') {
      throw new AppError(
        409,
        'OBJECT_STORAGE_MANAGED_READONLY',
        'Managed storage connections are managed through their cluster'
      );
    }
    await assertStorageHasNoBackupReferences(this.db, id);
    await this.db.delete(objectStorageConnections).where(eq(objectStorageConnections.id, id));
    this.disposeClient(id);

    await this.auditService.log({
      userId,
      action: 'storage.connection.delete',
      resourceType: 'object_storage',
      resourceId: id,
      details: { name: existing.name, provider: existing.provider, endpoint: existing.endpoint },
    });
    this.emitChange(id, 'deleted', { name: existing.name, provider: existing.provider });
  }

  async testSavedConnection(
    id: string,
    userId: string
  ): Promise<{ ok: true; responseMs: number; status: ObjectStorageHealthStatus }> {
    const config = await this.getDecryptedConfig(id);
    const result = await this.probe(config);
    if (result.status === 'offline') {
      await this.updateHealth(id, { status: 'offline', lastError: result.error, forceHistory: true }).catch(() => {});
      throw (
        mapObjectStorageError(new Error(result.error ?? 'Storage connection test failed'), 'connect') ??
        new AppError(422, 'STORAGE_CONNECTION_FAILED', result.error ?? 'Storage connection test failed')
      );
    }
    await this.updateHealth(id, { status: result.status, responseMs: result.responseMs, lastError: null }).catch(
      () => {}
    );
    await this.auditService.log({
      userId,
      action: 'storage.connection.test',
      resourceType: 'object_storage',
      resourceId: id,
      details: { status: result.status },
    });
    return { ok: true, responseMs: result.responseMs, status: result.status };
  }

  // ── Object operations ─────────────────────────────────────────────

  async listBuckets(id: string) {
    return this.withClient(id, (backend) => backend.listBuckets());
  }

  async createBucket(id: string, bucket: string, userId: string): Promise<void> {
    await this.withClient(id, (backend) => backend.createBucket(bucket));
    await this.auditService.log({
      userId,
      action: 'storage.bucket.create',
      resourceType: 'object_storage',
      resourceId: id,
      details: { bucket },
    });
    this.emitChange(id, 'bucket.created', { bucket });
  }

  async deleteBucket(id: string, bucket: string, userId: string): Promise<void> {
    await this.withClient(id, (backend) => backend.deleteBucket(bucket));
    await this.auditService.log({
      userId,
      action: 'storage.bucket.delete',
      resourceType: 'object_storage',
      resourceId: id,
      details: { bucket },
    });
    this.emitChange(id, 'bucket.deleted', { bucket });
  }

  async listObjects(
    id: string,
    params: { bucket: string; prefix?: string; delimiter?: string; continuationToken?: string; maxKeys?: number }
  ): Promise<S3ObjectListing> {
    return this.withClient(id, (backend) => backend.listObjects(params));
  }

  async headObject(id: string, bucket: string, key: string): Promise<S3ObjectMetadata> {
    return this.withClient(id, (backend) => backend.headObject(bucket, key));
  }

  async presignObject(id: string, input: PresignObjectInput): Promise<{ url: string; expiresIn: number }> {
    const cluster = await this.getManagedCluster(id);
    if (cluster?.relayEnabled) {
      throw new AppError(
        409,
        'STORAGE_PRESIGN_UNSUPPORTED',
        'Private managed storage must be downloaded through Gateway'
      );
    }
    const url = await this.withClient(id, (backend) =>
      backend.presignObject({
        bucket: input.bucket,
        key: input.key,
        operation: input.operation,
        contentType: input.contentType,
        expiresIn: input.expiresIn,
      })
    );
    if (url === null) {
      // File protocols cannot mint capability URLs. The caller is expected to
      // fall back to /objects/download, which streams through Gateway under
      // the same scope check.
      throw new AppError(
        409,
        'STORAGE_PRESIGN_UNSUPPORTED',
        'This storage protocol does not support presigned URLs; download through Gateway instead'
      );
    }
    return { url, expiresIn: input.expiresIn };
  }

  async uploadObject(
    id: string,
    params: { bucket: string; key: string; body: Buffer | Uint8Array | Readable; contentType?: string },
    userId: string
  ): Promise<void> {
    await this.withClient(id, (backend) => backend.uploadObject(params));
    await this.auditService.log({
      userId,
      action: 'storage.object.upload',
      resourceType: 'object_storage',
      resourceId: id,
      details: { bucket: params.bucket, key: params.key },
    });
    this.emitChange(id, 'object.uploaded', { bucket: params.bucket, key: params.key });
  }

  async getObjectStream(id: string, bucket: string, key: string) {
    return this.withClient(id, (backend) => backend.getObjectStream(bucket, key));
  }

  async createPrefix(id: string, bucket: string, prefix: string, userId: string): Promise<void> {
    await this.withClient(id, (backend) => backend.createPrefix(bucket, prefix));
    await this.auditService.log({
      userId,
      action: 'storage.prefix.create',
      resourceType: 'object_storage',
      resourceId: id,
      details: { bucket, prefix },
    });
    this.emitChange(id, 'prefix.created', { bucket, prefix });
  }

  async deleteBackupArtifacts(id: string, bucket: string, keys: string[]): Promise<void> {
    await this.withClient(id, (backend) => backend.deleteObjects(bucket, keys));
  }

  async deleteObjects(id: string, bucket: string, keys: string[], userId: string): Promise<void> {
    await this.withClient(id, (backend) => backend.deleteObjects(bucket, keys));
    await this.auditService.log({
      userId,
      action: 'storage.object.delete',
      resourceType: 'object_storage',
      resourceId: id,
      details: { bucket, count: keys.length },
    });
    this.emitChange(id, 'object.deleted', { bucket, count: keys.length });
  }

  // ── Health / monitoring ───────────────────────────────────────────

  async listAllRows() {
    return this.db
      .select()
      .from(objectStorageConnections)
      .orderBy(asc(objectStorageConnections.name), asc(objectStorageConnections.id));
  }

  async getDecryptedConfig(id: string): Promise<StorageConnectionConfig> {
    const row = await this.getRow(id);
    return this.decryptConfigFromRow(row);
  }

  async updateHealth(
    id: string,
    patch: { status: ObjectStorageHealthStatus; responseMs?: number; lastError?: string | null; forceHistory?: boolean }
  ) {
    const row = await this.getRow(id);
    const now = new Date();
    const nowIso = now.toISOString();
    const existingHistory = (row.healthHistory as ObjectStorageHealthEntry[] | null) ?? [];
    const lastRecordedAt =
      existingHistory.length > 0 ? new Date(existingHistory[existingHistory.length - 1]!.ts).getTime() : 0;
    const shouldWriteHistory =
      patch.forceHistory ||
      row.healthStatus !== patch.status ||
      lastRecordedAt === 0 ||
      now.getTime() - lastRecordedAt >= STORAGE_HEALTH_HISTORY_MIN_INTERVAL_MS;

    const history = shouldWriteHistory
      ? compactHealthHistory([
          ...existingHistory,
          { ts: nowIso, status: patch.status, responseMs: patch.responseMs, slow: patch.status === 'degraded' },
        ])
      : existingHistory;

    const updatePayload: Partial<typeof objectStorageConnections.$inferInsert> = {
      healthStatus: patch.status,
      lastHealthCheckAt: now,
      lastError: patch.lastError ?? null,
      updatedAt: now,
    };
    if (shouldWriteHistory) updatePayload.healthHistory = history;

    await this.db.update(objectStorageConnections).set(updatePayload).where(eq(objectStorageConnections.id, id));
    if (shouldWriteHistory) {
      this.emitChange(id, 'health.sampled', {
        name: row.name,
        provider: row.provider,
        healthStatus: patch.status,
        sampledAt: nowIso,
      });
    }
    if (row.healthStatus !== patch.status) {
      const action =
        patch.status === 'online'
          ? 'health.online'
          : patch.status === 'degraded'
            ? 'health.degraded'
            : 'health.offline';
      this.emitChange(id, action, {
        name: row.name,
        provider: row.provider,
        healthStatus: patch.status,
        sampledAt: nowIso,
      });
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async withClient<T>(id: string, fn: (backend: StorageBackend) => Promise<T>): Promise<T> {
    // A managed cluster publishes its port before its server accepts requests,
    // so the first call after a create reliably lands in that window. Failing
    // it outright turns an ordinary startup race into a visible error, so the
    // connection-level ones are retried briefly here instead.
    for (let attempt = 0; ; attempt += 1) {
      const backend = await this.getClient(id);
      try {
        return await fn(backend);
      } catch (error) {
        this.disposeClient(id);
        if (attempt < STORAGE_WARMUP_RETRIES && isStorageWarmupError(error)) {
          await new Promise((resolve) => setTimeout(resolve, STORAGE_WARMUP_RETRY_DELAY_MS));
          continue;
        }
        throw mapObjectStorageError(error, 'object') ?? error;
      }
    }
  }

  private async getClient(id: string): Promise<StorageBackend> {
    const cached = this.clients.get(id);
    if (cached) return cached;
    const row = await this.getRow(id);
    const config = this.decryptConfigFromRow(row);
    if (isFileProtocolConfig(config)) {
      // File-protocol backends open a connection per operation, so caching them
      // only avoids re-decrypting the config — there is no live socket held.
      const backend = this.buildFileProtocolBackend(config);
      this.clients.set(id, backend);
      return backend;
    }
    // Managed clusters register their own endpoint as https only once TLS is actually
    // being served (see ManagedStorageService.create/update) — origin==='managed' +
    // an https endpoint is therefore a reliable signal that this is our own internally
    // issued Storage CA cert, not a third-party one. External S3/MinIO connections
    // (origin==='user') never take this path, https or not — they keep verifying
    // against the system trust store, unchanged.
    const isManagedTls = row.origin === 'managed' && (config.endpoint?.startsWith('https') ?? false);
    const internalCaPem = isManagedTls ? await this.storageCaPem() : null;
    // A `relayEnabled` cluster's persisted endpoint (`https://127.0.0.1`, set by
    // `ManagedStorageService.create`) is a stable, cosmetic placeholder — the
    // proxy allocates a fresh loopback listener port every gateway boot, so the
    // real host:port has to be resolved fresh here, right before the client is
    // built, rather than trusted from the DB. `isManagedTls` above already
    // covers the internal-CA trust for this case, since the persisted endpoint
    // is already https.
    if (row.origin === 'managed' && this.tunnelProxy) {
      const cluster = await this.getManagedCluster(row.id);
      if (cluster?.relayEnabled) {
        const relayEndpoint = await this.tunnelProxy.getEndpoint(cluster.id);
        config.endpoint = `https://${relayEndpoint.host}:${relayEndpoint.port}`;
      }
    }
    const backend = new S3StorageBackend(this.buildClient(config, internalCaPem ? { internalCaPem } : undefined));
    this.clients.set(id, backend);
    return backend;
  }

  private buildFileProtocolBackend(config: FileProtocolConnectionConfig): StorageBackend {
    return config.provider === 'sftp' ? new SftpStorageBackend(config) : new FtpStorageBackend(config);
  }

  private buildBackend(config: StorageConnectionConfig): StorageBackend {
    return isFileProtocolConfig(config)
      ? this.buildFileProtocolBackend(config)
      : new S3StorageBackend(this.buildClient(config));
  }

  /** Fetches the Storage CA pem once and caches it for the lifetime of this service instance. */
  private async storageCaPem(): Promise<string | null> {
    if (!this.storageCA) return null;
    if (!this.storageCaPemPromise) {
      this.storageCaPemPromise = this.storageCA.getStorageCA().then((ca) => ca.certificatePem);
    }
    return this.storageCaPemPromise;
  }

  private buildClient(config: S3ConnectionConfig, options?: { internalCaPem?: string }): S3Client {
    return new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
      ...(options?.internalCaPem
        ? { requestHandler: new NodeHttpHandler({ httpsAgent: buildInternalCaHttpsAgent(options.internalCaPem) }) }
        : {}),
    });
  }

  disposeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.destroy();
      this.clients.delete(id);
    }
  }

  private async probe(
    config: StorageConnectionConfig
  ): Promise<{ status: ObjectStorageHealthStatus; responseMs: number; error: string | null }> {
    const backend = this.buildBackend(config);
    const started = Date.now();
    try {
      await backend.probe();
      const responseMs = Date.now() - started;
      return { status: responseMs > SLOW_THRESHOLD_MS ? 'degraded' : 'online', responseMs, error: null };
    } catch (error) {
      const mapped = mapObjectStorageError(error, 'connect');
      // Any probe failure (unreachable endpoint or bad credentials) → offline.
      const message = mapped?.message ?? (error instanceof Error ? error.message : 'connection failed');
      return { status: 'offline', responseMs: Date.now() - started, error: message };
    } finally {
      backend.destroy();
    }
  }

  private normalizeConfig(
    provider: StorageProvider,
    input: NormalizeS3ConfigInput & NormalizeFileProtocolConfigInput,
    current: StorageConnectionConfig | null
  ): StorageConnectionConfig {
    if (isFileProtocolProvider(provider)) {
      // A provider switch across families discards the other family's config
      // rather than merging incompatible fields into it.
      const currentFileConfig = current && isFileProtocolConfig(current) ? current : null;
      return normalizeFileProtocolConfig(provider, input, currentFileConfig);
    }
    const currentS3Config = current && !isFileProtocolConfig(current) ? current : null;
    return normalizeS3Config(provider, input, currentS3Config);
  }

  private configFingerprint(config: StorageConnectionConfig) {
    if (isFileProtocolConfig(config)) {
      return {
        provider: config.provider,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password ?? null,
        privateKey: config.privateKey ?? null,
        passphrase: config.passphrase ?? null,
        caPem: config.caPem ?? null,
        basePath: config.basePath,
        implicitTls: config.implicitTls,
      };
    }
    return {
      provider: config.provider,
      endpoint: config.endpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken ?? null,
      forcePathStyle: config.forcePathStyle,
    };
  }

  private emitChange(id: string, action: string, extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('storage.changed', { id, action, ...extra });
  }

  private encryptSecret(secret: StoredSecretConfig): string {
    return JSON.stringify(this.cryptoService.encryptString(JSON.stringify(secret)));
  }

  private decryptSecret(encryptedConfig: string): StoredSecretConfig {
    const parsed = JSON.parse(encryptedConfig) as { encryptedKey: string; encryptedDek: string };
    return JSON.parse(this.cryptoService.decryptString(parsed)) as StoredSecretConfig;
  }

  private decryptConfigFromRow(row: Awaited<ReturnType<ObjectStorageService['getRow']>>): StorageConnectionConfig {
    const secret = this.decryptSecret(row.encryptedConfig);
    if (isFileProtocolProvider(row.provider)) {
      return {
        provider: row.provider,
        host: row.host ?? '',
        port: resolveFileProtocolPort(row.provider, row.port, row.implicitTls),
        username: row.username ?? '',
        password: secret.password ?? null,
        privateKey: secret.privateKey ?? null,
        hostKeyFingerprint: secret.hostKeyFingerprint ?? null,
        passphrase: secret.passphrase ?? null,
        caPem: secret.caPem ?? null,
        basePath: row.basePath,
        implicitTls: row.implicitTls,
        defaultBucket: row.defaultBucket,
      };
    }
    return {
      provider: row.provider,
      endpoint: row.endpoint,
      region: row.region ?? '',
      accessKeyId: row.accessKeyId ?? '',
      secretAccessKey: secret.secretAccessKey ?? '',
      sessionToken: secret.sessionToken ?? null,
      defaultBucket: row.defaultBucket,
      forcePathStyle: row.forcePathStyle,
    };
  }

  /** Splits a resolved config back into the encrypted-at-rest half. */
  private toStoredSecret(config: StorageConnectionConfig): StoredSecretConfig {
    return isFileProtocolConfig(config)
      ? {
          password: config.password ?? null,
          privateKey: config.privateKey ?? null,
          hostKeyFingerprint: config.hostKeyFingerprint ?? null,
          passphrase: config.passphrase ?? null,
          caPem: config.caPem ?? null,
        }
      : { secretAccessKey: config.secretAccessKey, sessionToken: config.sessionToken ?? null };
  }

  /** Splits a resolved config back into the plaintext column half. */
  private toStoredColumns(config: StorageConnectionConfig) {
    if (isFileProtocolConfig(config)) {
      return {
        endpoint: null,
        region: null,
        accessKeyId: null,
        forcePathStyle: false,
        host: config.host,
        port: config.port,
        username: config.username,
        basePath: config.basePath,
        implicitTls: config.implicitTls,
        defaultBucket: config.defaultBucket,
      };
    }
    return {
      endpoint: config.endpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      forcePathStyle: config.forcePathStyle,
      host: null,
      port: null,
      username: null,
      basePath: null,
      implicitTls: false,
      defaultBucket: config.defaultBucket,
    };
  }

  shutdown(): void {
    for (const id of [...this.clients.keys()]) this.disposeClient(id);
  }

  async getBackupTarget(id: string): Promise<StorageBackupTargetConfig> {
    const row = await this.getRow(id);
    const config = this.decryptConfigFromRow(row);
    const cluster = row.origin === 'managed' ? await this.getManagedCluster(id) : null;
    if (cluster && cluster.status !== 'ready')
      throw new AppError(409, 'STORAGE_NOT_READY', 'Managed storage is not ready');
    const metadata = {
      connectionId: id,
      ...(cluster ? { managedClusterId: cluster.id, managedNodeId: cluster.nodeId } : {}),
    };
    if (isFileProtocolConfig(config))
      return {
        ...metadata,
        provider: config.provider,
        host: config.host,
        port: config.port,
        username: config.username,
        implicitTls: config.implicitTls,
        basePath: config.basePath ?? undefined,
        password: config.password ?? undefined,
        privateKey: config.privateKey ?? undefined,
        passphrase: config.passphrase ?? undefined,
        caPem: config.caPem ?? undefined,
        hostKeyFingerprint: config.hostKeyFingerprint ?? undefined,
      };
    return {
      ...metadata,
      provider: config.provider,
      endpoint: config.endpoint ?? undefined,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken ?? undefined,
    };
  }

  private async getRow(id: string) {
    const row = await this.db.query.objectStorageConnections.findFirst({ where: eq(objectStorageConnections.id, id) });
    if (!row) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Object storage connection not found');
    return row;
  }

  private async getManagedCluster(connectionId: string): Promise<ManagedStorageClusterRow | null> {
    const [cluster] = await this.db
      .select()
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.objectStorageConnectionId, connectionId))
      .limit(1);
    return cluster ?? null;
  }
}
