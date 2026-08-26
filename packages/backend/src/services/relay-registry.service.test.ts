import { describe, expect, it, vi } from 'vitest';
import { dockerRegistryNodeBindings } from '@/db/schema/index.js';
import { RelayRegistryService } from './relay-registry.service.js';

describe('RelayRegistryService runtime migration bindings', () => {
  it('moves the active runtime binding and clears the source node before returning', async () => {
    const sourceBinding = {
      id: 'binding-1',
      nodeId: 'source-node',
      role: 'runtime',
      repository: 'gateway/builds/source-1',
      actions: ['pull'],
      contextKind: 'container',
      contextId: 'source-node:api',
      generation: 4,
      status: 'active',
    };
    const updateWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([sourceBinding]) })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    const db = {
      transaction: vi.fn(async (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx)),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    };
    const service = new RelayRegistryService(db as never, {} as never, {} as never, {} as never);
    const syncNode = vi.spyOn(service, 'syncNode').mockResolvedValue(undefined);

    await service.moveRuntimeContextBinding({
      contextKind: 'container',
      sourceContextId: 'source-node:api',
      targetContextId: 'target-node:api',
      sourceNodeId: 'source-node',
      targetNodeId: 'target-node',
    });

    expect(tx.update).toHaveBeenCalledWith(dockerRegistryNodeBindings);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'target-node',
        contextId: 'target-node:api',
        generation: 5,
        lastError: null,
      })
    );
    expect(syncNode.mock.calls).toEqual([['source-node'], ['target-node']]);
  });
});
