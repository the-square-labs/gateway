import { describe, expect, it, vi } from 'vitest';
import { backupPolicies, backupRuns, objectStorageConnections } from '@/db/schema/index.js';
import { managedStorageAccessKeys, managedStorageClusters } from '@/db/schema/managed-storage.js';
import { nodes } from '@/db/schema/nodes.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { ManagedWorkloadDispatch } from '@/modules/managed-workloads/managed-workload-dispatch.js';
import type { ManagedWorkloadLifecycle } from '@/modules/managed-workloads/managed-workload-lifecycle.js';
import type { ManagedWorkloadProvider } from '@/modules/managed-workloads/managed-workload-provider.js';
import type { ManagedWorkloadStore } from '@/modules/managed-workloads/managed-workload-store.js';
import { ManagedStorageService } from './managed-storage.service.js';

// Every construction site in this file goes through here so the license gate on
// `create` sees a configured policy: an unwired policy fails closed with a 503,
// which is asserted separately below.
function licensedStorageService(...args: ConstructorParameters<typeof ManagedStorageService>) {
  const service = new ManagedStorageService(...args);
  const dispatch = args[7];
  const lifecycle = args[8];
  const originalDelete = lifecycle.dispatchDelete.bind(lifecycle);
  lifecycle.dispatchDelete = vi.fn(async (row, userId) => {
    await dispatch.beforeDelete?.(row, userId);
    return originalDelete(row, userId);
  });
  service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
  return service;
}

import { buildManagedStoragePolicy } from './managed-storage-iam-policy.js';
import type { StorageClusterMemberStore } from './storage-cluster-member-store.js';

// `managed-storage.service.ts` creates its own module-scoped child logger
// (`createChildLogger('ManagedStorage')`) for the orphaned-credential log
// lines below — mocked here so the compensating-remove tests can assert on
// what gets logged. `createChildLogger` ignores its argument and always
// returns the same fake, so calling it again below yields the identical
// object the service module holds.
vi.mock('@/lib/logger.js', () => {
  const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { createChildLogger: () => fakeLogger, logger: fakeLogger };
});

const nodeRow = {
  id: '22222222-2222-4222-8222-222222222222',
  hostname: 'storage-node-1.internal',
  serviceAddress: '10.0.0.5',
};

const createInput = {
  name: 'artifacts',
  version: '2025-04-22',
  nodeId: nodeRow.id,
  storageSizeGb: 10,
  cpuCores: 1,
  memoryMb: 1024,
  swapMb: 0,
  publishedPort: 9500,
  publishS3: true,
  relayEnabled: false,
};

/**
 * Fake drizzle client covering the two tables `ManagedStorageService` reads
 * directly: `nodes` (create's host resolution) and `managedStorageClusters`
 * (`getRow`, and `create`'s insert). Mirrors the db-double pattern used
 * across the storage module's other tests (`storage-workload-store.test.ts`,
 * `storage-workload-provider.test.ts`).
 */
function fakeDb(
  options: {
    nodeRow?: Record<string, unknown>;
    insertedRow?: Record<string, unknown>;
    existingRow?: Record<string, unknown>;
    // `assertNoPortConflicts`'s sibling-cluster lookup (`select({...}).from(managedStorageClusters).where(...)`)
    // has no `.limit()` — defaults to [] (no siblings) so every pre-existing create/update
    // test, which never sets this, sees no conflicting clusters and is unaffected.
    siblingRows?: Record<string, unknown>[];
  } = {}
) {
  const nodeLimit = vi.fn(async () => (options.nodeRow ? [options.nodeRow] : []));
  const nodeWhere = vi.fn(() => ({ limit: nodeLimit }));
  const existingLimit = vi.fn(async () => (options.existingRow ? [options.existingRow] : []));
  // `existingWhere`'s returned object must both (a) support `.limit(n)` — the shape
  // `getRow`/the relay exists-check use — and (b) be awaitable directly (a `then`) for
  // `assertNoPortConflicts`'s sibling query, which awaits `.where(...)` with no further
  // chaining. Both query shapes select from `managedStorageClusters`, so they share this
  // one mock; `.limit()` callers are unaffected since they never reach the `then` branch.
  const existingWhere = vi.fn(() => ({
    limit: existingLimit,
    // biome-ignore lint/suspicious/noThenProperty: the fake mirrors drizzle's awaitable query builder, whose `then` is exactly what the code under test uses.
    then: (resolve: (value: Record<string, unknown>[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(options.siblingRows ?? []).then(resolve, reject),
  }));
  const from = vi.fn((table: unknown) =>
    table === objectStorageConnections
      ? { where: vi.fn(() => ({ for: vi.fn().mockResolvedValue([{ id: 'connection-1' }]) })) }
      : table === backupPolicies || table === backupRuns
        ? { where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) }
        : table === nodes
          ? { where: nodeWhere }
          : { where: existingWhere }
  );
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(async () => [options.insertedRow]);
  const values = vi.fn((_values: Record<string, unknown>) => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const deleteWhere = vi.fn(async () => undefined);
  const del = vi.fn(() => ({ where: deleteWhere }));
  // TLS-enabled create persists `certificateId`/`tlsEnabled` onto the just-inserted
  // row via `db.update(managedStorageClusters).set(...).where(...).returning()`.
  // `updatedRow` defaults to the inserted row with the update's fields merged in,
  // matching what a real UPDATE ... RETURNING would hand back.
  const updateReturning = vi.fn(async () => [
    {
      ...(options.insertedRow ?? options.existingRow),
      ...(updateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined),
    },
  ]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db = {
    select,
    insert,
    delete: del,
    update,
    transaction: async (fn: (tx: any) => Promise<any>): Promise<any> => fn(db),
  };
  return {
    db,
    select,
    from,
    insert,
    values,
    returning,
    delete: del,
    deleteWhere,
    update,
    updateSet,
    updateWhere,
    updateReturning,
  };
}

function fakeProvider(overrides: Partial<ManagedWorkloadProvider> = {}): ManagedWorkloadProvider {
  return {
    kind: 'storage',
    resolveImage: vi.fn((_type: string, version: string) => {
      if (version !== '2025-04-22') {
        throw new AppError(400, 'INVALID_MANAGED_STORAGE_VERSION', `Unknown managed storage version: ${version}`);
      }
      return 'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z';
    }),
    listCatalog: vi.fn(),
    registerCanonicalConnection: vi.fn().mockResolvedValue('connection-1'),
    syncCanonicalConnection: vi.fn().mockResolvedValue(undefined),
    ensureCertificate: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeDispatch(
  overrides: Partial<ManagedWorkloadDispatch<never, never>> = {}
): ManagedWorkloadDispatch<never, never> {
  return {
    renderCommandPayload: vi.fn(),
    assertNodeReady: vi.fn().mockResolvedValue(undefined),
    prepareReplay: vi.fn(),
    readOwnerCredentials: vi.fn(() => ({ username: 'root-access-key', password: 'root-secret-password' })),
    publishFlags: vi.fn(),
    ensureDirectAccess: vi.fn(),
    provisionDirectAccess: vi.fn(),
    resolvePublishedPort: vi.fn(),
    resolvePublishedNativePort: vi.fn(),
    finalizeReady: vi.fn(),
    syncStorage: vi.fn(),
    onReconcileReady: vi.fn(),
    disposeCanonicalClient: vi.fn(),
    deleteCanonicalConnection: vi.fn(),
    sendCommand: vi.fn(),
    parseDaemonState: vi.fn(),
    onCreateSucceeded: vi.fn(),
    onReady: vi.fn(),
    auditLifecycle: vi.fn(),
    emit: vi.fn(),
    setEventBus: vi.fn(),
    toView: vi.fn(),
    ...overrides,
  } as unknown as ManagedWorkloadDispatch<never, never>;
}

function fakeStore(overrides: Partial<ManagedWorkloadStore> = {}): ManagedWorkloadStore {
  return {
    getById: vi.fn(),
    listPending: vi.fn(),
    claimOperation: vi.fn(),
    setStatus: vi.fn(),
    setReady: vi.fn(),
    clearPending: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

/** Fake `StorageClusterMemberStore`: only the two methods `create` calls (`insertMembers`, and `deleteByCluster` for the failure-rollback path). */
function fakeMemberStore(overrides: Partial<StorageClusterMemberStore> = {}): StorageClusterMemberStore {
  return {
    listByCluster: vi.fn(),
    insertMembers: vi.fn().mockResolvedValue([]),
    setMemberStatus: vi.fn(),
    deleteByCluster: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as StorageClusterMemberStore;
}

/** Fake `NodeDispatchService`: `sendDockerStorageTargetCommand` (relay register/remove) and `sendDockerStorageIamCommand` (IAM key CRUD). */
function fakeNodeDispatch(
  overrides: {
    sendDockerStorageTargetCommand?: ReturnType<typeof vi.fn>;
    sendDockerStorageIamCommand?: ReturnType<typeof vi.fn>;
    sendDockerContainerCommand?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    sendDockerStorageTargetCommand: vi.fn().mockResolvedValue({ success: true, error: '', detail: '' }),
    sendDockerStorageIamCommand: vi.fn().mockResolvedValue({
      success: true,
      error: '',
      detail: JSON.stringify({ accessKey: 'gw-generated-key', secretKey: 'gw-generated-secret' }),
    }),
    // The host-port availability check (assertNoPortConflicts) lists the node's
    // containers — default to none so create/update tests see no host conflict.
    sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, error: '', detail: '[]' }),
    ...overrides,
  };
}

/** Fake `StorageCAService`: only `getStorageCA`, the one method IAM dispatch consults when a cluster is TLS-enabled. */
function fakeStorageCA(overrides: { getStorageCA?: ReturnType<typeof vi.fn> } = {}) {
  return {
    getStorageCA: vi.fn().mockResolvedValue({ id: 'storage-ca-1', certificatePem: 'storage-ca-pem' }),
    ...overrides,
  };
}

/**
 * Fake drizzle client for the IAM access-key methods: reads
 * `managedStorageClusters` (`getRow`), `nodes` (`requireNode`, for
 * `serverName`), and inserts/selects/deletes `managedStorageAccessKeys`.
 * Deliberately separate from `fakeDb` above (which is shaped around
 * `create`/`update`'s own read/write pattern) since the IAM methods touch a
 * third table with a different chain shape (`.orderBy()` for list, no
 * `.returning()` for delete).
 */
function fakeIamDb(
  options: {
    clusterRow?: Record<string, unknown>;
    nodeRow?: Record<string, unknown>;
    insertedKeyRow?: Record<string, unknown>;
    listedKeyRows?: Record<string, unknown>[];
  } = {}
) {
  const clusterLimit = vi.fn(async () => (options.clusterRow ? [options.clusterRow] : []));
  const clusterWhere = vi.fn(() => ({ limit: clusterLimit }));
  const nodeLimit = vi.fn(async () => (options.nodeRow ? [options.nodeRow] : []));
  const nodeWhere = vi.fn(() => ({ limit: nodeLimit }));
  const keyOrderBy = vi.fn(async () => options.listedKeyRows ?? []);
  const keyWhere = vi.fn(() => ({ orderBy: keyOrderBy }));
  const from = vi.fn((table: unknown) => {
    if (table === nodes) return { where: nodeWhere };
    if (table === managedStorageAccessKeys) return { where: keyWhere };
    return { where: clusterWhere };
  });
  const select = vi.fn((_columns?: Record<string, unknown>) => ({ from }));
  const returning = vi.fn(async () => [options.insertedKeyRow]);
  const values = vi.fn((_values: Record<string, unknown>) => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const deleteWhere = vi.fn(async () => undefined);
  const del = vi.fn(() => ({ where: deleteWhere }));
  const db = { select, insert, delete: del };
  return { db, select, from, insert, values, returning, delete: del, deleteWhere };
}

/** Fake `ManagedStorageTunnelProxy`: only `disposeCluster`, the one method `delete` calls. */
function fakeTunnelProxy(overrides: { disposeCluster?: ReturnType<typeof vi.fn> } = {}) {
  return {
    getEndpoint: vi.fn(),
    disposeCluster: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeLifecycle(
  overrides: Partial<ManagedWorkloadLifecycle<never, never>> = {}
): ManagedWorkloadLifecycle<never, never> {
  return {
    dispatchCreate: vi.fn().mockResolvedValue({ ok: true }),
    dispatchUpdate: vi.fn().mockResolvedValue({ ok: true }),
    dispatchRestart: vi.fn().mockResolvedValue({ ok: true }),
    dispatchDelete: vi.fn().mockResolvedValue({ ok: true }),
    reconcilePendingRow: vi.fn().mockResolvedValue(undefined),
    reconcilePendingOperations: vi.fn().mockResolvedValue(undefined),
    requireOperationClaim: vi.fn((row: unknown) => {
      if (!row) {
        throw new AppError(
          409,
          'MANAGED_STORAGE_OPERATION_PENDING',
          'Managed storage operation is still being reconciled'
        );
      }
      return row;
    }),
    ...overrides,
  } as unknown as ManagedWorkloadLifecycle<never, never>;
}

const audit = { log: vi.fn().mockResolvedValue(undefined) };
const cryptoService = {
  encryptString: vi.fn((value: string) => ({ encryptedKey: `enc(${value})`, encryptedDek: 'dek' })),
  decryptString: vi.fn(),
  generateKeyPair: vi.fn(),
};

const insertedRow = {
  id: '33333333-3333-4333-8333-333333333333',
  objectStorageConnectionId: 'connection-1',
  nodeId: nodeRow.id,
  name: createInput.name,
  slug: 'artifacts',
  version: createInput.version,
  imageRef: 'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z',
  encryptedRootCredentials: JSON.stringify({ encryptedKey: 'enc(...)', encryptedDek: 'dek' }),
  storageSizeBytes: 10 * 1024 * 1024 * 1024,
  runtimeConfig: {
    nanoCPUs: 1_000_000_000,
    memoryLimitBytes: 1024 * 1024 * 1024,
    memorySwapBytes: 1024 * 1024 * 1024,
  },
  publishedPort: createInput.publishedPort,
  status: 'creating',
  pendingOperation: { id: 'op-1', action: 'create' as const },
  lastError: null,
  erasureConfig: { nodeCount: 1, drivesPerNode: 1 },
  createdById: 'user-1',
  updatedById: 'user-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ManagedStorageService', () => {
  it('fails closed before deploying a cluster when license policy wiring is missing', async () => {
    const { db } = fakeDb({ nodeRow, insertedRow });
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      fakeProvider(),
      {} as never,
      fakeStore(),
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );
    (service as unknown as { licensePolicy?: unknown }).licensePolicy = undefined;

    await expect(service.create(createInput as never, 'user-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('creates a managed storage cluster: registers the canonical connection, inserts a creating row, and dispatches create', async () => {
    const { db, insert, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create(createInput as never, 'user-1');

    expect(provider.registerCanonicalConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'artifacts',
        type: 'minio',
        storage: expect.objectContaining({
          endpoint: `http://${nodeRow.serviceAddress}:${createInput.publishedPort}`,
          region: 'us-east-1',
          forcePathStyle: true,
          s3Provider: 'minio',
        }),
      })
    );
    expect(insert).toHaveBeenCalledWith(managedStorageClusters);
    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({
      status: 'creating',
      objectStorageConnectionId: 'connection-1',
      publishedPort: createInput.publishedPort,
      nodeId: createInput.nodeId,
      erasureConfig: { nodeCount: 1, drivesPerNode: 1 },
    });
    expect(dispatch.assertNodeReady).toHaveBeenCalledTimes(1);
    expect(dispatch.assertNodeReady).toHaveBeenCalledWith(createInput.nodeId);
    expect(memberStore.insertMembers).toHaveBeenCalledWith(insertedRow.id, [
      { nodeId: createInput.nodeId, memberIndex: 0, drives: 1 },
    ]);
    expect(lifecycle.dispatchCreate).toHaveBeenCalledWith(insertedRow, expect.any(Object), true, false, 'user-1');
    // Unchanged (no-TLS) path: the CA is never consulted, and no UPDATE is issued.
    expect(provider.ensureCertificate).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('with tlsEnabled:true, issues a certificate via ensureCertificate and persists certificateId/tlsEnabled on the row before dispatching create', async () => {
    const { db, update, updateSet, updateWhere } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider({
      ensureCertificate: vi.fn().mockResolvedValue({ certificateId: 'cert-1' }),
    });
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create({ ...createInput, tlsEnabled: true } as never, 'user-1');

    expect(provider.ensureCertificate).toHaveBeenCalledWith({
      additionalAddresses: [],
      workloadId: insertedRow.id,
      existingCertificateId: null,
      node: { serviceAddress: nodeRow.serviceAddress, hostname: nodeRow.hostname, lastHealthReport: undefined },
      // Plain `tlsEnabled:true` (no relay) never forces the loopback SANs.
      relay: false,
    });
    expect(update).toHaveBeenCalledWith(managedStorageClusters);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ certificateId: 'cert-1', tlsEnabled: true }));
    expect(updateWhere).toHaveBeenCalled();
    const dispatchedRow = vi.mocked(lifecycle.dispatchCreate).mock.calls[0]![0] as Record<string, unknown>;
    expect(dispatchedRow).toMatchObject({ certificateId: 'cert-1', tlsEnabled: true });
    // A cert was issued for this create, so the auto-registered connection must point
    // at https — the object browser's S3 client needs to know to trust the internal
    // Storage CA (keyed off origin==='managed' && endpoint.startsWith('https')).
    expect(provider.registerCanonicalConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        storage: expect.objectContaining({
          endpoint: `https://${nodeRow.serviceAddress}:${createInput.publishedPort}`,
        }),
      })
    );
  });

  it('without tlsEnabled, create never calls ensureCertificate and leaves tlsEnabled=false/certificateId=null', async () => {
    const { db } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );

    await service.create(createInput as never, 'user-1');

    expect(provider.ensureCertificate).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    // Byte-identical to pre-TLS behavior: no tlsEnabled ⇒ endpoint stays http.
    expect(provider.registerCanonicalConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        storage: expect.objectContaining({
          endpoint: `http://${nodeRow.serviceAddress}:${createInput.publishedPort}`,
        }),
      })
    );
  });

  it('with sftpEnabled:true, generates and persists an encrypted SSH host key and threads sftpEnabled/sftpPort into the insert', async () => {
    const { db, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const localCrypto = {
      ...cryptoService,
      generateKeyPair: vi.fn((algorithm: string) => {
        expect(algorithm).toBe('ecdsa-p256');
        return { publicKeyPem: 'PUB', privateKeyPem: 'PRIV' };
      }),
    };
    const service = licensedStorageService(
      db as never,
      audit as never,
      localCrypto as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create({ ...createInput, sftpEnabled: true, sftpPort: 8022 } as never, 'user-1');

    expect(localCrypto.generateKeyPair).toHaveBeenCalledWith('ecdsa-p256');
    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({ sftpEnabled: true, sftpPort: 8022 });
    expect(insertedValues.encryptedSftpHostKey).toBe(
      JSON.stringify({ encryptedKey: 'enc(PRIV)', encryptedDek: 'dek' })
    );
  });

  it('without sftpEnabled, create never generates a host key and leaves sftpEnabled=false/sftpPort=null/encryptedSftpHostKey=null', async () => {
    const { db, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const localCrypto = { ...cryptoService, generateKeyPair: vi.fn() };
    const service = licensedStorageService(
      db as never,
      audit as never,
      localCrypto as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create(createInput as never, 'user-1');

    expect(localCrypto.generateKeyPair).not.toHaveBeenCalled();
    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({ sftpEnabled: false, sftpPort: null, encryptedSftpHostKey: null });
  });

  it('with ftpEnabled:true, threads ftpEnabled/ftpPort/ftpPassivePortStart into the insert (no host key — FTP has none)', async () => {
    const { db, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create(
      { ...createInput, ftpEnabled: true, ftpPort: 8021, ftpPassivePortStart: 30_000 } as never,
      'user-1'
    );

    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({ ftpEnabled: true, ftpPort: 8021, ftpPassivePortStart: 30_000 });
  });

  it('with ftpEnabled:true and ftpPassivePortCount:5, threads ftpPassivePortCount into the insert', async () => {
    const { db, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create(
      {
        ...createInput,
        ftpEnabled: true,
        ftpPort: 8021,
        ftpPassivePortStart: 30_000,
        ftpPassivePortCount: 5,
      } as never,
      'user-1'
    );

    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({ ftpPassivePortCount: 5 });
  });

  it('with ftpEnabled:true and no ftpPassivePortCount, persists the explicit 10-port default', async () => {
    const { db, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create(
      { ...createInput, ftpEnabled: true, ftpPort: 8021, ftpPassivePortStart: 30_000 } as never,
      'user-1'
    );

    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({ ftpPassivePortCount: 10 });
  });

  it('without ftpEnabled, create leaves ftpEnabled=false/ftpPort=null/ftpPassivePortStart=null/ftpPassivePortCount=null', async () => {
    const { db, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider();
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create(createInput as never, 'user-1');

    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({
      ftpEnabled: false,
      ftpPort: null,
      ftpPassivePortStart: null,
      ftpPassivePortCount: null,
    });
  });

  it('allows multiple private relay clusters on the same node', async () => {
    // Two relay clusters on one node would open two daemon streams that evict
    // each other under the gateway's per-nodeId connection key and flap. The
    // guard must refuse the second BEFORE any write (no canonical connection,
    // no cluster row). `fakeDb` returns `existingRow` for the sibling-relay
    // lookup on `managedStorageClusters`.
    const { db } = fakeDb({ nodeRow, insertedRow, existingRow: { id: 'existing-relay-on-node' } });
    const provider = fakeProvider();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );

    await expect(
      service.create({ ...createInput, publishS3: false, relayEnabled: true } as never, 'user-1')
    ).resolves.toEqual({ ok: true });
    expect(provider.registerCanonicalConnection).toHaveBeenCalled();
  });

  it('relayEnabled:true forces TLS (issues a cert without tlsEnabled), registers a cosmetic https://127.0.0.1 endpoint, and persists relayEnabled', async () => {
    // The actual relay register-target dispatch now lives in
    // `StorageWorkloadDispatch.onCreateSucceeded` (see its own tests in
    // storage-workload-dispatch.test.ts), called from INSIDE the mocked
    // `lifecycle.dispatchCreate` below — so a failure there flows through the
    // lifecycle's own markError, not a throw over an already-committed row
    // here. This test only covers what `create()` itself still owns: forcing
    // TLS, persisting `relayEnabled`, and the cosmetic canonical endpoint.
    const { db, update, updateSet, values } = fakeDb({ nodeRow, insertedRow });
    const provider = fakeProvider({
      ensureCertificate: vi.fn().mockResolvedValue({ certificateId: 'cert-relay' }),
    });
    const dispatch = fakeDispatch();
    const lifecycle = fakeLifecycle();
    const memberStore = fakeMemberStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create({ ...createInput, relayEnabled: true } as never, 'user-1');

    // Relay implies TLS even though the caller never set tlsEnabled — and the
    // cert's SAN list must additionally cover the loopback identity.
    expect(provider.ensureCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ workloadId: insertedRow.id, relay: true })
    );
    expect(update).toHaveBeenCalledWith(managedStorageClusters);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ certificateId: 'cert-relay', tlsEnabled: true }));
    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({ relayEnabled: true });
    // A stable, cosmetic endpoint: the live host:port is resolved dynamically
    // per-boot by ManagedStorageTunnelProxy.getEndpoint in
    // ObjectStorageService.getClient, so persisting the proxy's ephemeral port
    // here would go stale across a gateway restart.
    expect(provider.registerCanonicalConnection).toHaveBeenCalledWith(
      expect.objectContaining({ storage: expect.objectContaining({ endpoint: 'https://127.0.0.1' }) })
    );
    expect(lifecycle.dispatchCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      true,
      false,
      'user-1'
    );
  });

  it('creates a distributed managed storage cluster from memberNodeIds: readies every member and inserts one member row each', async () => {
    const memberNodeIds = [
      '44444444-4444-4444-8444-444444444441',
      '44444444-4444-4444-8444-444444444442',
      '44444444-4444-4444-8444-444444444443',
      '44444444-4444-4444-8444-444444444444',
    ];
    const multiInsertedRow = {
      ...insertedRow,
      nodeId: memberNodeIds[0],
      erasureConfig: { nodeCount: 4, drivesPerNode: 1 },
    };
    const { db, values } = fakeDb({ nodeRow, insertedRow: multiInsertedRow });
    const dispatch = fakeDispatch();
    const memberStore = fakeMemberStore();
    const lifecycle = fakeLifecycle();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      fakeProvider(),
      {} as never,
      fakeStore(),
      dispatch,
      lifecycle,
      memberStore
    );

    await service.create({ ...createInput, memberNodeIds } as never, 'user-1');

    expect(dispatch.assertNodeReady).toHaveBeenCalledTimes(4);
    for (const memberNodeId of memberNodeIds) {
      expect(dispatch.assertNodeReady).toHaveBeenCalledWith(memberNodeId);
    }
    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({
      nodeId: memberNodeIds[0],
      erasureConfig: { nodeCount: 4, drivesPerNode: 1 },
    });
    expect(memberStore.insertMembers).toHaveBeenCalledWith(
      multiInsertedRow.id,
      memberNodeIds.map((nodeId, memberIndex) => ({ nodeId, memberIndex, drives: 1 }))
    );
    expect(lifecycle.dispatchCreate).toHaveBeenCalledWith(multiInsertedRow, expect.any(Object), true, false, 'user-1');
  });

  it('rejects a distributed cluster with fewer than 4 member nodes', async () => {
    const { db } = fakeDb({ nodeRow });
    const dispatch = fakeDispatch();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      fakeProvider(),
      {} as never,
      fakeStore(),
      dispatch,
      fakeLifecycle(),
      fakeMemberStore()
    );

    await expect(
      service.create(
        {
          ...createInput,
          memberNodeIds: ['44444444-4444-4444-8444-444444444441', '44444444-4444-4444-8444-444444444442'],
        } as never,
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'MANAGED_STORAGE_INVALID_TOPOLOGY' });
    expect(dispatch.assertNodeReady).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a distributed cluster with duplicate member node ids', async () => {
    const { db } = fakeDb({ nodeRow });
    const dispatch = fakeDispatch();
    const duplicateId = '44444444-4444-4444-8444-444444444441';
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      fakeProvider(),
      {} as never,
      fakeStore(),
      dispatch,
      fakeLifecycle(),
      fakeMemberStore()
    );

    await expect(
      service.create(
        {
          ...createInput,
          memberNodeIds: [
            duplicateId,
            duplicateId,
            '44444444-4444-4444-8444-444444444443',
            '44444444-4444-4444-8444-444444444444',
          ],
        } as never,
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'MANAGED_STORAGE_INVALID_TOPOLOGY' });
    expect(dispatch.assertNodeReady).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects an unknown version before touching the node or database', async () => {
    const provider = fakeProvider();
    const { db } = fakeDb();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      fakeStore(),
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );

    await expect(service.create({ ...createInput, version: 'nope' } as never, 'user-1')).rejects.toMatchObject({
      code: 'INVALID_MANAGED_STORAGE_VERSION',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses update when the cluster has a pending operation', async () => {
    const existingRow = {
      id: 'cluster-1',
      nodeId: nodeRow.id,
      name: 'artifacts',
      status: 'updating',
      pendingOperation: { id: 'op-1', action: 'create' as const },
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: {},
      publishedPort: 9500,
      objectStorageConnectionId: 'connection-1',
      updatedById: null,
    };
    const { db } = fakeDb({ existingRow });
    const store = fakeStore();
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      fakeProvider(),
      {} as never,
      store,
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );

    await expect(service.update(existingRow.id, { name: 'renamed' }, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_OPERATION_PENDING',
    });
    expect(store.claimOperation).not.toHaveBeenCalled();
  });

  it('update() re-syncs the canonical endpoint as https when a TLS-enabled cluster changes its published port', async () => {
    const existingRow = {
      id: 'cluster-1',
      nodeId: nodeRow.id,
      name: 'artifacts',
      status: 'ready',
      pendingOperation: null,
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: {},
      publishedPort: 9500,
      objectStorageConnectionId: 'connection-1',
      updatedById: null,
      tlsEnabled: true,
    };
    const { db } = fakeDb({ nodeRow, existingRow });
    const provider = fakeProvider();
    const store = fakeStore({
      claimOperation: vi
        .fn()
        .mockResolvedValue({ ...existingRow, publishedPort: 9600, status: 'updating', updatedById: 'user-1' }),
    });
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      store,
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );

    await service.update(existingRow.id, { publishedPort: 9600 }, 'user-1');

    // The cluster's existing tlsEnabled (not the update input, which carries no TLS
    // toggle) must drive the scheme, or a port change on a TLS cluster would silently
    // downgrade the object browser's connection back to http.
    expect(provider.syncCanonicalConnection).toHaveBeenCalledWith(
      expect.objectContaining({ storage: { endpoint: `https://${nodeRow.serviceAddress}:9600` } })
    );
  });

  it('update() keeps the canonical endpoint http for a non-TLS cluster changing its published port (unchanged)', async () => {
    const existingRow = {
      id: 'cluster-1',
      nodeId: nodeRow.id,
      name: 'artifacts',
      status: 'ready',
      pendingOperation: null,
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: {},
      publishedPort: 9500,
      objectStorageConnectionId: 'connection-1',
      updatedById: null,
      tlsEnabled: false,
    };
    const { db } = fakeDb({ nodeRow, existingRow });
    const provider = fakeProvider();
    const store = fakeStore({
      claimOperation: vi
        .fn()
        .mockResolvedValue({ ...existingRow, publishedPort: 9600, status: 'updating', updatedById: 'user-1' }),
    });
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      {} as never,
      provider,
      {} as never,
      store,
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore()
    );

    await service.update(existingRow.id, { publishedPort: 9600 }, 'user-1');

    expect(provider.syncCanonicalConnection).toHaveBeenCalledWith(
      expect.objectContaining({ storage: { endpoint: `http://${nodeRow.serviceAddress}:9600` } })
    );
  });
});

describe('ManagedStorageService host port conflicts', () => {
  // Phase 2b-vi Task 1: a Docker bind failure at provision time is an ugly way
  // to discover two host ports collide — either within the SAME cluster
  // (S3/SFTP/FTP-control/FTP-passive overlapping each other) or against
  // ANOTHER managed cluster already sitting on the node. Both must surface as
  // a clear 409 up front, in `create` and in `update` (when `publishedPort`
  // moves), instead of failing deep inside the daemon dispatch.

  describe("create: intra-cluster (this cluster's own ports overlap)", () => {
    it('rejects sftpPort colliding with publishedPort', async () => {
      const { db, insert } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(
        service.create({ ...createInput, sftpEnabled: true, sftpPort: createInput.publishedPort } as never, 'user-1')
      ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_STORAGE_PORT_CONFLICT' });
      // Fails before any write — no rollback needed.
      expect(provider.registerCanonicalConnection).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('leaves host-port arbitration to the typed daemon instead of generic Docker inventory', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const nodeDispatch = fakeNodeDispatch({
        // The node already runs some non-managed container binding this host port.
        sendDockerContainerCommand: vi.fn().mockResolvedValue({
          success: true,
          error: '',
          detail: JSON.stringify([
            { name: 'gateway-clickhouse-dev', ports: [{ publicPort: createInput.publishedPort }] },
          ]),
        }),
      });
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        nodeDispatch as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(service.create({ ...createInput } as never, 'user-1')).resolves.toEqual({ ok: true });
      expect(nodeDispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
      expect(provider.registerCanonicalConnection).toHaveBeenCalled();
    });

    it('a daemon list failure does NOT block create (best-effort host-port check)', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const nodeDispatch = fakeNodeDispatch({
        sendDockerContainerCommand: vi.fn().mockRejectedValue(new Error('node offline')),
      });
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        nodeDispatch as never,
        fakeProvider(),
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      // No throw from the host-port check — create proceeds past it (reaches the lifecycle dispatch).
      await expect(service.create({ ...createInput } as never, 'user-1')).resolves.toBeDefined();
    });

    it('rejects an ftpPort that falls inside its own FTP passive port range', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(
        service.create(
          { ...createInput, ftpEnabled: true, ftpPort: 30_005, ftpPassivePortStart: 30_000 } as never,
          'user-1'
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_STORAGE_PORT_CONFLICT' });
      expect(provider.registerCanonicalConnection).not.toHaveBeenCalled();
    });

    it('rejects an sftpPort that falls inside its own FTP passive port range', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(
        service.create(
          {
            ...createInput,
            sftpEnabled: true,
            sftpPort: 30_003,
            ftpEnabled: true,
            ftpPort: 8021,
            ftpPassivePortStart: 30_000,
          } as never,
          'user-1'
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_STORAGE_PORT_CONFLICT' });
      expect(provider.registerCanonicalConnection).not.toHaveBeenCalled();
    });

    it('with ftpPassivePortCount:5, rejects an sftpPort at start+4 (inside the shortened passive range)', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(
        service.create(
          {
            ...createInput,
            sftpEnabled: true,
            sftpPort: 30_004,
            ftpEnabled: true,
            ftpPort: 8021,
            ftpPassivePortStart: 30_000,
            ftpPassivePortCount: 5,
          } as never,
          'user-1'
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_STORAGE_PORT_CONFLICT' });
      expect(provider.registerCanonicalConnection).not.toHaveBeenCalled();
    });

    it('with ftpPassivePortCount:5, does NOT flag an sftpPort at start+10 (past the shortened passive range)', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const localCrypto = {
        ...cryptoService,
        generateKeyPair: vi.fn(() => ({ publicKeyPem: 'PUB', privateKeyPem: 'PRIV' })),
      };
      const service = licensedStorageService(
        db as never,
        audit as never,
        localCrypto as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(
        service.create(
          {
            ...createInput,
            sftpEnabled: true,
            sftpPort: 30_010,
            ftpEnabled: true,
            ftpPort: 8021,
            ftpPassivePortStart: 30_000,
            ftpPassivePortCount: 5,
          } as never,
          'user-1'
        )
      ).resolves.toBeDefined();
    });
  });

  describe('create: inter-cluster (another managed cluster on the same node)', () => {
    it("rejects publishedPort colliding with a sibling cluster's sftpPort on the same node", async () => {
      const siblingRows = [
        {
          id: 'sibling-1',
          name: 'other-storage',
          nodeId: nodeRow.id,
          publishedPort: 8000,
          sftpEnabled: true,
          sftpPort: createInput.publishedPort,
          ftpEnabled: false,
          ftpPort: null,
          ftpPassivePortStart: null,
        },
      ];
      const { db, insert } = fakeDb({ nodeRow, insertedRow, siblingRows });
      const provider = fakeProvider();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(service.create({ ...createInput } as never, 'user-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'MANAGED_STORAGE_PORT_CONFLICT',
        message: expect.stringContaining('other-storage'),
      });
      expect(provider.registerCanonicalConnection).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it("rejects an FTP passive port range overlapping a sibling cluster's publishedPort on the same node", async () => {
      const siblingRows = [
        {
          id: 'sibling-2',
          name: 'colliding-storage',
          nodeId: nodeRow.id,
          publishedPort: 30_005,
          sftpEnabled: false,
          sftpPort: null,
          ftpEnabled: false,
          ftpPort: null,
          ftpPassivePortStart: null,
        },
      ];
      const { db } = fakeDb({ nodeRow, insertedRow, siblingRows });
      const provider = fakeProvider();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(
        service.create(
          { ...createInput, ftpEnabled: true, ftpPort: 8021, ftpPassivePortStart: 30_000 } as never,
          'user-1'
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'MANAGED_STORAGE_PORT_CONFLICT',
        message: expect.stringContaining('colliding-storage'),
      });
      expect(provider.registerCanonicalConnection).not.toHaveBeenCalled();
    });

    it('does not conflict when no sibling clusters share the node (clean create unaffected)', async () => {
      const { db } = fakeDb({ nodeRow, insertedRow });
      const provider = fakeProvider();
      const dispatch = fakeDispatch();
      const lifecycle = fakeLifecycle();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        provider,
        {} as never,
        fakeStore(),
        dispatch,
        lifecycle,
        fakeMemberStore()
      );

      await service.create({ ...createInput } as never, 'user-1');

      expect(provider.registerCanonicalConnection).toHaveBeenCalled();
      expect(lifecycle.dispatchCreate).toHaveBeenCalled();
    });
  });

  describe("update: publishedPort change vs. an existing cluster's ports", () => {
    const existingRow = {
      id: 'cluster-1',
      nodeId: nodeRow.id,
      name: 'artifacts',
      status: 'ready',
      pendingOperation: null,
      storageSizeBytes: 10 * 1024 * 1024 * 1024,
      runtimeConfig: {},
      publishedPort: 9500,
      objectStorageConnectionId: 'connection-1',
      updatedById: null,
      sftpEnabled: false,
      sftpPort: null,
      ftpEnabled: false,
      ftpPort: null,
      ftpPassivePortStart: null,
    };

    it('rejects changing publishedPort to a port already used by a sibling cluster on the node', async () => {
      const siblingRows = [
        {
          id: 'sibling-3',
          name: 'other-storage',
          nodeId: nodeRow.id,
          publishedPort: 9600,
          sftpEnabled: false,
          sftpPort: null,
          ftpEnabled: false,
          ftpPort: null,
          ftpPassivePortStart: null,
        },
      ];
      const { db } = fakeDb({ nodeRow, existingRow, siblingRows });
      const store = fakeStore();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        fakeProvider(),
        {} as never,
        store,
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(service.update(existingRow.id, { publishedPort: 9600 }, 'user-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'MANAGED_STORAGE_PORT_CONFLICT',
        message: expect.stringContaining('other-storage'),
      });
      // Fails before the claim/dispatch: no pending operation is left behind.
      expect(store.claimOperation).not.toHaveBeenCalled();
    });

    it("rejects changing publishedPort to a value that collides with this SAME cluster's own sftpPort (intra, no sibling query needed)", async () => {
      const selfConflictRow = { ...existingRow, sftpEnabled: true, sftpPort: 9600 };
      const { db } = fakeDb({ nodeRow, existingRow: selfConflictRow });
      const store = fakeStore();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        fakeProvider(),
        {} as never,
        store,
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(service.update(selfConflictRow.id, { publishedPort: 9600 }, 'user-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'MANAGED_STORAGE_PORT_CONFLICT',
      });
      expect(store.claimOperation).not.toHaveBeenCalled();
    });

    it('allows changing publishedPort to a free port (no sibling rows, no self overlap)', async () => {
      const { db } = fakeDb({
        nodeRow,
        existingRow,
        insertedRow: { ...existingRow, publishedPort: 9601 },
      });
      const store = fakeStore({
        claimOperation: vi
          .fn()
          .mockResolvedValue({ ...existingRow, publishedPort: 9601, status: 'updating', updatedById: 'user-1' }),
      });
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        fakeProvider(),
        {} as never,
        store,
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await service.update(existingRow.id, { publishedPort: 9601 }, 'user-1');

      expect(store.claimOperation).toHaveBeenCalled();
    });

    it('does not affect an update that leaves publishedPort unchanged (no port-conflict check runs)', async () => {
      const { db } = fakeDb({ nodeRow, existingRow });
      const store = fakeStore({
        claimOperation: vi.fn().mockResolvedValue({ ...existingRow, status: 'updating', updatedById: 'user-1' }),
      });
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        fakeProvider(),
        {} as never,
        store,
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await service.update(existingRow.id, { name: 'renamed' }, 'user-1');

      expect(store.claimOperation).toHaveBeenCalled();
    });

    it("threads the existing row's ftpPassivePortCount into the conflict check: rejects publishedPort at start+4", async () => {
      const shortRangeRow = {
        ...existingRow,
        ftpEnabled: true,
        ftpPort: 8021,
        ftpPassivePortStart: 30_000,
        ftpPassivePortCount: 5,
      };
      const { db } = fakeDb({ nodeRow, existingRow: shortRangeRow });
      const store = fakeStore();
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        fakeProvider(),
        {} as never,
        store,
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await expect(service.update(shortRangeRow.id, { publishedPort: 30_004 }, 'user-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'MANAGED_STORAGE_PORT_CONFLICT',
      });
      expect(store.claimOperation).not.toHaveBeenCalled();
    });

    it("threads the existing row's ftpPassivePortCount into the conflict check: allows publishedPort at start+10 (past the shortened range)", async () => {
      const shortRangeRow = {
        ...existingRow,
        ftpEnabled: true,
        ftpPort: 8021,
        ftpPassivePortStart: 30_000,
        ftpPassivePortCount: 5,
      };
      const { db } = fakeDb({
        nodeRow,
        existingRow: shortRangeRow,
        insertedRow: { ...shortRangeRow, publishedPort: 30_010 },
      });
      const store = fakeStore({
        claimOperation: vi
          .fn()
          .mockResolvedValue({ ...shortRangeRow, publishedPort: 30_010, status: 'updating', updatedById: 'user-1' }),
      });
      const service = licensedStorageService(
        db as never,
        audit as never,
        cryptoService as never,
        {} as never,
        fakeProvider(),
        {} as never,
        store,
        fakeDispatch(),
        fakeLifecycle(),
        fakeMemberStore()
      );

      await service.update(shortRangeRow.id, { publishedPort: 30_010 }, 'user-1');

      expect(store.claimOperation).toHaveBeenCalled();
    });
  });
});

describe('ManagedStorageService.delete', () => {
  const existingRow = {
    id: 'cluster-1',
    nodeId: nodeRow.id,
    name: 'artifacts',
    status: 'ready',
    pendingOperation: null,
    storageSizeBytes: 10 * 1024 * 1024 * 1024,
    runtimeConfig: {},
    publishedPort: 9500,
    objectStorageConnectionId: 'connection-1',
    updatedById: null,
    relayEnabled: false,
  };

  it('relayEnabled:true dispatches remove-target and disposes the tunnel proxy BEFORE dispatchDelete', async () => {
    const relayRow = { ...existingRow, relayEnabled: true };
    const { db } = fakeDb({ existingRow: relayRow });
    const callOrder: string[] = [];
    const nodeDispatch = fakeNodeDispatch();
    const relayPolicy = {
      revokeOwner: vi.fn().mockImplementation(async (ownerKind: string) => {
        callOrder.push(ownerKind === 'managed_storage_gateway' ? 'revokeRoute' : 'revokeEndpoint');
      }),
    };
    const tunnelProxy = fakeTunnelProxy({
      disposeCluster: vi.fn().mockImplementation(async () => {
        callOrder.push('disposeCluster');
      }),
    });
    const store = fakeStore({
      claimOperation: vi.fn().mockResolvedValue({ ...relayRow, status: 'deleting', updatedById: 'user-1' }),
    });
    const lifecycle = fakeLifecycle({
      dispatchDelete: vi.fn().mockImplementation(async () => {
        callOrder.push('dispatchDelete');
        return { ok: true };
      }),
    });
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      nodeDispatch as never,
      fakeProvider(),
      {} as never,
      store,
      fakeDispatch(),
      lifecycle,
      fakeMemberStore(),
      tunnelProxy as never,
      undefined,
      relayPolicy as never
    );

    await service.delete(relayRow.id, 'user-1');

    // Route before endpoint: a daemon grant is pinned to the endpoint, so
    // dropping it first would briefly leave a route pointing at nothing.
    expect(relayPolicy.revokeOwner.mock.calls.map((call) => call[0])).toEqual([
      'managed_storage_gateway',
      'managed_storage',
    ]);
    expect(tunnelProxy.disposeCluster).toHaveBeenCalledWith(relayRow.id);
    expect(lifecycle.dispatchDelete).toHaveBeenCalledWith(expect.objectContaining({ id: relayRow.id }), 'user-1');
    expect(callOrder).toEqual(['revokeRoute', 'revokeEndpoint', 'disposeCluster', 'dispatchDelete']);
  });

  it('relayEnabled:true delete still disposes the proxy and runs dispatchDelete when the remove-target dispatch throws', async () => {
    // sendCommand THROWS (not success:false) when the node is mid-reconnect or
    // the command times out. That must not abort the delete: the row is already
    // claimed `deleting`, so the loopback listener must still be disposed and
    // dispatchDelete must still run (it tears the container down regardless).
    const relayRow = { ...existingRow, relayEnabled: true };
    const { db } = fakeDb({ existingRow: relayRow });
    const nodeDispatch = fakeNodeDispatch({
      sendDockerStorageTargetCommand: vi.fn().mockRejectedValue(new Error('node offline')),
    });
    const tunnelProxy = fakeTunnelProxy();
    const store = fakeStore({
      claimOperation: vi.fn().mockResolvedValue({ ...relayRow, status: 'deleting', updatedById: 'user-1' }),
    });
    const lifecycle = fakeLifecycle({ dispatchDelete: vi.fn().mockResolvedValue({ ok: true }) });
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      nodeDispatch as never,
      fakeProvider(),
      {} as never,
      store,
      fakeDispatch(),
      lifecycle,
      fakeMemberStore(),
      tunnelProxy as never
    );

    await service.delete(relayRow.id, 'user-1');

    expect(tunnelProxy.disposeCluster).toHaveBeenCalledWith(relayRow.id);
    expect(lifecycle.dispatchDelete).toHaveBeenCalledWith(expect.objectContaining({ id: relayRow.id }), 'user-1');
  });

  it('direct cluster deletion still disposes owned tunnel state', async () => {
    const { db } = fakeDb({ existingRow });
    const nodeDispatch = fakeNodeDispatch();
    const tunnelProxy = fakeTunnelProxy();
    const store = fakeStore({
      claimOperation: vi.fn().mockResolvedValue({ ...existingRow, status: 'deleting', updatedById: 'user-1' }),
    });
    const service = licensedStorageService(
      db as never,
      audit as never,
      cryptoService as never,
      nodeDispatch as never,
      fakeProvider(),
      {} as never,
      store,
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore(),
      tunnelProxy as never
    );

    await service.delete(existingRow.id, 'user-1');

    expect(nodeDispatch.sendDockerStorageTargetCommand).not.toHaveBeenCalled();
    expect(tunnelProxy.disposeCluster).toHaveBeenCalledWith('cluster-1');
  });
});

describe('ManagedStorageService IAM access keys', () => {
  const clusterRow = {
    id: 'cluster-1',
    nodeId: nodeRow.id,
    publishedPort: 9500,
    tlsEnabled: false,
  };

  const insertedKeyRow = {
    id: 'key-row-1',
    clusterId: 'cluster-1',
    accessKeyId: 'gw-generated-key',
    encryptedSecretKey: JSON.stringify({ encryptedKey: 'enc(gw-generated-secret)', encryptedDek: 'dek' }),
    name: 'app-key',
    createdById: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  function buildService(
    db: unknown,
    overrides: { nodeDispatch?: unknown; storageCA?: unknown; auditLog?: ReturnType<typeof vi.fn> } = {}
  ) {
    return licensedStorageService(
      db as never,
      { log: overrides.auditLog ?? vi.fn().mockResolvedValue(undefined) } as never,
      cryptoService as never,
      (overrides.nodeDispatch ?? fakeNodeDispatch()) as never,
      fakeProvider(),
      {} as never,
      fakeStore(),
      fakeDispatch(),
      fakeLifecycle(),
      fakeMemberStore(),
      fakeTunnelProxy() as never,
      (overrides.storageCA ?? fakeStorageCA()) as never
    );
  }

  it('createAccessKey (non-TLS cluster) dispatches create_key with root creds + publishedPort, no caPem/serverName', async () => {
    const { db } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const nodeDispatch = fakeNodeDispatch();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const service = buildService(db, { nodeDispatch, auditLog });

    const result = await service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1');

    expect(nodeDispatch.sendDockerStorageIamCommand).toHaveBeenCalledWith(
      clusterRow.nodeId,
      'create_key',
      clusterRow.id,
      expect.objectContaining({
        publishedPort: clusterRow.publishedPort,
        useTls: false,
        rootAccessKey: 'root-access-key',
        rootSecretKey: 'root-secret-password',
        name: 'app-key',
      })
    );
    const dispatchedOpts = vi.mocked(nodeDispatch.sendDockerStorageIamCommand).mock.calls[0]![3] as Record<
      string,
      unknown
    >;
    expect(dispatchedOpts.caPem).toBeFalsy();
    expect(dispatchedOpts.serverName).toBeFalsy();
    // The plaintext secret is returned exactly once, in this response — never persisted or logged in plaintext.
    expect(result).toMatchObject({ accessKeyId: 'gw-generated-key', secretKey: 'gw-generated-secret' });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storage.managed.iam.create', userId: 'user-1' })
    );
    const auditDetails = JSON.stringify(auditLog.mock.calls[0]![0].details);
    expect(auditDetails).not.toContain('gw-generated-secret');
  });

  it('createAccessKey with a future expiresAt dispatches it and persists it as a Date', async () => {
    const { db, values } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const nodeDispatch = fakeNodeDispatch();
    const service = buildService(db, { nodeDispatch });
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    await service.createAccessKey(clusterRow.id, { name: 'app-key', expiresAt }, 'user-1');

    const dispatchedOpts = vi.mocked(nodeDispatch.sendDockerStorageIamCommand).mock.calls[0]![3] as Record<
      string,
      unknown
    >;
    expect(dispatchedOpts.expiresAt).toBe(expiresAt);
    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues.expiresAt).toEqual(new Date(expiresAt));
  });

  it('createAccessKey without expiresAt persists null (no expiry)', async () => {
    const { db, values } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const service = buildService(db, { nodeDispatch: fakeNodeDispatch() });

    await service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1');

    const insertedValues = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues.expiresAt).toBeNull();
  });

  it('createAccessKey surfaces a 502 (not an unhandled error) when the node dispatch THROWS (node offline)', async () => {
    const { db, values } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const nodeDispatch = fakeNodeDispatch({
      sendDockerStorageIamCommand: vi.fn().mockRejectedValue(new Error('Node abc is not connected')),
    });
    const service = buildService(db, { nodeDispatch });

    await expect(service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1')).rejects.toMatchObject({
      statusCode: 502,
      code: 'MANAGED_STORAGE_IAM_CREATE_FAILED',
    });
    // No key row persisted when the dispatch never succeeded.
    expect(values).not.toHaveBeenCalled();
  });

  it('createAccessKey (TLS-enabled cluster) dispatches with useTls, the storage CA pem, and serverName=node serviceAddress (the endpoint identity, a cert SAN)', async () => {
    const tlsClusterRow = { ...clusterRow, tlsEnabled: true };
    const { db } = fakeIamDb({ clusterRow: tlsClusterRow, nodeRow, insertedKeyRow });
    const nodeDispatch = fakeNodeDispatch();
    const storageCA = fakeStorageCA();
    const service = buildService(db, { nodeDispatch, storageCA });

    await service.createAccessKey(tlsClusterRow.id, { name: 'app-key' }, 'user-1');

    expect(storageCA.getStorageCA).toHaveBeenCalled();
    expect(nodeDispatch.sendDockerStorageIamCommand).toHaveBeenCalledWith(
      tlsClusterRow.nodeId,
      'create_key',
      tlsClusterRow.id,
      expect.objectContaining({
        useTls: true,
        caPem: 'storage-ca-pem',
        serverName: nodeRow.serviceAddress ?? nodeRow.hostname,
      })
    );
  });

  it('createAccessKey persists the encrypted secret under the cluster and returns it exactly once', async () => {
    const { db, insert, values } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const service = buildService(db);

    await service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1');

    expect(insert).toHaveBeenCalledWith(managedStorageAccessKeys);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterId: clusterRow.id,
        accessKeyId: 'gw-generated-key',
        encryptedSecretKey: JSON.stringify({ encryptedKey: 'enc(gw-generated-secret)', encryptedDek: 'dek' }),
        name: 'app-key',
        createdById: 'user-1',
      })
    );
  });

  it('createAccessKey dispatches the built policy for the requested access level + bucket scope, and persists access/buckets on the row', async () => {
    const { db, values } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const nodeDispatch = fakeNodeDispatch();
    const service = buildService(db, { nodeDispatch });

    await service.createAccessKey(
      clusterRow.id,
      { name: 'app-key', access: 'read-only', buckets: ['artifacts'] },
      'user-1'
    );

    const expectedPolicy = buildManagedStoragePolicy('read-only', ['artifacts']);
    expect(nodeDispatch.sendDockerStorageIamCommand).toHaveBeenCalledWith(
      clusterRow.nodeId,
      'create_key',
      clusterRow.id,
      expect.objectContaining({ policy: expectedPolicy })
    );
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ access: 'read-only', buckets: ['artifacts'] }));
  });

  it('createAccessKey defaults to a read-write, all-buckets policy when access/buckets are omitted', async () => {
    const { db, values } = fakeIamDb({ clusterRow, nodeRow, insertedKeyRow });
    const nodeDispatch = fakeNodeDispatch();
    const service = buildService(db, { nodeDispatch });

    await service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1');

    const expectedPolicy = buildManagedStoragePolicy('read-write', []);
    expect(nodeDispatch.sendDockerStorageIamCommand).toHaveBeenCalledWith(
      clusterRow.nodeId,
      'create_key',
      clusterRow.id,
      expect.objectContaining({ policy: expectedPolicy })
    );
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ access: 'read-write', buckets: [] }));
  });

  it('createAccessKey does not persist a row (and does not audit-log) when the create_key dispatch fails', async () => {
    const { db, insert } = fakeIamDb({ clusterRow, nodeRow });
    const nodeDispatch = fakeNodeDispatch({
      sendDockerStorageIamCommand: vi.fn().mockResolvedValue({
        success: false,
        error: 'admin API unreachable',
        detail: '',
      }),
    });
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const service = buildService(db, { nodeDispatch, auditLog });

    await expect(service.createAccessKey(clusterRow.id, {}, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_IAM_CREATE_FAILED',
    });

    expect(insert).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('createAccessKey issues a compensating remove_key when the daemon create_key succeeds but the local insert throws, then rethrows the original error', async () => {
    // The daemon has already minted a live MinIO credential by this point —
    // an insert failure here (transient DB error/connection drop) must not
    // leave that credential unrevokable via the UI with zero Gateway record.
    const { db } = fakeIamDb({ clusterRow, nodeRow });
    const insertError = new Error('connection terminated unexpectedly');
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn().mockRejectedValue(insertError),
      })),
    } as never);
    const sendDockerStorageIamCommand = vi
      .fn()
      // 1st call: the original create_key dispatch (succeeds, mints the credential).
      .mockResolvedValueOnce({
        success: true,
        error: '',
        detail: JSON.stringify({ accessKey: 'gw-generated-key', secretKey: 'gw-generated-secret' }),
      })
      // 2nd call: the compensating remove_key dispatch.
      .mockResolvedValueOnce({ success: true, error: '', detail: '' });
    const nodeDispatch = fakeNodeDispatch({ sendDockerStorageIamCommand });
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const service = buildService(db, { nodeDispatch, auditLog });

    await expect(service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1')).rejects.toBe(insertError);

    expect(sendDockerStorageIamCommand).toHaveBeenCalledTimes(2);
    expect(sendDockerStorageIamCommand).toHaveBeenNthCalledWith(
      2,
      clusterRow.nodeId,
      'remove_key',
      clusterRow.id,
      expect.objectContaining({ targetAccessKey: 'gw-generated-key' })
    );
    // No audit log for a create that ultimately failed.
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('createAccessKey logs the accessKeyId loudly when BOTH the insert and the compensating remove_key fail (manual-cleanup breadcrumb)', async () => {
    const { db } = fakeIamDb({ clusterRow, nodeRow });
    const insertError = new Error('connection terminated unexpectedly');
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn().mockRejectedValue(insertError),
      })),
    } as never);
    const sendDockerStorageIamCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        error: '',
        detail: JSON.stringify({ accessKey: 'gw-generated-key', secretKey: 'gw-generated-secret' }),
      })
      // The compensating remove_key dispatch itself also fails.
      .mockResolvedValueOnce({ success: false, error: 'admin API unreachable', detail: '' });
    const nodeDispatch = fakeNodeDispatch({ sendDockerStorageIamCommand });
    const service = buildService(db, { nodeDispatch });
    const fakeLogger = createChildLogger('test') as unknown as { error: ReturnType<typeof vi.fn> };

    await expect(service.createAccessKey(clusterRow.id, { name: 'app-key' }, 'user-1')).rejects.toBe(insertError);

    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('orphaned'),
      expect.objectContaining({ accessKeyId: 'gw-generated-key', clusterId: clusterRow.id })
    );
  });

  it('listAccessKeys selects accessKeyId/name/access/buckets/createdAt for the cluster — never the encrypted secret column', async () => {
    const listedKeyRows = [
      {
        accessKeyId: 'gw-key-1',
        name: 'app-key',
        access: 'read-only',
        buckets: ['artifacts'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const { db, select } = fakeIamDb({ clusterRow, listedKeyRows });
    const service = buildService(db);

    const result = await service.listAccessKeys(clusterRow.id);

    expect(result).toEqual(listedKeyRows);
    const projection = select.mock.calls
      .map((call) => call[0] as Record<string, unknown> | undefined)
      .find((arg) => arg && 'accessKeyId' in arg);
    expect(projection).toBeDefined();
    expect(Object.keys(projection!)).toEqual(['accessKeyId', 'name', 'access', 'buckets', 'expiresAt', 'createdAt']);
    expect(JSON.stringify(result)).not.toContain('encryptedSecretKey');
    expect(JSON.stringify(result)).not.toContain('secretKey');
  });

  it('removeAccessKey dispatches remove_key with the target access key id and deletes the local row', async () => {
    const { db, delete: del, deleteWhere } = fakeIamDb({ clusterRow, nodeRow });
    const nodeDispatch = fakeNodeDispatch({
      sendDockerStorageIamCommand: vi.fn().mockResolvedValue({ success: true, error: '', detail: '' }),
    });
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const service = buildService(db, { nodeDispatch, auditLog });

    await service.removeAccessKey(clusterRow.id, 'gw-key-1', 'user-1');

    expect(nodeDispatch.sendDockerStorageIamCommand).toHaveBeenCalledWith(
      clusterRow.nodeId,
      'remove_key',
      clusterRow.id,
      expect.objectContaining({ targetAccessKey: 'gw-key-1' })
    );
    expect(del).toHaveBeenCalledWith(managedStorageAccessKeys);
    expect(deleteWhere).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storage.managed.iam.remove', userId: 'user-1' })
    );
  });

  it('removeAccessKey does not delete the local row when the remove_key dispatch fails', async () => {
    const { db, delete: del } = fakeIamDb({ clusterRow, nodeRow });
    const nodeDispatch = fakeNodeDispatch({
      sendDockerStorageIamCommand: vi.fn().mockResolvedValue({ success: false, error: 'not found', detail: '' }),
    });
    const service = buildService(db, { nodeDispatch });

    await expect(service.removeAccessKey(clusterRow.id, 'gw-key-1', 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_IAM_REMOVE_FAILED',
    });

    expect(del).not.toHaveBeenCalled();
  });
});
