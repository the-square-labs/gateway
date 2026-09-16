import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingTargetRuntime } from './managed-database-binding-target-runtime.js';

const database = { id: 'database-1', nodeId: 'database-node', type: 'postgres' } as never;
const deploymentBinding = {
  id: 'binding-1',
  targetNodeId: 'app-node',
  targetType: 'deployment',
  targetResourceId: 'deployment-1',
  networkName: 'gateway-db-binding-1',
  connectorAlias: 'db-binding',
  environment: { connectionUri: 'DATABASE_URL' },
} as unknown as Parameters<ManagedDatabaseBindingTargetRuntime['apply']>[1];
const containerBinding = {
  ...deploymentBinding,
  targetType: 'container',
  targetResourceId: 'orders-api',
} as never;
const credentials = { username: 'app', password: 'secret', databaseName: 'orders' };
const connectionUri = 'postgresql://app:secret@db-binding:5432/orders';

function containerSubject(networks: Record<string, unknown> = {}) {
  const nodeDispatch = { sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }) };
  const dockerManagement = {
    inspectContainer: vi.fn().mockResolvedValue({
      Name: '/orders-api',
      Id: 'runtime-before',
      State: { Status: 'running' },
      NetworkSettings: { Networks: networks },
    }),
    getContainerEnv: vi.fn(),
    updateContainerEnv: vi.fn().mockResolvedValue({ name: 'orders-api' }),
    startContainer: vi.fn().mockResolvedValue(undefined),
  };
  const dockerSecrets = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'secret-created' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const subject = new ManagedDatabaseBindingTargetRuntime(
    {} as never,
    nodeDispatch as never,
    dockerManagement as never,
    {} as never,
    dockerSecrets as never
  );
  return { subject, nodeDispatch, dockerManagement, dockerSecrets };
}

describe('ManagedDatabaseBindingTargetRuntime deployment Environment propagation', () => {
  it('passes the submitted final ordinary draft into the deployment binding rollout', async () => {
    const dockerDeployments = { setManagedDatabaseBindingNetwork: vi.fn().mockResolvedValue(undefined) };
    const dockerSecrets = { create: vi.fn().mockResolvedValue(undefined), deleteOwned: vi.fn() };
    const subject = new ManagedDatabaseBindingTargetRuntime(
      {} as never,
      {} as never,
      {} as never,
      dockerDeployments as never,
      dockerSecrets as never
    );

    await subject.apply(database, deploymentBinding, credentials, 'user-1', {
      targetEnvironment: { KEEP: 'new' },
    });

    expect(dockerDeployments.setManagedDatabaseBindingNetwork).toHaveBeenCalledWith(
      'app-node',
      'deployment-1',
      'gateway-db-binding-1',
      true,
      'user-1',
      false,
      { KEEP: 'new' }
    );
  });

  it('preserves the submitted final draft through reconciliation repair', async () => {
    const subject = new ManagedDatabaseBindingTargetRuntime(
      {} as never,
      { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const internal = subject as unknown as {
      ensureHostListener: ReturnType<typeof vi.fn>;
      validate: ReturnType<typeof vi.fn>;
      apply: ReturnType<typeof vi.fn>;
      performReconciliation: (
        database: unknown,
        binding: unknown,
        credentials: unknown,
        options: { targetEnvironment?: Record<string, string> }
      ) => Promise<void>;
    };
    internal.ensureHostListener = vi.fn().mockResolvedValue('172.20.0.1');
    internal.validate = vi.fn().mockRejectedValueOnce(new Error('binding missing'));
    internal.apply = vi.fn().mockResolvedValue(undefined);

    await internal.performReconciliation(database, deploymentBinding, credentials, {
      targetEnvironment: { KEEP: 'new' },
    });

    expect(internal.apply).toHaveBeenCalledWith(
      database,
      deploymentBinding,
      credentials,
      '00000000-0000-0000-0000-000000000000',
      {
        forceDeploymentRollout: true,
        targetEnvironment: { KEEP: 'new' },
      }
    );
  });
});

describe('ManagedDatabaseBindingTargetRuntime container compensation', () => {
  it.each([
    'apply',
    'remove',
  ] as const)('restores the old environment when %s update rejects before convergence', async (action) => {
    const { subject, dockerManagement } = containerSubject({ 'gateway-db-binding-1': {} });
    dockerManagement.getContainerEnv
      .mockResolvedValueOnce(['KEEP=old'])
      .mockResolvedValueOnce(['KEEP=old'])
      .mockResolvedValueOnce(['KEEP=new', 'ADDED=temporary']);
    dockerManagement.updateContainerEnv.mockRejectedValueOnce(new Error('update rejected'));
    const internal = subject as unknown as { waitForConvergence: ReturnType<typeof vi.fn> };
    internal.waitForConvergence = vi.fn().mockResolvedValue(undefined);

    await expect(
      subject[action](database, containerBinding, credentials, 'user-1', {
        targetEnvironment: { KEEP: 'new', ADDED: 'temporary' },
      })
    ).rejects.toThrow('update rejected');
    expect(dockerManagement.updateContainerEnv).toHaveBeenLastCalledWith(
      'app-node',
      'orders-api',
      { KEEP: 'old' },
      ['ADDED'],
      'user-1'
    );
  });

  it('restores Env, managed secrets, disconnected network, and running target after late apply convergence failure', async () => {
    const { subject, nodeDispatch, dockerManagement, dockerSecrets } = containerSubject();
    dockerManagement.getContainerEnv
      .mockResolvedValueOnce(['KEEP=old', 'DATABASE_URL=legacy'])
      .mockResolvedValueOnce(['KEEP=old', 'DATABASE_URL=legacy'])
      .mockResolvedValueOnce(['KEEP=new']);
    dockerManagement.inspectContainer
      .mockResolvedValueOnce({
        Name: '/orders-api',
        Id: 'runtime-before',
        State: { Status: 'running' },
        NetworkSettings: { Networks: {} },
      })
      .mockResolvedValueOnce({ Id: 'runtime-before', State: { Status: 'running' } })
      .mockResolvedValueOnce({ Id: 'runtime-forward', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Id: 'runtime-rollback', State: { Status: 'created' } });
    const internal = subject as unknown as {
      waitForConvergence: ReturnType<typeof vi.fn>;
      waitForRuntimeState: ReturnType<typeof vi.fn>;
    };
    internal.waitForConvergence = vi
      .fn()
      .mockRejectedValueOnce(new Error('late convergence failure'))
      .mockResolvedValueOnce(undefined);
    internal.waitForRuntimeState = vi.fn().mockResolvedValue(undefined);

    await expect(
      subject.apply(database, containerBinding, credentials, 'user-1', { targetEnvironment: { KEEP: 'new' } })
    ).rejects.toThrow('late convergence failure');

    expect(dockerSecrets.create).toHaveBeenCalledWith(
      'app-node',
      'orders-api',
      'DATABASE_URL',
      connectionUri,
      'user-1',
      { managed: true }
    );
    expect(dockerSecrets.delete).toHaveBeenCalledWith('secret-created', 'app-node', 'user-1', 'orders-api');
    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenNthCalledWith(1, 'app-node', 'connect', {
      networkId: 'gateway-db-binding-1',
      containerId: 'orders-api',
    });
    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenNthCalledWith(2, 'app-node', 'disconnect', {
      networkId: 'gateway-db-binding-1',
      containerId: 'orders-api',
    });
    expect(dockerManagement.updateContainerEnv).toHaveBeenNthCalledWith(
      1,
      'app-node',
      'orders-api',
      { KEEP: 'new' },
      ['DATABASE_URL'],
      'user-1'
    );
    expect(dockerManagement.updateContainerEnv).toHaveBeenNthCalledWith(
      2,
      'app-node',
      'orders-api',
      { KEEP: 'old', DATABASE_URL: 'legacy' },
      [],
      'user-1'
    );
    expect(internal.waitForConvergence).toHaveBeenNthCalledWith(
      1,
      'app-node',
      'orders-api',
      'runtime-before',
      'running'
    );
    expect(internal.waitForConvergence).toHaveBeenNthCalledWith(
      2,
      'app-node',
      'orders-api',
      'runtime-forward',
      'created'
    );
    expect(dockerManagement.startContainer).toHaveBeenCalledWith('app-node', 'runtime-rollback', 'user-1');
    expect(internal.waitForRuntimeState).toHaveBeenCalledWith('app-node', 'orders-api', 'runtime-rollback', 'running');
  });

  it('starts a rollback recreation when forward left an originally running target created', async () => {
    const { subject, dockerManagement } = containerSubject();
    dockerManagement.getContainerEnv.mockResolvedValue(['KEEP=new']);
    dockerManagement.inspectContainer
      .mockResolvedValueOnce({ Id: 'runtime-forward', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Id: 'runtime-rollback', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Id: 'runtime-rollback', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Id: 'runtime-rollback', State: { Status: 'running' } });
    const internal = subject as unknown as {
      updateContainerEnvironment: (
        binding: unknown,
        snapshot: unknown,
        environment: Record<string, string>,
        managedNames: string[],
        userId: string
      ) => Promise<void>;
    };

    await internal.updateContainerEnvironment(
      containerBinding,
      {
        environment: { KEEP: 'old' },
        networkAttached: false,
        name: 'orders-api',
        runtimeId: 'runtime-before',
        expectedState: 'running',
      },
      { KEEP: 'old' },
      [],
      'user-1'
    );

    expect(dockerManagement.startContainer).toHaveBeenCalledWith('app-node', 'runtime-rollback', 'user-1');
  });

  it('keeps an originally stopped target stopped after rollback recreation', async () => {
    const { subject, dockerManagement } = containerSubject();
    dockerManagement.getContainerEnv.mockResolvedValue(['KEEP=new']);
    dockerManagement.inspectContainer
      .mockResolvedValueOnce({ Id: 'runtime-forward', State: { Status: 'created' } })
      .mockResolvedValueOnce({ Id: 'runtime-rollback', State: { Status: 'created' } });
    const internal = subject as unknown as {
      updateContainerEnvironment: (
        binding: unknown,
        snapshot: unknown,
        environment: Record<string, string>,
        managedNames: string[],
        userId: string
      ) => Promise<void>;
    };

    await internal.updateContainerEnvironment(
      containerBinding,
      {
        environment: { KEEP: 'old' },
        networkAttached: false,
        name: 'orders-api',
        runtimeId: 'runtime-before',
        expectedState: 'created',
      },
      { KEEP: 'old' },
      [],
      'user-1'
    );

    expect(dockerManagement.startContainer).not.toHaveBeenCalled();
  });

  it('restores a pre-existing managed secret value after late apply convergence failure', async () => {
    const { subject, dockerManagement, dockerSecrets } = containerSubject();
    dockerManagement.getContainerEnv
      .mockResolvedValueOnce(['KEEP=old'])
      .mockResolvedValueOnce(['KEEP=old'])
      .mockResolvedValueOnce(['KEEP=new']);
    dockerSecrets.list.mockResolvedValueOnce([
      { id: 'secret-existing', key: 'DATABASE_URL', value: 'postgresql://previous' },
    ]);
    dockerSecrets.create
      .mockResolvedValueOnce({ id: 'secret-existing' })
      .mockResolvedValueOnce({ id: 'secret-existing' });
    const internal = subject as unknown as { waitForConvergence: ReturnType<typeof vi.fn> };
    internal.waitForConvergence = vi
      .fn()
      .mockRejectedValueOnce(new Error('late convergence failure'))
      .mockResolvedValueOnce(undefined);

    await expect(
      subject.apply(database, containerBinding, credentials, 'user-1', { targetEnvironment: { KEEP: 'new' } })
    ).rejects.toThrow('late convergence failure');

    expect(dockerSecrets.create).toHaveBeenNthCalledWith(
      2,
      'app-node',
      'orders-api',
      'DATABASE_URL',
      'postgresql://previous',
      'user-1',
      { managed: true }
    );
  });

  it('restores Env, managed secrets, attached network, and running target after late remove convergence failure', async () => {
    const { subject, nodeDispatch, dockerManagement, dockerSecrets } = containerSubject({ 'gateway-db-binding-1': {} });
    dockerManagement.getContainerEnv
      .mockResolvedValueOnce(['KEEP=old'])
      .mockResolvedValueOnce(['KEEP=old'])
      .mockResolvedValueOnce(['KEEP=new']);
    dockerSecrets.list.mockResolvedValueOnce([{ id: 'secret-existing', key: 'DATABASE_URL', value: connectionUri }]);
    const internal = subject as unknown as { waitForConvergence: ReturnType<typeof vi.fn> };
    internal.waitForConvergence = vi
      .fn()
      .mockRejectedValueOnce(new Error('late convergence failure'))
      .mockResolvedValueOnce(undefined);

    await expect(
      subject.remove(database, containerBinding, credentials, 'user-1', { targetEnvironment: { KEEP: 'new' } })
    ).rejects.toThrow('late convergence failure');

    expect(dockerSecrets.delete).toHaveBeenCalledWith('secret-existing', 'app-node', 'user-1', 'orders-api');
    expect(dockerSecrets.create).toHaveBeenCalledWith(
      'app-node',
      'orders-api',
      'DATABASE_URL',
      connectionUri,
      'user-1',
      { managed: true }
    );
    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenNthCalledWith(1, 'app-node', 'disconnect', {
      networkId: 'gateway-db-binding-1',
      containerId: 'orders-api',
    });
    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenNthCalledWith(2, 'app-node', 'connect', {
      networkId: 'gateway-db-binding-1',
      containerId: 'orders-api',
    });
    expect(dockerManagement.updateContainerEnv).toHaveBeenNthCalledWith(
      1,
      'app-node',
      'orders-api',
      { KEEP: 'new' },
      ['DATABASE_URL'],
      'user-1'
    );
    expect(dockerManagement.updateContainerEnv).toHaveBeenNthCalledWith(
      2,
      'app-node',
      'orders-api',
      { KEEP: 'old' },
      [],
      'user-1'
    );
    expect(internal.waitForConvergence).toHaveBeenNthCalledWith(
      1,
      'app-node',
      'orders-api',
      'runtime-before',
      'running'
    );
    expect(internal.waitForConvergence).toHaveBeenNthCalledWith(
      2,
      'app-node',
      'orders-api',
      'runtime-before',
      'running'
    );
  });

  it('reconnects the original network even when rollback convergence also fails', async () => {
    const { subject, nodeDispatch, dockerManagement, dockerSecrets } = containerSubject({ 'gateway-db-binding-1': {} });
    dockerManagement.getContainerEnv.mockResolvedValue(['KEEP=old']);
    dockerSecrets.list.mockResolvedValueOnce([{ id: 'secret-existing', key: 'DATABASE_URL', value: connectionUri }]);
    const internal = subject as unknown as { waitForConvergence: ReturnType<typeof vi.fn> };
    internal.waitForConvergence = vi
      .fn()
      .mockRejectedValueOnce(new Error('forward convergence failure'))
      .mockRejectedValueOnce(new Error('rollback convergence failure'));

    await expect(subject.remove(database, containerBinding, credentials, 'user-1')).rejects.toThrow(
      'forward convergence failure (managed database binding rollback failed: rollback convergence failure)'
    );

    expect(nodeDispatch.sendDockerNetworkCommand).toHaveBeenNthCalledWith(2, 'app-node', 'connect', {
      networkId: 'gateway-db-binding-1',
      containerId: 'orders-api',
    });
  });

  it('removes matching managed secrets and returns when the target container is absent', async () => {
    const { subject, dockerManagement, dockerSecrets, nodeDispatch } = containerSubject();
    dockerManagement.inspectContainer.mockResolvedValueOnce(null);
    dockerSecrets.list.mockResolvedValueOnce([{ id: 'secret-existing', key: 'DATABASE_URL', value: connectionUri }]);

    await expect(subject.remove(database, containerBinding, credentials, 'user-1')).resolves.toBeUndefined();

    expect(dockerSecrets.delete).toHaveBeenCalledWith('secret-existing', 'app-node', 'user-1', 'orders-api');
    expect(dockerManagement.getContainerEnv).not.toHaveBeenCalled();
    expect(dockerManagement.updateContainerEnv).not.toHaveBeenCalled();
    expect(nodeDispatch.sendDockerNetworkCommand).not.toHaveBeenCalled();
  });

  it('surfaces rollback failures instead of swallowing them', async () => {
    const { subject, dockerManagement, dockerSecrets } = containerSubject();
    dockerManagement.getContainerEnv.mockResolvedValue(['KEEP=old']);
    dockerSecrets.delete.mockRejectedValueOnce(new Error('secret cleanup unavailable'));
    const internal = subject as unknown as { waitForConvergence: ReturnType<typeof vi.fn> };
    internal.waitForConvergence = vi.fn().mockRejectedValueOnce(new Error('late convergence failure'));

    await expect(subject.apply(database, containerBinding, credentials, 'user-1')).rejects.toThrow(
      'late convergence failure (managed database binding rollback failed: secret cleanup unavailable)'
    );
  });
});
