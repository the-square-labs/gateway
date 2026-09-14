import { Agent } from 'node:https';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import { managedStorageClusters } from '@/db/schema/managed-storage.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  buildInternalCaHttpsAgent,
  normalizeFileProtocolConfig,
  normalizeS3Config,
  ObjectStorageService,
} from './object-storage.service.js';
import {
  maskStorageCredential,
  type ObjectStorageConnectionRow,
  type S3ConnectionConfig,
  toObjectStorageConnectionView,
} from './object-storage-connection-view.js';
import { isStorageWarmupError, mapObjectStorageError } from './object-storage-error-mapping.js';
import { listObjects } from './s3-object-operations.js';

describe('mapObjectStorageError', () => {
  it('maps invalid access key to 401', () => {
    const error = Object.assign(new Error('The AWS Access Key Id you provided does not exist'), {
      name: 'InvalidAccessKeyId',
    });
    const mapped = mapObjectStorageError(error, 'connect');
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.statusCode).toBe(401);
    expect(mapped?.code).toBe('STORAGE_AUTH_FAILED');
  });

  it('maps missing bucket to 404', () => {
    const error = Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });
    const mapped = mapObjectStorageError(error, 'object');
    expect(mapped?.statusCode).toBe(404);
    expect(mapped?.code).toBe('STORAGE_NOT_FOUND');
  });

  it('maps connectivity failures to 422', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), { code: 'ECONNREFUSED' });
    const mapped = mapObjectStorageError(error, 'connect');
    expect(mapped?.statusCode).toBe(422);
    expect(mapped?.code).toBe('STORAGE_CONNECTION_FAILED');
  });

  it('passes through unknown errors as null', () => {
    expect(mapObjectStorageError(new Error('something weird'), 'object')).toBeNull();
  });
});

describe('maskStorageCredential', () => {
  it('masks non-empty values', () => {
    expect(maskStorageCredential('secret')).toBe('••••••••');
  });
  it('returns empty string for missing values', () => {
    expect(maskStorageCredential(null)).toBe('');
    expect(maskStorageCredential(undefined)).toBe('');
  });
});

describe('toObjectStorageConnectionView', () => {
  const baseRow: ObjectStorageConnectionRow = {
    id: 'id-1',
    name: 'My Bucket Store',
    slug: 'my-bucket-store',
    provider: 'minio',
    description: null,
    tags: ['prod'],
    endpoint: 'http://minio:9000',
    region: 'us-east-1',
    accessKeyId: 'AKIA',
    defaultBucket: 'assets',
    forcePathStyle: true,
    host: null,
    port: null,
    username: null,
    basePath: null,
    implicitTls: false,
    healthStatus: 'online',
    lastHealthCheckAt: new Date('2026-07-23T00:00:00.000Z'),
    lastError: null,
    healthHistory: [],
    folderId: null,
    sortOrder: 0,
    createdById: 'user-1',
    updatedById: null,
    createdAt: new Date('2026-07-23T00:00:00.000Z'),
    updatedAt: new Date('2026-07-23T00:00:00.000Z'),
    origin: 'user',
  };

  it('masks the secret when not revealing', () => {
    const view = toObjectStorageConnectionView(
      baseRow,
      { secretAccessKey: 'topsecret', sessionToken: null },
      false,
      false
    );
    expect(view.config.secretAccessKey).toBe('••••••••');
    expect(view.hasStoredSecret).toBe(true);
    expect(view.accessKeyId).toBe('AKIA');
    expect(view.provider).toBe('minio');
  });

  it('reveals the secret when requested', () => {
    const view = toObjectStorageConnectionView(
      baseRow,
      { secretAccessKey: 'topsecret', sessionToken: 'tok' },
      true,
      false
    );
    expect(view.config.secretAccessKey).toBe('topsecret');
    expect(view.config.sessionToken).toBe('tok');
    expect(view.hasStoredSessionToken).toBe(true);
  });

  it('reports no stored secret when empty', () => {
    const view = toObjectStorageConnectionView(baseRow, { secretAccessKey: '', sessionToken: null }, false, false);
    expect(view.hasStoredSecret).toBe(false);
    expect(view.config.secretAccessKey).toBe('');
  });

  it('reports origin:user and no managed block for a plain connection', () => {
    const view = toObjectStorageConnectionView(
      baseRow,
      { secretAccessKey: 'topsecret', sessionToken: null },
      false,
      false
    );
    expect(view.origin).toBe('user');
    expect(view.managed).toBeUndefined();
  });

  it('embeds the managed block, deriving runtimeConfig, when a managed cluster row is provided', () => {
    const managedRow = { ...baseRow, origin: 'managed' as const };
    const clusterRow = {
      id: 'cluster-1',
      objectStorageConnectionId: 'id-1',
      nodeId: 'node-1',
      name: 'my-bucket-store',
      slug: 'my-bucket-store',
      version: '2025-04-22',
      imageRef: 'quay.io/minio/minio@sha256:abc',
      encryptedRootCredentials: 'encrypted',
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: {
        nanoCPUs: 1_000_000_000,
        memoryLimitBytes: 1024 * 1024 * 1024,
        memorySwapBytes: 1536 * 1024 * 1024,
      },
      erasureConfig: { nodeCount: 1, drivesPerNode: 1 },
      publishedPort: 9500,
      publishS3: true,
      status: 'ready' as const,
      tlsEnabled: false,
      relayEnabled: false,
      certificateId: null,
      sftpEnabled: false,
      sftpPort: null,
      encryptedSftpHostKey: null,
      ftpEnabled: false,
      ftpPort: null,
      ftpPassivePortStart: null,
      ftpPassivePortCount: null,
      pendingOperation: null,
      lastError: null,
      createdById: 'user-1',
      updatedById: null,
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      updatedAt: new Date('2026-07-23T00:00:00.000Z'),
    };

    const view = toObjectStorageConnectionView(
      managedRow,
      { secretAccessKey: 'topsecret', sessionToken: null },
      false,
      false,
      clusterRow
    );

    expect(view.origin).toBe('managed');
    expect(view.managed).toEqual({
      id: 'cluster-1',
      nodeId: 'node-1',
      version: '2025-04-22',
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 512 },
      publishedPort: 9500,
      publishS3: true,
      status: 'ready',
      lastError: null,
    });
  });
});

describe('normalizeS3Config', () => {
  const current: S3ConnectionConfig = {
    provider: 'minio',
    endpoint: 'http://minio:9000',
    region: 'us-east-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'stored-secret',
    sessionToken: null,
    defaultBucket: null,
    forcePathStyle: true,
  };

  it('preserves the stored secret when omitted', () => {
    expect(normalizeS3Config('minio', { region: 'us-east-1' }, current).secretAccessKey).toBe('stored-secret');
  });

  it('preserves the stored secret when an empty string is sent (masked round-trip)', () => {
    expect(normalizeS3Config('minio', { secretAccessKey: '' }, current).secretAccessKey).toBe('stored-secret');
  });

  it('takes a new secret when provided', () => {
    expect(normalizeS3Config('minio', { secretAccessKey: 'new-secret' }, current).secretAccessKey).toBe('new-secret');
  });

  it('throws STORAGE_SECRET_REQUIRED when no secret is available on create', () => {
    expect(() => normalizeS3Config('aws', { region: 'us-east-1', accessKeyId: 'AKIA' }, null)).toThrow(/secret/i);
  });

  it('requires an endpoint for minio, cloudflare_r2 and other', () => {
    for (const provider of ['minio', 'cloudflare_r2', 'other'] as const) {
      expect(() =>
        normalizeS3Config(provider, { region: 'auto', accessKeyId: 'AKIA', secretAccessKey: 's', endpoint: '' }, null)
      ).toThrow(/endpoint/i);
    }
  });

  it('does not require an endpoint for aws', () => {
    const out = normalizeS3Config('aws', { region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 's' }, null);
    expect(out.endpoint).toBeNull();
  });
});

/**
 * Minimal drizzle-chain stand-in: every builder method returns itself and the
 * chain is awaitable at any point, always resolving to `result`. Mirrors the
 * db-double pattern used elsewhere in this module family (see
 * managed-storage.service.test.ts's `fakeDb`), simplified because these
 * tests never assert on intermediate chain calls.
 */
function chainable<T>(result: T) {
  const obj: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'offset', 'set']) {
    obj[method] = vi.fn(() => obj);
  }
  // biome-ignore lint/suspicious/noThenProperty: intentionally thenable — mimics drizzle's awaitable query builder chain.
  obj.then = (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  obj.catch = (reject: (reason: unknown) => unknown) => Promise.resolve(result).catch(reject);
  return obj;
}

/**
 * Fake `DrizzleClient` covering the calls `ObjectStorageService` makes for
 * `list`/`get`/`update`/`delete`: `db.query.objectStorageConnections.findFirst`
 * for the single-row lookups, and `db.select().from(<table>)` routed by table
 * identity (`objectStorageConnections` rows vs. count vs. `managedStorageClusters`).
 */
function fakeDb(options: {
  row?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  total?: number;
  clusterRow?: Record<string, unknown> | null;
  clusterRows?: Record<string, unknown>[];
  updatedRow?: Record<string, unknown>;
}) {
  const findFirst = vi.fn(async () => options.row);
  const select = vi.fn((cols?: unknown) => ({
    from: vi.fn((table: unknown) => {
      if (table === backupPolicies || table === backupRuns) return chainable([]);
      if (table === managedStorageClusters) {
        return chainable(options.clusterRows ?? (options.clusterRow ? [options.clusterRow] : []));
      }
      if (cols) return chainable([{ count: options.total ?? options.rows?.length ?? 0 }]);
      return chainable(options.rows ?? []);
    }),
  }));
  const returning = vi.fn(async () => [options.updatedRow]);
  const set = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }));
  const update = vi.fn(() => ({ set }));
  const deleteWhere = vi.fn(async () => undefined);
  const del = vi.fn(() => ({ where: deleteWhere }));
  const db = {
    select,
    update,
    delete: del,
    query: { objectStorageConnections: { findFirst } },
  };
  return { db, select, findFirst, update, set, delete: del, deleteWhere, returning };
}

const connectionRow = {
  id: 'conn-1',
  name: 'Prod Storage',
  slug: 'prod-storage',
  provider: 'minio' as const,
  description: null,
  tags: [],
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKeyId: 'AKIA',
  defaultBucket: null,
  forcePathStyle: true,
  healthStatus: 'online' as const,
  lastHealthCheckAt: new Date('2026-08-01T00:00:00.000Z'),
  lastError: null,
  healthHistory: [],
  folderId: null,
  sortOrder: 0,
  encryptedConfig: JSON.stringify({ encryptedKey: 'k', encryptedDek: 'd' }),
  createdById: 'user-1',
  updatedById: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  origin: 'user' as const,
};

const managedClusterRow = {
  id: 'cluster-1',
  objectStorageConnectionId: 'conn-1',
  nodeId: 'node-1',
  name: 'prod-storage',
  slug: 'prod-storage',
  version: '2025-04-22',
  imageRef: 'quay.io/minio/minio@sha256:abc',
  encryptedRootCredentials: 'encrypted',
  storageSizeBytes: 10 * 1024 * 1024 * 1024,
  runtimeConfig: { nanoCPUs: 1_000_000_000, memoryLimitBytes: 1024 * 1024 * 1024, memorySwapBytes: 1024 * 1024 * 1024 },
  publishedPort: 9500,
  publishS3: true,
  status: 'ready' as const,
  pendingOperation: null,
  lastError: null,
  createdById: 'user-1',
  updatedById: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('isStorageWarmupError', () => {
  // A managed cluster publishes its port before its server accepts requests, so
  // the first call after a create lands in that window. Surfacing it as a hard
  // failure turned an ordinary startup race into a visible error.
  it('recognizes the connection-level errors a starting server produces', () => {
    expect(isStorageWarmupError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isStorageWarmupError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  // Retrying these would only delay a failure that is going to repeat.
  it('does not treat a settled failure as warm-up', () => {
    expect(isStorageWarmupError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isStorageWarmupError(Object.assign(new Error('san'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe(false);
    expect(isStorageWarmupError(new Error('no code'))).toBe(false);
  });
});

describe('normalizeFileProtocolConfig', () => {
  const stored = {
    provider: 'sftp' as const,
    host: 'files.example.com',
    port: 2222,
    username: 'deploy',
    password: 'stored-password',
    privateKey: null,
    passphrase: null,
    caPem: null,
    basePath: '/srv/data',
    implicitTls: false,
    defaultBucket: null,
  };

  it('requires a host', () => {
    expect(() => normalizeFileProtocolConfig('ftp', {}, null)).toThrow(AppError);
  });

  it('applies the protocol default port when none is given', () => {
    expect(normalizeFileProtocolConfig('ftp', { host: 'h', password: 'p' }, null).port).toBe(21);
    expect(normalizeFileProtocolConfig('sftp', { host: 'h', password: 'p' }, null).port).toBe(22);
  });

  it('uses 990 for implicit FTPS', () => {
    const config = normalizeFileProtocolConfig('ftps', { host: 'h', implicitTls: true }, null);
    expect(config.port).toBe(990);
  });

  it('keeps the stored password when the caller omits it', () => {
    expect(normalizeFileProtocolConfig('sftp', { host: 'h' }, stored).password).toBe('stored-password');
    expect(normalizeFileProtocolConfig('sftp', { host: 'h', password: '' }, stored).password).toBe('stored-password');
  });

  // Password and key are alternatives: keeping the old one around would leave a
  // credential live that the operator believes they replaced.
  it('clears the stored password when a private key is supplied', () => {
    const config = normalizeFileProtocolConfig('sftp', { privateKey: 'KEY' }, stored);
    expect(config.privateKey).toBe('KEY');
    expect(config.password).toBeNull();
  });

  it('clears a stored private key when a password is supplied', () => {
    const withKey = { ...stored, password: null, privateKey: 'KEY', passphrase: 'PASS' };
    const config = normalizeFileProtocolConfig('sftp', { password: 'pw' }, withKey);
    expect(config.password).toBe('pw');
    expect(config.privateKey).toBeNull();
    expect(config.passphrase).toBeNull();
  });

  it('requires some credential for SFTP', () => {
    expect(() => normalizeFileProtocolConfig('sftp', { host: 'h' }, null)).toThrow(AppError);
  });

  it('allows FTP without a password, for anonymous servers', () => {
    const config = normalizeFileProtocolConfig('ftp', { host: 'h', username: 'anonymous' }, null);
    expect(config.password).toBeNull();
  });

  it('clears the base path when explicitly emptied', () => {
    expect(normalizeFileProtocolConfig('sftp', { basePath: '' }, stored).basePath).toBeNull();
  });
});

const fakeAudit = () => ({ log: vi.fn().mockResolvedValue(undefined) });
const fakeCrypto = () => ({
  decryptString: vi.fn(() => JSON.stringify({ secretAccessKey: 'stored-secret', sessionToken: null })),
  encryptString: vi.fn(() => ({ encryptedKey: 'k2', encryptedDek: 'd2' })),
});

describe('ObjectStorageService managed connections', () => {
  it('get() embeds the managed block when a cluster row references the connection', async () => {
    const { db } = fakeDb({ row: connectionRow, clusterRow: managedClusterRow });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    const view = await service.get('conn-1');

    expect(view.origin).toBe('user');
    expect(view.managed).toEqual({
      id: 'cluster-1',
      nodeId: 'node-1',
      version: '2025-04-22',
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 0 },
      publishedPort: 9500,
      publishS3: true,
      status: 'ready',
      lastError: null,
    });
  });

  it('get() reports no managed block for a plain connection', async () => {
    const { db } = fakeDb({ row: connectionRow, clusterRow: null });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    const view = await service.get('conn-1');

    expect(view.origin).toBe('user');
    expect(view.managed).toBeUndefined();
  });

  it('list() embeds the managed block for connections with a cluster and omits it for plain ones', async () => {
    const managedConnectionRow = { ...connectionRow, id: 'conn-2', origin: 'managed' as const };
    const { db } = fakeDb({
      rows: [connectionRow, managedConnectionRow],
      total: 2,
      clusterRows: [{ ...managedClusterRow, objectStorageConnectionId: 'conn-2' }],
    });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    const result = await service.list({ page: 1, limit: 50 });

    const plain = result.data.find((v) => v.id === 'conn-1');
    const managed = result.data.find((v) => v.id === 'conn-2');
    expect(plain?.origin).toBe('user');
    expect(plain?.managed).toBeUndefined();
    expect(managed?.origin).toBe('managed');
    expect(managed?.managed?.id).toBe('cluster-1');
    expect(managed?.managed?.status).toBe('ready');
    expect(managed?.managed?.publishedPort).toBe(9500);
  });

  it('update() throws OBJECT_STORAGE_MANAGED_READONLY for a managed-origin connection', async () => {
    const { db } = fakeDb({ row: { ...connectionRow, origin: 'managed' as const } });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    await expect(service.update('conn-1', {}, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'OBJECT_STORAGE_MANAGED_READONLY',
    });
  });

  it('delete() throws OBJECT_STORAGE_MANAGED_READONLY for a managed-origin connection', async () => {
    const { db } = fakeDb({ row: { ...connectionRow, origin: 'managed' as const } });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    await expect(service.delete('conn-1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'OBJECT_STORAGE_MANAGED_READONLY',
    });
  });

  it('update() proceeds as before for a user-origin connection (no config changes → no probe)', async () => {
    const updatedRow = { ...connectionRow, name: 'Prod Storage' };
    const { db } = fakeDb({ row: connectionRow, updatedRow });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    const view = await service.update('conn-1', {}, 'user-1');

    expect(view.name).toBe('Prod Storage');
    expect(view.origin).toBe('user');
  });

  it('delete() proceeds as before for a user-origin connection', async () => {
    const { db, deleteWhere } = fakeDb({ row: connectionRow });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    await service.delete('conn-1', 'user-1');

    expect(deleteWhere).toHaveBeenCalled();
  });
});

describe('buildInternalCaHttpsAgent', () => {
  it('trusts exactly the given CA pem, keeps connections alive, and never disables certificate verification', () => {
    const agent = buildInternalCaHttpsAgent('CA-PEM');
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.options.ca).toBe('CA-PEM');
    expect(agent.options.keepAlive).toBe(true);
    // The whole point of internal-CA trust is verifying against a narrower trust
    // anchor, not skipping verification — must never disable it.
    expect(agent.options.rejectUnauthorized).not.toBe(false);
  });
});

/**
 * `NodeHttpHandler`'s resolved config (including the `httpsAgent` actually
 * handed to the S3Client) is only populated on its private `configProvider`
 * promise — there's no public synchronous accessor pre-request. Reflecting
 * into it (verified directly against the real `@smithy/node-http-handler` +
 * `@aws-sdk/client-s3` packages) is the only way to assert on the live agent
 * without performing a real network call.
 */
async function resolvedHandlerConfig(client: S3Client): Promise<{ httpsAgent?: Agent }> {
  const requestHandler = client.config.requestHandler as unknown as { configProvider: Promise<{ httpsAgent?: Agent }> };
  return requestHandler.configProvider;
}

/** Resolves the S3Client's `endpoint` provider (a function on `config`, not a plain field) to its parsed parts. */
async function resolvedEndpoint(client: S3Client): Promise<{ hostname: string; port?: number; protocol: string }> {
  const endpointProvider = client.config.endpoint as unknown as () => Promise<{
    hostname: string;
    port?: number;
    protocol: string;
  }>;
  return endpointProvider();
}

describe('ObjectStorageService internal-CA trust for managed connections', () => {
  const managedHttpsRow = {
    ...connectionRow,
    id: 'conn-managed',
    origin: 'managed' as const,
    endpoint: 'https://10.0.0.5:9500',
  };
  const managedHttpRow = {
    ...connectionRow,
    id: 'conn-managed-http',
    origin: 'managed' as const,
    endpoint: 'http://10.0.0.5:9500',
  };
  const externalHttpsRow = {
    ...connectionRow,
    id: 'conn-external',
    origin: 'user' as const,
    endpoint: 'https://s3.example.com',
  };

  function fakeStorageCA(certificatePem = 'CA-PEM') {
    return { getStorageCA: vi.fn().mockResolvedValue({ id: 'storage-ca-1', certificatePem }) };
  }

  it('buildClient wires the internal CA agent onto the requestHandler when given internalCaPem', async () => {
    const { db } = fakeDb({ row: connectionRow });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);
    const config = await service.getDecryptedConfig('conn-1');

    const built = service as unknown as { buildClient: (c: unknown, o?: { internalCaPem?: string }) => S3Client };
    const s3Client = built.buildClient(config, { internalCaPem: 'CA-PEM' });
    const resolved = await resolvedHandlerConfig(s3Client);

    expect(resolved.httpsAgent).toBeInstanceOf(Agent);
    expect(resolved.httpsAgent?.options.ca).toBe('CA-PEM');
    expect(resolved.httpsAgent?.options.rejectUnauthorized).not.toBe(false);
    s3Client.destroy();
  });

  it('buildClient leaves the default requestHandler (system trust, no custom agent) when no internalCaPem is given', async () => {
    const { db } = fakeDb({ row: connectionRow });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);
    const config = await service.getDecryptedConfig('conn-1');

    const built = service as unknown as { buildClient: (c: unknown, o?: { internalCaPem?: string }) => S3Client };
    const s3Client = built.buildClient(config);
    const resolved = await resolvedHandlerConfig(s3Client);

    expect(resolved.httpsAgent?.options.ca).toBeUndefined();
    s3Client.destroy();
  });

  it('getClient fetches and trusts the internal Storage CA for a managed connection with an https endpoint', async () => {
    const { db } = fakeDb({ row: managedHttpsRow });
    const storageCA = fakeStorageCA();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      storageCA as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-managed')).client;
    const resolved = await resolvedHandlerConfig(s3Client);

    expect(storageCA.getStorageCA).toHaveBeenCalledTimes(1);
    expect(resolved.httpsAgent?.options.ca).toBe('CA-PEM');
  });

  it('getClient memoizes the CA pem fetch across multiple managed connections (fetched once)', async () => {
    const rowA = { ...managedHttpsRow, id: 'conn-managed-a' };
    const rowB = { ...managedHttpsRow, id: 'conn-managed-b' };
    let call = 0;
    const findFirst = vi.fn(async () => (call++ === 0 ? rowA : rowB));
    // `getClient` now also probes `managedStorageClusters` (for `relayEnabled`)
    // whenever `row.origin === 'managed'` — both rows here are. No cluster row
    // ⇒ `getManagedCluster` resolves null ⇒ no relay override, so this test's
    // CA-memoization behavior is unaffected.
    const db = {
      query: { objectStorageConnections: { findFirst } },
      select: vi.fn(() => ({ from: vi.fn(() => chainable([])) })),
    };
    const storageCA = fakeStorageCA();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      storageCA as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    await getClient.getClient('conn-managed-a');
    await getClient.getClient('conn-managed-b');

    expect(storageCA.getStorageCA).toHaveBeenCalledTimes(1);
  });

  it('getClient does NOT trust the internal CA for a managed connection still on http (no TLS yet)', async () => {
    const { db } = fakeDb({ row: managedHttpRow });
    const storageCA = fakeStorageCA();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      storageCA as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-managed-http')).client;
    const resolved = await resolvedHandlerConfig(s3Client);

    expect(storageCA.getStorageCA).not.toHaveBeenCalled();
    expect(resolved.httpsAgent?.options.ca).toBeUndefined();
  });

  it('getClient never trusts the internal CA for an external (user-origin) connection, even over https — external S3/MinIO stays unchanged', async () => {
    const { db } = fakeDb({ row: externalHttpsRow });
    const storageCA = fakeStorageCA();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      storageCA as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-external')).client;
    const resolved = await resolvedHandlerConfig(s3Client);

    expect(storageCA.getStorageCA).not.toHaveBeenCalled();
    expect(resolved.httpsAgent?.options.ca).toBeUndefined();
  });

  it('getClient never attempts CA trust when no StorageCAService is wired in (default, existing behavior)', async () => {
    const { db } = fakeDb({ row: managedHttpsRow });
    const service = new ObjectStorageService(db as never, fakeAudit() as never, fakeCrypto() as never);

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-managed')).client;
    const resolved = await resolvedHandlerConfig(s3Client);

    expect(resolved.httpsAgent?.options.ca).toBeUndefined();
  });
});

describe('ObjectStorageService relay endpoint resolution', () => {
  const managedHttpsRow = {
    ...connectionRow,
    id: 'conn-managed',
    origin: 'managed' as const,
    endpoint: 'https://10.0.0.5:9500',
  };
  const externalHttpsRow = {
    ...connectionRow,
    id: 'conn-external',
    origin: 'user' as const,
    endpoint: 'https://s3.example.com',
  };
  const relayClusterRow = { ...managedClusterRow, id: 'cluster-relay', relayEnabled: true };

  function fakeStorageCA(certificatePem = 'CA-PEM') {
    return { getStorageCA: vi.fn().mockResolvedValue({ id: 'storage-ca-1', certificatePem }) };
  }

  function fakeTunnelProxy(getEndpoint = vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 54321 })) {
    return { getEndpoint, disposeCluster: vi.fn(), shutdown: vi.fn() };
  }

  it("getClient overrides a relayEnabled managed connection endpoint with the tunnel proxy's freshly-resolved 127.0.0.1:<live port>", async () => {
    const { db } = fakeDb({ row: managedHttpsRow, clusterRow: relayClusterRow });
    const storageCA = fakeStorageCA();
    const tunnelProxy = fakeTunnelProxy();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      storageCA as never,
      tunnelProxy as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-managed')).client;
    const endpoint = await resolvedEndpoint(s3Client);

    expect(tunnelProxy.getEndpoint).toHaveBeenCalledWith('cluster-relay');
    expect(endpoint).toMatchObject({ hostname: '127.0.0.1', port: 54321, protocol: 'https:' });
    // Dynamic resolution still needs the internal Storage CA trusted — the
    // persisted `https://127.0.0.1` placeholder already satisfies isManagedTls.
    expect(storageCA.getStorageCA).toHaveBeenCalledTimes(1);
  });

  it('getClient does NOT resolve a relay endpoint for a managed connection with relayEnabled:false (byte-identical)', async () => {
    const { db } = fakeDb({ row: managedHttpsRow, clusterRow: managedClusterRow });
    const tunnelProxy = fakeTunnelProxy();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      fakeStorageCA() as never,
      tunnelProxy as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-managed')).client;
    const endpoint = await resolvedEndpoint(s3Client);

    expect(tunnelProxy.getEndpoint).not.toHaveBeenCalled();
    expect(endpoint).toMatchObject({ hostname: '10.0.0.5', port: 9500 });
  });

  it('getClient does NOT resolve a relay endpoint for an external (user-origin) connection, even with a tunnel proxy wired in', async () => {
    const { db } = fakeDb({ row: externalHttpsRow });
    const tunnelProxy = fakeTunnelProxy();
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      fakeStorageCA() as never,
      tunnelProxy as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    await getClient.getClient('conn-external');

    expect(tunnelProxy.getEndpoint).not.toHaveBeenCalled();
  });

  it('getClient never resolves a relay endpoint when no tunnel proxy is wired in (default, existing behavior)', async () => {
    const { db } = fakeDb({ row: managedHttpsRow, clusterRow: relayClusterRow });
    const service = new ObjectStorageService(
      db as never,
      fakeAudit() as never,
      fakeCrypto() as never,
      fakeStorageCA() as never
    );

    const getClient = service as unknown as { getClient: (id: string) => Promise<{ client: S3Client }> };
    const s3Client = (await getClient.getClient('conn-managed')).client;
    const endpoint = await resolvedEndpoint(s3Client);

    expect(endpoint).toMatchObject({ hostname: '10.0.0.5', port: 9500 });
  });
});

describe('listObjects', () => {
  it('drops the prefix placeholder object and maps prefixes/objects/pagination', async () => {
    const fakeClient = {
      send: async () => ({
        CommonPrefixes: [{ Prefix: 'photos/sub/' }],
        Contents: [
          { Key: 'photos/', Size: 0 },
          {
            Key: 'photos/hello.txt',
            Size: 8,
            ETag: '"abc"',
            LastModified: new Date('2026-07-24T00:00:00.000Z'),
            StorageClass: 'STANDARD',
          },
        ],
        IsTruncated: true,
        NextContinuationToken: 'tok',
      }),
    } as unknown as S3Client;

    const res = await listObjects(fakeClient, { bucket: 'demo', prefix: 'photos/', delimiter: '/' });
    expect(res.prefixes).toEqual(['photos/sub/']);
    expect(res.objects.map((o) => o.key)).toEqual(['photos/hello.txt']);
    expect(res.objects[0]?.size).toBe(8);
    expect(res.nextContinuationToken).toBe('tok');
    expect(res.isTruncated).toBe(true);
  });
});
