import { describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE } from '@/config/env.js';
import { ManagedStorageBindingsService } from './managed-storage-bindings.service.js';

const CLUSTER_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_NODE_ID = '33333333-3333-4333-8333-333333333333';

const cluster = {
  id: CLUSTER_ID,
  nodeId: NODE_ID,
  status: 'ready' as const,
  pendingOperation: null,
  tlsEnabled: false,
  publishedPort: 9000,
  encryptedRootCredentials: JSON.stringify({ encryptedKey: 'k', encryptedDek: 'd' }),
};

const input = {
  targetNodeId: TARGET_NODE_ID,
  targetType: 'container' as const,
  targetResourceId: 'app-container',
  environment: { endpoint: 'S3_ENDPOINT', accessKeyId: 'S3_KEY', secretAccessKey: 'S3_SECRET' },
  buckets: ['assets'],
};

function fakeDb(overrides: Record<string, unknown> = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const row = () => ({
    id: '44444444-4444-4444-8444-444444444444',
    clusterId: CLUSTER_ID,
    targetNodeId: TARGET_NODE_ID,
    targetType: 'container',
    targetResourceId: 'app-container',
    networkName: 'gateway-storage-abc',
    connectorName: 'gateway-storage-connector-abc',
    connectorAlias: 'storage-abc',
    environment: input.environment,
    buckets: ['assets'],
    accessKeyId: null,
    status: 'creating',
    lastError: null,
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    updatedAt: new Date('2026-08-10T00:00:00.000Z'),
  });
  const db: Record<string, any> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([cluster]),
          orderBy: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: vi.fn().mockResolvedValue([{ ...row(), ...values }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updated.push(values);
        return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...row(), ...values }]) })) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    ...overrides,
  };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) =>
    callback({
      ...db,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Object.assign(Promise.resolve([]), { for: vi.fn().mockResolvedValue([cluster]) })),
        })),
      })),
    })
  );
  return { db, inserted, updated };
}

const ok = { success: true, detail: '{}', error: '' };

function makeService(dispatchOverrides: Record<string, unknown> = {}, dbOverrides = {}) {
  const { db, updated } = fakeDb(dbOverrides);
  const nodeDispatch = {
    sendDockerStorageIamCommand: vi
      .fn()
      .mockResolvedValue({ success: true, detail: JSON.stringify({ accessKey: 'AK', secretKey: 'SK' }), error: '' }),
    sendRelayGrantBundle: vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ storageSocketPath: '/run/gw/storage-connector/storage-relay.sock' }),
      error: '',
    }),
    sendDockerNetworkCommand: vi.fn().mockResolvedValue(ok),
    sendDockerImageCommand: vi.fn().mockResolvedValue(ok),
    sendDockerContainerCommand: vi
      .fn()
      .mockResolvedValue({ success: true, detail: JSON.stringify({ id: 'abcdef123456' }), error: '' }),
    ...dispatchOverrides,
  };
  const relayPolicy = {
    ensureStorageBindingRoute: vi.fn().mockResolvedValue('route-1'),
    getNodeGrantBundle: vi.fn().mockResolvedValue({}),
    revokeOwner: vi.fn().mockResolvedValue(undefined),
  };
  const dockerSecrets = {
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    deleteOwned: vi.fn(),
    getDecryptedMap: vi.fn(async () => ({ S3_ENDPOINT: 'http://storage-abc:9000', S3_KEY: 'AK', S3_SECRET: 'SK' })),
    getSecretKeys: vi.fn(async () => new Set<string>()),
  };
  let runtime = 0;
  const dockerManagement = {
    updateContainerEnv: vi.fn(async () => {
      runtime++;
    }),
    getContainerEnv: vi.fn(async () => ['KEEP=value']),
    inspectUserContainer: vi.fn(async () => ({
      Name: '/app-container',
      Id: `runtime-${runtime}`,
      State: { Status: 'running' },
      Config: { Env: ['KEEP=value'] },
    })),
  };
  const dockerDeployments = {
    get: vi.fn(async () => ({ desiredConfig: { env: {} }, slots: [] })),
    setManagedStorageBindingNetwork: vi.fn(),
  };
  const service = new ManagedStorageBindingsService(
    db as never,
    { log: vi.fn() } as never,
    { decryptString: vi.fn(() => JSON.stringify({ username: 'root', password: 'rootpass' })) } as never,
    nodeDispatch as never,
    dockerManagement as never,
    dockerDeployments as never,
    dockerSecrets as never,
    DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE,
    relayPolicy as never
  );
  service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
  return { service, nodeDispatch, relayPolicy, dockerSecrets, dockerManagement, dockerDeployments, updated };
}

describe('ManagedStorageBindingsService', () => {
  it('issues an access key scoped to the binding buckets, not the whole cluster', async () => {
    const { service, nodeDispatch } = makeService();

    await service.create(CLUSTER_ID, input, 'user-1');

    const [, action, , opts] = nodeDispatch.sendDockerStorageIamCommand.mock.calls[0]!;
    expect(action).toBe('create_key');
    const policy = JSON.parse((opts as { policy: string }).policy) as {
      Statement: Array<{ Action: string[]; Resource: string[] }>;
    };
    expect(JSON.stringify(policy.Statement)).toContain('assets');
    // ListAllMyBuckets is deliberately account-wide so an SDK can enumerate;
    // what must never be wildcarded is object access itself.
    const objectStatements = policy.Statement.filter((statement) =>
      statement.Action.some((action) => action.startsWith('s3:GetObject') || action.startsWith('s3:PutObject'))
    );
    expect(objectStatements.length).toBeGreaterThan(0);
    for (const statement of objectStatements) {
      expect(statement.Resource.every((resource) => resource.includes('assets'))).toBe(true);
    }
  });

  it('injects the connector alias as the endpoint, never the cluster host', async () => {
    const { service, dockerSecrets } = makeService();

    await service.create(CLUSTER_ID, input, 'user-1');

    const written = Object.fromEntries(dockerSecrets.create.mock.calls.map((call) => [call[2], call[3]])) as Record<
      string,
      string
    >;
    // The endpoint must be the per-binding connector alias inside the private
    // network — never the cluster's node address, which would defeat the point.
    expect(written.S3_ENDPOINT).toMatch(/^http:\/\/storage-[0-9a-f]{16}:9000$/);
    expect(written.S3_KEY).toBe('AK');
    expect(written.S3_SECRET).toBe('SK');
  });

  // A half-provisioned binding must not leave a live credential behind: the
  // key is created first, so every later failure has to revoke it.
  it('revokes the issued key and the route when the connector fails to start', async () => {
    const { service, nodeDispatch, relayPolicy } = makeService({
      sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: false, error: 'no such image', detail: '' }),
    });

    await expect(service.create(CLUSTER_ID, input, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_FAILED',
    });

    const removeCall = nodeDispatch.sendDockerStorageIamCommand.mock.calls.find(
      ([, action]) => action === 'remove_key'
    );
    expect(removeCall).toBeDefined();
    expect((removeCall![3] as { targetAccessKey: string }).targetAccessKey).toBe('AK');
    expect(relayPolicy.revokeOwner).toHaveBeenCalledWith('managed_storage_binding', expect.any(String));
  });

  it('records the failure on the binding instead of leaving it creating', async () => {
    const { service, updated } = makeService({
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: false, error: 'node offline', detail: '' }),
    });

    await expect(service.create(CLUSTER_ID, input, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_FAILED',
    });
    expect(updated.at(-1)).toMatchObject({ status: 'error', lastError: expect.stringContaining('node offline') });
  });

  it('refuses to bind when the connector image is not digest pinned', async () => {
    const { db } = fakeDb();
    const service = new ManagedStorageBindingsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      'registry/gateway/workload-connector:latest'
    );
    service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);

    await expect(service.create(CLUSTER_ID, input, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_CONNECTOR_UNAVAILABLE',
    });
  });

  it('fails closed before creating a binding when license policy wiring is missing', async () => {
    const { service } = makeService();
    (service as unknown as { licensePolicy?: unknown }).licensePolicy = undefined;

    await expect(service.create(CLUSTER_ID, input, 'user-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('storage binding ownership and target mutations', () => {
  it('rejects user secret collisions before issuing an IAM key', async () => {
    const { service, dockerSecrets, nodeDispatch } = makeService();
    dockerSecrets.getSecretKeys.mockResolvedValue(new Set(['S3_KEY']));
    await expect(service.create(CLUSTER_ID, input, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_ENV_CONFLICT',
    });
    expect(nodeDispatch.sendDockerStorageIamCommand).not.toHaveBeenCalled();
  });
  it('uses the submitted final Environment draft when replacing an ordinary variable with a secure link', async () => {
    const { service, dockerManagement } = makeService();
    dockerManagement.getContainerEnv.mockResolvedValue(['KEEP=value', 'S3_ENDPOINT=legacy-endpoint']);
    await expect(
      service.create(CLUSTER_ID, { ...input, targetEnvironment: { KEEP: 'value' } }, 'user-1')
    ).resolves.toBeDefined();
    expect(dockerManagement.updateContainerEnv).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'app-container',
      { KEEP: 'value' },
      expect.arrayContaining(['S3_ENDPOINT']),
      'user-1'
    );
  });
  it('restores the previous ordinary Environment after a late storage-link failure', async () => {
    const { service, dockerManagement } = makeService();
    dockerManagement.getContainerEnv.mockResolvedValue(['KEEP=old', 'S3_ENDPOINT=legacy-endpoint']);
    const subject = service as unknown as {
      setStatus: (
        id: string,
        status: string,
        error: string | null,
        userId: string,
        accessKeyId?: string
      ) => Promise<unknown>;
    };
    const originalSetStatus = subject.setStatus.bind(service);
    subject.setStatus = vi.fn(async (id, status, error, userId, accessKeyId) => {
      if (status === 'ready') throw new Error('status persistence failed');
      return originalSetStatus(id, status, error, userId, accessKeyId);
    });

    await expect(
      service.create(CLUSTER_ID, { ...input, targetEnvironment: { KEEP: 'new' } }, 'user-1')
    ).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_FAILED',
    });

    expect(dockerManagement.updateContainerEnv).toHaveBeenNthCalledWith(
      1,
      TARGET_NODE_ID,
      'app-container',
      { KEEP: 'new' },
      expect.arrayContaining(['S3_ENDPOINT']),
      'user-1'
    );
    expect(dockerManagement.updateContainerEnv).toHaveBeenNthCalledWith(
      2,
      TARGET_NODE_ID,
      'app-container',
      { KEEP: 'old' },
      expect.arrayContaining(['S3_ENDPOINT', 'S3_KEY', 'S3_SECRET']),
      'user-1'
    );
  });
  it('uses the storage-specific deployment network path and compensates owned secrets on rollout failure', async () => {
    const { service, dockerSecrets, dockerDeployments } = makeService();
    dockerDeployments.setManagedStorageBindingNetwork.mockRejectedValueOnce(new Error('rollout failed'));
    await expect(service.create(CLUSTER_ID, { ...input, targetType: 'deployment' }, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_FAILED',
    });
    expect(dockerDeployments.setManagedStorageBindingNetwork).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'app-container',
      expect.stringMatching(/^gateway-storage-[a-f0-9]{16}$/),
      true,
      'user-1',
      undefined
    );
    expect(dockerSecrets.create).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'deployment:app-container',
      'S3_KEY',
      'AK',
      'user-1',
      { managed: true, managedOwner: expect.stringMatching(/^storage-binding:/) }
    );
    expect(dockerSecrets.deleteOwned).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'deployment:app-container',
      expect.stringMatching(/^storage-binding:/),
      'user-1'
    );
    expect(dockerSecrets.delete).not.toHaveBeenCalled();
  });
  it('restores deployment secrets and network without revoking route or IAM when rollback cannot remove the target', async () => {
    const { service, dockerSecrets, dockerDeployments, nodeDispatch, relayPolicy } = makeService();
    dockerDeployments.setManagedStorageBindingNetwork.mockImplementation(async (_node, _target, _network, attached) => {
      if (!attached) throw new Error('rollback rollout failed');
    });
    const subject = service as unknown as { setStatus: (...args: unknown[]) => Promise<unknown> };
    const originalSetStatus = subject.setStatus.bind(service);
    subject.setStatus = vi.fn(async (_id, status, ...rest) => {
      if (status === 'ready') throw new Error('late status persistence failed');
      return originalSetStatus(_id, status, ...rest);
    });

    await expect(service.create(CLUSTER_ID, { ...input, targetType: 'deployment' }, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_FAILED',
    });

    expect(dockerSecrets.getDecryptedMap.mock.invocationCallOrder[0]).toBeLessThan(
      dockerSecrets.deleteOwned.mock.invocationCallOrder[0]!
    );
    expect(dockerSecrets.create).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'deployment:app-container',
      'S3_KEY',
      'AK',
      'user-1',
      expect.objectContaining({ managedOwner: expect.stringMatching(/^storage-binding:/) })
    );
    expect(dockerDeployments.setManagedStorageBindingNetwork).toHaveBeenLastCalledWith(
      TARGET_NODE_ID,
      'app-container',
      expect.any(String),
      true,
      'user-1',
      {}
    );
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalled();
    expect(nodeDispatch.sendDockerStorageIamCommand.mock.calls.some(([, action]) => action === 'remove_key')).toBe(
      false
    );
  });
  it('restores standalone secrets and network when target disconnect fails', async () => {
    const { service, dockerSecrets, nodeDispatch, relayPolicy } = makeService({
      sendDockerNetworkCommand: vi.fn(async (_node, action) =>
        action === 'disconnect' ? { success: false, error: 'disconnect failed', detail: '' } : ok
      ),
    });
    const subject = service as unknown as { setStatus: (...args: unknown[]) => Promise<unknown> };
    const originalSetStatus = subject.setStatus.bind(service);
    subject.setStatus = vi.fn(async (_id, status, ...rest) => {
      if (status === 'ready') throw new Error('late status persistence failed');
      return originalSetStatus(_id, status, ...rest);
    });
    const dockerManagement = (
      service as unknown as { dockerManagement: { inspectUserContainer: ReturnType<typeof vi.fn> } }
    ).dockerManagement;
    vi.spyOn(service as any, 'updateTargetEnvironment').mockResolvedValue(undefined);
    dockerManagement.inspectUserContainer.mockResolvedValue({
      Name: '/app-container',
      Id: 'runtime',
      State: { Status: 'running' },
      NetworkSettings: { Networks: { 'gateway-storage-abc': {} } },
    });

    await expect(service.create(CLUSTER_ID, input, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_STORAGE_BINDING_FAILED',
    });

    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenCalledWith(TARGET_NODE_ID, 'connect', {
      networkId: expect.any(String),
      containerId: 'app-container',
    });
    expect(dockerSecrets.create.mock.calls.filter(([, , key]) => key === 'S3_SECRET')).toHaveLength(2);
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalled();
    expect(nodeDispatch.sendDockerStorageIamCommand.mock.calls.some(([, action]) => action === 'remove_key')).toBe(
      false
    );
  });
  it('runs every restore step after a late container recreation convergence failure', async () => {
    const { service, dockerSecrets, nodeDispatch } = makeService();
    const inner = service as unknown as {
      removeTargetBinding: (binding: unknown, user: string) => Promise<void>;
      updateTargetEnvironment: ReturnType<typeof vi.fn>;
      dockerManagement: { inspectUserContainer: ReturnType<typeof vi.fn> };
    };
    inner.dockerManagement.inspectUserContainer.mockResolvedValue({
      Name: '/app-container',
      Id: 'runtime',
      State: { Status: 'running' },
      NetworkSettings: { Networks: { 'gateway-storage-test': {} } },
    });
    vi.spyOn(inner, 'updateTargetEnvironment')
      .mockRejectedValueOnce(new Error('late convergence failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      inner.removeTargetBinding(
        {
          id: 'binding',
          targetType: 'container',
          targetNodeId: TARGET_NODE_ID,
          targetResourceId: 'app-container',
          networkName: 'gateway-storage-test',
          environment: input.environment,
        },
        'user'
      )
    ).rejects.toThrow('late convergence failed');

    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenLastCalledWith(TARGET_NODE_ID, 'connect', {
      networkId: 'gateway-storage-test',
      containerId: 'app-container',
    });
    expect(dockerSecrets.create).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'app-container',
      'S3_SECRET',
      'SK',
      'user',
      expect.objectContaining({ managedOwner: 'storage-binding:binding' })
    );
    expect(inner.updateTargetEnvironment).toHaveBeenCalledTimes(2);
  });
  it('restores the original running state when the failed replacement is only created', async () => {
    const { service, nodeDispatch } = makeService();
    const inner = service as unknown as {
      removeTargetBinding: (binding: unknown, user: string) => Promise<void>;
      updateTargetEnvironment: (...args: unknown[]) => Promise<void>;
      dockerManagement: { inspectUserContainer: ReturnType<typeof vi.fn> };
    };
    const originalUpdate = inner.updateTargetEnvironment.bind(service);
    const update = vi
      .spyOn(inner, 'updateTargetEnvironment')
      .mockRejectedValueOnce(new Error('late convergence failed'))
      .mockImplementationOnce(originalUpdate);
    inner.dockerManagement.inspectUserContainer
      .mockResolvedValueOnce({
        Name: '/app-container',
        Id: 'old-running',
        State: { Status: 'running' },
        NetworkSettings: { Networks: { 'gateway-storage-test': {} } },
      })
      .mockResolvedValueOnce({ Name: '/app-container', Id: 'replacement', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Name: '/app-container', Id: 'replacement', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Name: '/app-container', Id: 'replacement', State: { Status: 'running' } });

    await expect(
      inner.removeTargetBinding(
        {
          id: 'binding',
          targetType: 'container',
          targetNodeId: TARGET_NODE_ID,
          targetResourceId: 'app-container',
          networkName: 'gateway-storage-test',
          environment: input.environment,
        },
        'user'
      )
    ).rejects.toThrow('late convergence failed');

    expect(update).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      'user',
      expect.anything(),
      'running'
    );
    expect(nodeDispatch.sendDockerContainerCommand).toHaveBeenCalledWith(TARGET_NODE_ID, 'start', {
      containerId: 'replacement',
    });
  });
  it('applies the ordinary Environment draft while protecting managed names', async () => {
    const { service, dockerManagement } = makeService();
    await service.create(CLUSTER_ID, { ...input, targetEnvironment: { NEW: 'draft' } }, 'user-1');
    expect(dockerManagement.updateContainerEnv).toHaveBeenCalledWith(
      TARGET_NODE_ID,
      'app-container',
      { NEW: 'draft' },
      expect.arrayContaining(['KEEP', 'S3_KEY', 'S3_SECRET']),
      'user-1'
    );
  });
});

describe('storage unlink network ordering', () => {
  it('disconnects before recreating a standalone container so Docker does not retain a deleted primary network', async () => {
    const { service, nodeDispatch, dockerManagement } = makeService();
    const inner = service as unknown as { removeTargetBinding: (binding: unknown, user: string) => Promise<void> };
    await inner.removeTargetBinding(
      {
        id: 'binding',
        targetType: 'container',
        targetNodeId: TARGET_NODE_ID,
        targetResourceId: 'app-container',
        networkName: 'gateway-storage-test',
        environment: input.environment,
      },
      'user'
    );
    expect(nodeDispatch.sendDockerNetworkCommand.mock.invocationCallOrder[0]).toBeLessThan(
      dockerManagement.updateContainerEnv.mock.invocationCallOrder[0]!
    );
  });
});
