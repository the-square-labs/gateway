import { describe, expect, it, vi } from 'vitest';
import { DockerMigrationCoordinator } from './docker-migration-coordinator.js';

function createExecutor() {
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const limit = vi.fn().mockResolvedValue([{ slug: 'target-node' }]);
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  return { select, update };
}

describe('DockerMigrationCoordinator access scopes', () => {
  it('moves standalone container grants to the target node during the metadata cutover', async () => {
    const tx = createExecutor();
    const db = {
      transaction: vi.fn(async (callback: (executor: typeof tx) => Promise<void>) => callback(tx)),
    };
    const accessResources = {
      moveContainerWithExecutor: vi.fn().mockResolvedValue(undefined),
      moveDeploymentWithExecutor: vi.fn().mockResolvedValue(undefined),
    };
    const snapshots = { refreshNow: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new DockerMigrationCoordinator(
      db as never,
      {} as never,
      snapshots as never,
      accessResources as never
    );
    const row = {
      id: 'migration-1',
      resourceType: 'container',
      resourceName: 'api',
      sourceNodeId: 'source-node',
      targetNodeId: 'target-node',
      plan: { target: { containerId: 'target-runtime-id' } },
    };

    await coordinator.cutoverMetadata(row as never);

    expect(accessResources.moveContainerWithExecutor).toHaveBeenCalledWith(
      tx,
      'source-node',
      'target-node',
      'api',
      'target-runtime-id'
    );
    expect(accessResources.moveDeploymentWithExecutor).not.toHaveBeenCalled();
  });

  it('moves deployment grants with the stable deployment id during cutover', async () => {
    const tx = createExecutor();
    const db = {
      transaction: vi.fn(async (callback: (executor: typeof tx) => Promise<void>) => callback(tx)),
    };
    const accessResources = {
      moveContainerWithExecutor: vi.fn().mockResolvedValue(undefined),
      moveDeploymentWithExecutor: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = new DockerMigrationCoordinator(
      db as never,
      {} as never,
      { refreshNow: vi.fn().mockResolvedValue(undefined) } as never,
      accessResources as never
    );
    const row = {
      id: 'migration-2',
      resourceType: 'deployment',
      resourceName: 'api',
      deploymentId: 'deployment-1',
      sourceNodeId: 'source-node',
      targetNodeId: 'target-node',
      sourceState: 'ready',
      plan: {},
    };

    await coordinator.cutoverMetadata(row as never);

    expect(accessResources.moveDeploymentWithExecutor).toHaveBeenCalledWith(
      tx,
      'source-node',
      'target-node',
      'deployment-1'
    );
    expect(accessResources.moveContainerWithExecutor).not.toHaveBeenCalled();
  });
});
