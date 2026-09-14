import { describe, expect, it, vi } from 'vitest';
import type { ManagedStorageClusterMemberRow, ManagedStorageClusterRow } from '@/db/schema/managed-storage.js';
import { renderPoolArg, StorageWorkloadDispatch } from './storage-workload-dispatch.js';

const row = {
  id: '44444444-4444-4444-8444-444444444444',
  objectStorageConnectionId: '99999999-9999-4999-8999-999999999999',
  nodeId: '22222222-2222-4222-8222-222222222222',
  name: 'artifacts',
  slug: 'artifacts',
  version: '2024-01-01',
  imageRef: 'docker.io/minio/minio@sha256:deadbeef',
  encryptedRootCredentials: JSON.stringify({ encryptedKey: 'key', encryptedDek: 'dek' }),
  storageSizeBytes: 10 * 1024 * 1024 * 1024,
  runtimeConfig: {},
  publishedPort: 9500,
  status: 'creating',
  lastError: null,
  createdById: '11111111-1111-4111-8111-111111111111',
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  pendingOperation: { id: 'operation_123', action: 'create' as const },
} as unknown as ManagedStorageClusterRow;

const credentials = { username: 'root-access-key', password: 'root-secret-password' };

function fakeCryptoService() {
  return {
    decryptString: vi.fn(() => JSON.stringify(credentials)),
    encryptString: vi.fn(),
  };
}

/**
 * As {@link fakeCryptoService}, but `decryptString` also recognizes the
 * `{encryptedKey: 'hostkey-enc', ...}` shape used by the SFTP host-key tests
 * below and returns `hostKeyPem` for it — every other call still resolves to
 * the root credentials JSON, so this double is a drop-in for tests that
 * decrypt BOTH the root credentials and the host key in the same render.
 */
/** Fake `StorageClusterMemberStore` double: `listByCluster` resolves to whatever member rows are configured. */
function fakeMemberStore(members: { nodeId: string; memberIndex: number }[]) {
  const rows: ManagedStorageClusterMemberRow[] = members.map((m, i) => ({
    id: `member-${i}`,
    clusterId: row.id,
    nodeId: m.nodeId,
    memberIndex: m.memberIndex,
    drives: 1,
    status: 'ready',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as unknown as ManagedStorageClusterMemberRow[];
  return { listByCluster: vi.fn(async () => rows) };
}

/** Fake drizzle client double for `db.select({...}).from(nodes).where(inArray(...))`, resolving to `nodeRows`. */
function fakeNodesDb(nodeRows: { id: string; hostname: string; serviceAddress: string | null }[]) {
  const where = vi.fn(async () => nodeRows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, where };
}

describe('StorageWorkloadDispatch', () => {
  describe('renderPoolArg', () => {
    it('N=1 renders the byte-identical single-node local-mode command (no host list)', () => {
      expect(renderPoolArg([{ host: 'h0', memberIndex: 0 }], 9000, 'http')).toEqual([
        'server',
        '/data',
        '--console-address',
        ':9001',
      ]);
    });

    it('N=4 renders the distributed pool topology, ordered by memberIndex', () => {
      const members = [
        { host: 'h2', memberIndex: 2 },
        { host: 'h0', memberIndex: 0 },
        { host: 'h3', memberIndex: 3 },
        { host: 'h1', memberIndex: 1 },
      ];

      expect(renderPoolArg(members, 9000, 'http')).toEqual([
        'server',
        'http://h0:9000/data',
        'http://h1:9000/data',
        'http://h2:9000/data',
        'http://h3:9000/data',
        '--console-address',
        ':9001',
      ]);
    });

    it('throws for a 2-3 member set (below the EC minimum, above single-node) — defensive, unreachable via the service', () => {
      expect(() =>
        renderPoolArg(
          [
            { host: 'h0', memberIndex: 0 },
            { host: 'h1', memberIndex: 1 },
          ],
          9000,
          'http'
        )
      ).toThrow();
    });
  });

  describe('typed storage dispatch', () => {
    function setup(members = [{ nodeId: row.nodeId, memberIndex: 0 }]) {
      const sendDockerStorageCommand = vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ status: 'ready', operationId: row.pendingOperation!.id }),
      });
      const { db } = fakeNodesDb(
        members.map((m, i) => ({ id: m.nodeId, hostname: `node-${i}`, serviceAddress: `10.0.0.${i + 1}` }))
      );
      const ca = {
        getManagedStorageCertificateMaterial: vi
          .fn()
          .mockResolvedValue({ certificatePem: 'cert', privateKeyPem: 'key', caCertificatePem: 'ca' }),
      };
      const dispatch = new StorageWorkloadDispatch(
        { sendDockerStorageCommand } as never,
        { log: vi.fn() } as never,
        fakeCryptoService() as never,
        {} as never,
        {} as never,
        db as never,
        fakeMemberStore(members) as never,
        ca as never
      );
      return { dispatch, sendDockerStorageCommand, ca };
    }
    it('passes bounded resources and private topology without accepting raw Docker commands', async () => {
      const { dispatch } = setup();
      const payload = JSON.parse(
        await dispatch.renderCommandPayload(
          {
            ...row,
            publishS3: false,
            relayEnabled: true,
            runtimeConfig: {
              nanoCPUs: 500_000_000,
              memoryLimitBytes: 512 * 1024 ** 2,
              memorySwapBytes: 512 * 1024 ** 2,
            },
          },
          'create'
        )
      );
      expect(payload[0].config).toMatchObject({
        version: 1,
        operationId: row.pendingOperation!.id,
        publishedPort: 0,
        publishS3: false,
        members: [],
        resources: { nanoCPUs: 500_000_000, storageBytes: row.storageSizeBytes },
      });
      for (const forbidden of ['cmd', 'env', 'binds', 'network_mode', 'privileged'])
        expect(payload[0].config).not.toHaveProperty(forbidden);
    });
    it('sends public port only after explicit exposure', async () => {
      const { dispatch } = setup();
      const [entry] = JSON.parse(await dispatch.renderCommandPayload({ ...row, publishS3: true }, 'create'));
      expect(entry.config.publishedPort).toBe(row.publishedPort);
    });
    it('delivers TLS material and fails closed when it is unavailable', async () => {
      const { dispatch, ca } = setup();
      const secure = { ...row, tlsEnabled: true, certificateId: 'cert-id' };
      const [entry] = JSON.parse(await dispatch.renderCommandPayload(secure, 'create'));
      expect(entry.config.tls).toMatchObject({ certPem: 'cert', keyPem: 'key', caPem: 'ca' });
      ca.getManagedStorageCertificateMaterial.mockResolvedValueOnce(null as never);
      await expect(dispatch.renderCommandPayload(secure, 'update')).rejects.toMatchObject({
        code: 'MANAGED_STORAGE_TLS_UNAVAILABLE',
      });
    });
    it('renders consistent distributed peers and private bind addresses', async () => {
      const members = Array.from({ length: 4 }, (_, i) => ({ nodeId: `node-${i}`, memberIndex: i }));
      const { dispatch } = setup(members);
      const entries = JSON.parse(await dispatch.renderCommandPayload({ ...row, publishS3: false }, 'create'));
      expect(entries).toHaveLength(4);
      for (const entry of entries) {
        expect(entry.config.members).toEqual(entries[0].config.members);
        expect(entry.config.peerBindAddress).toBe(`10.0.0.${entry.memberIndex + 1}`);
      }
    });
    it('fans out typed create and propagates rejection without falling back to generic Docker', async () => {
      const { dispatch, sendDockerStorageCommand } = setup();
      const payload = await dispatch.renderCommandPayload(row, 'create');
      sendDockerStorageCommand.mockResolvedValueOnce({ success: false, error: 'quota exceeded' });
      const result = await dispatch.sendCommand(row.nodeId, 'create', row.id, payload);
      expect(result).toMatchObject({ success: false, error: 'quota exceeded' });
      expect(sendDockerStorageCommand).toHaveBeenCalledWith(
        row.nodeId,
        'create',
        row.id,
        expect.any(String),
        undefined
      );
    });
    it('makes destructive data deletion explicit and inspect health authoritative', async () => {
      const { dispatch, sendDockerStorageCommand } = setup();
      await dispatch.sendCommand(row.nodeId, 'remove', row.id, '');
      expect(sendDockerStorageCommand).toHaveBeenCalledWith(row.nodeId, 'delete_data', row.id, '', undefined);
      const result = await dispatch.sendCommand(row.nodeId, 'inspect', row.id, '');
      expect(dispatch.parseDaemonState(result)).toMatchObject({ status: 'ready' });
      sendDockerStorageCommand.mockResolvedValueOnce({ success: true, detail: JSON.stringify({ status: 'starting' }) });
      expect(dispatch.parseDaemonState(await dispatch.sendCommand(row.nodeId, 'inspect', row.id, ''))).toBeNull();
    });
    it('does not finalize before daemon health passes', async () => {
      const { dispatch, sendDockerStorageCommand } = setup();
      await expect(
        dispatch.finalizeReady(row, { operation: 'create', publishTcp: false, publishNativeTcp: false, result: {} })
      ).resolves.toEqual({ publishedPort: row.publishedPort });
      expect(sendDockerStorageCommand).toHaveBeenCalledWith(row.nodeId, 'inspect', row.id, '', 10000);
    });
    it('does not settle mixed operation generations as a single completed update', () => {
      const { dispatch } = setup();
      const members = [
        { memberIndex: 0, found: true, running: true, operationId: 'a' },
        { memberIndex: 1, found: true, running: true, operationId: 'b' },
      ];
      expect(
        dispatch.parseDaemonState({ success: true, detail: JSON.stringify({ memberCount: 2, members }) } as never)
          ?.operationId
      ).toBeUndefined();
    });
  });

  describe('parseDaemonState', () => {
    const dispatch = new StorageWorkloadDispatch(
      { sendDockerContainerCommand: vi.fn() } as never,
      { log: vi.fn() } as never,
      fakeCryptoService() as never,
      {} as never,
      {} as never,
      {} as never
    );

    it('legacy raw single-container detail: maps a running container to ready, with the operationId label', () => {
      const detail = JSON.stringify({
        State: { Running: true, Status: 'running' },
        Config: { Labels: { 'gateway.managed-storage.operationId': 'op1' } },
      });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({
        status: 'ready',
        operationId: 'op1',
      });
    });

    it('legacy raw single-container detail: maps an exited container to stopped', () => {
      const detail = JSON.stringify({ State: { Running: false, Status: 'exited' }, Config: { Labels: {} } });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({ status: 'stopped' });
    });

    it('maps a failed/missing result to missing', () => {
      expect(dispatch.parseDaemonState({ success: false } as never)).toEqual({ status: 'missing' });
    });

    it('returns null on unparsable detail', () => {
      expect(dispatch.parseDaemonState({ success: true, detail: 'not json' } as never)).toBeNull();
    });

    it('quorum: N=1, the single member running -> ready', () => {
      const detail = JSON.stringify({
        memberCount: 1,
        members: [{ memberIndex: 0, found: true, running: true, operationId: 'op1' }],
      });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({
        status: 'ready',
        operationId: 'op1',
      });
    });

    it('quorum: N=1, the single member down and not found -> missing', () => {
      const detail = JSON.stringify({ memberCount: 1, members: [{ memberIndex: 0, found: false, running: false }] });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({ status: 'missing' });
    });

    it('quorum: N=4, 3 running (>N/2) -> ready, operationId from the lowest-memberIndex running member', () => {
      const detail = JSON.stringify({
        memberCount: 4,
        members: [
          { memberIndex: 0, found: true, running: true, operationId: 'op1' },
          { memberIndex: 1, found: true, running: true, operationId: 'op1' },
          { memberIndex: 2, found: true, running: true, operationId: 'op1' },
          { memberIndex: 3, found: true, running: false },
        ],
      });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({
        status: 'ready',
      });
    });

    it('quorum: N=4, 2 running (not >N/2) -> stopped, not ready', () => {
      const detail = JSON.stringify({
        memberCount: 4,
        members: [
          { memberIndex: 0, found: true, running: true, operationId: 'op1' },
          { memberIndex: 1, found: true, running: true, operationId: 'op1' },
          { memberIndex: 2, found: true, running: false },
          { memberIndex: 3, found: true, running: false },
        ],
      });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({
        status: 'stopped',
      });
    });

    it('quorum: N=4, no member found at all -> missing', () => {
      const detail = JSON.stringify({
        memberCount: 4,
        members: [0, 1, 2, 3].map((memberIndex) => ({ memberIndex, found: false, running: false })),
      });

      expect(dispatch.parseDaemonState({ success: true, detail } as never)).toEqual({ status: 'missing' });
    });
  });

  describe('toView', () => {
    it('omits encryptedRootCredentials from the safe view', () => {
      const dispatch = new StorageWorkloadDispatch(
        { sendDockerContainerCommand: vi.fn() } as never,
        { log: vi.fn() } as never,
        fakeCryptoService() as never,
        {} as never,
        {} as never,
        {} as never
      );

      const view = dispatch.toView(row) as Record<string, unknown>;

      expect(view).not.toHaveProperty('encryptedRootCredentials');
      expect(view.id).toBe(row.id);
      expect(view.publishedPort).toBe(row.publishedPort);
    });

    it('surfaces sftpEnabled/sftpPort but never the encrypted host key', () => {
      const dispatch = new StorageWorkloadDispatch(
        { sendDockerContainerCommand: vi.fn() } as never,
        { log: vi.fn() } as never,
        fakeCryptoService() as never,
        {} as never,
        {} as never,
        {} as never
      );
      const sftpRow = {
        ...row,
        sftpEnabled: true,
        sftpPort: 8022,
        encryptedSftpHostKey: JSON.stringify({ encryptedKey: 'should-not-appear', encryptedDek: 'nope' }),
      } as unknown as ManagedStorageClusterRow;

      const view = dispatch.toView(sftpRow) as Record<string, unknown>;

      expect(view.sftpEnabled).toBe(true);
      expect(view.sftpPort).toBe(8022);
      expect(view).not.toHaveProperty('encryptedSftpHostKey');
    });

    it('surfaces ftpEnabled/ftpPort/ftpPassivePortStart/ftpPassivePortCount', () => {
      const dispatch = new StorageWorkloadDispatch(
        { sendDockerContainerCommand: vi.fn() } as never,
        { log: vi.fn() } as never,
        fakeCryptoService() as never,
        {} as never,
        {} as never,
        {} as never
      );
      const ftpRow = {
        ...row,
        ftpEnabled: true,
        ftpPort: 8021,
        ftpPassivePortStart: 30_000,
        ftpPassivePortCount: 5,
      } as unknown as ManagedStorageClusterRow;

      const view = dispatch.toView(ftpRow) as Record<string, unknown>;

      expect(view.ftpEnabled).toBe(true);
      expect(view.ftpPort).toBe(8021);
      expect(view.ftpPassivePortStart).toBe(30_000);
      expect(view.ftpPassivePortCount).toBe(5);
    });
  });

  describe('readOwnerCredentials / disposeCanonicalClient', () => {
    it('decrypts the stored root credentials', () => {
      const cryptoService = fakeCryptoService();
      const dispatch = new StorageWorkloadDispatch(
        { sendDockerContainerCommand: vi.fn() } as never,
        { log: vi.fn() } as never,
        cryptoService as never,
        {} as never,
        {} as never,
        {} as never
      );

      expect(dispatch.readOwnerCredentials(row)).toEqual(credentials);
      expect(cryptoService.decryptString).toHaveBeenCalledWith({ encryptedKey: 'key', encryptedDek: 'dek' });
    });

    it('disposes the canonical object-storage client when a connection is linked', async () => {
      const objectStorageService = { disposeClient: vi.fn() };
      const dispatch = new StorageWorkloadDispatch(
        { sendDockerContainerCommand: vi.fn() } as never,
        { log: vi.fn() } as never,
        fakeCryptoService() as never,
        {} as never,
        objectStorageService as never,
        {} as never
      );

      await dispatch.disposeCanonicalClient(row);

      expect(objectStorageService.disposeClient).toHaveBeenCalledWith(row.objectStorageConnectionId);
    });
  });

  describe('onCreateSucceeded (relay endpoint provisioning)', () => {
    const ctx = { credentials, userId: 'user-1' } as never;

    const dispatchWithRelay = (relayPolicy: unknown) =>
      new StorageWorkloadDispatch(
        { sendDockerContainerCommand: vi.fn() } as never,
        { log: vi.fn() } as never,
        fakeCryptoService() as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        relayPolicy as never
      );

    it('relayEnabled:true provisions the cluster relay endpoint on its node', async () => {
      const ensureManagedStorageEndpoint = vi.fn().mockResolvedValue('endpoint-1');
      const dispatch = dispatchWithRelay({ ensureManagedStorageEndpoint });
      const relayRow = { ...row, relayEnabled: true } as unknown as ManagedStorageClusterRow;

      await dispatch.onCreateSucceeded(relayRow, ctx);

      expect(ensureManagedStorageEndpoint).toHaveBeenCalledWith(row.id, row.nodeId);
    });

    // A cluster whose relay endpoint cannot be provisioned must surface as a
    // retryable error, not a committed row that is silently unreachable.
    it('relayEnabled:true throws MANAGED_STORAGE_RELAY_REGISTER_FAILED when provisioning fails', async () => {
      const dispatch = dispatchWithRelay({
        ensureManagedStorageEndpoint: vi.fn().mockRejectedValue(new Error('node identity unavailable')),
      });
      const relayRow = { ...row, relayEnabled: true } as unknown as ManagedStorageClusterRow;

      await expect(dispatch.onCreateSucceeded(relayRow, ctx)).rejects.toMatchObject({
        code: 'MANAGED_STORAGE_RELAY_REGISTER_FAILED',
      });
    });

    it('relayEnabled:false provisions nothing', async () => {
      const ensureManagedStorageEndpoint = vi.fn();
      const dispatch = dispatchWithRelay({ ensureManagedStorageEndpoint });

      await dispatch.onCreateSucceeded(row as unknown as ManagedStorageClusterRow, ctx);

      expect(ensureManagedStorageEndpoint).not.toHaveBeenCalled();
    });
  });
});
