import { describe, expect, it, vi } from 'vitest';
import { dockerRegistryNodeBindings } from '@/db/schema/index.js';
import { RelayRegistryService } from './relay-registry.service.js';

describe('RelayRegistryService shared repository reconciliation', () => {
  const binding = (overrides: Record<string, unknown> = {}) => ({
    id: 'git-binding',
    nodeId: 'node-1',
    role: 'runtime',
    repository: 'gateway/builds/source-1',
    actions: ['pull'],
    contextKind: 'container',
    contextId: 'node-1:api',
    generation: 1,
    status: 'active',
    ...overrides,
  });

  function setup(bindings: ReturnType<typeof binding>[]) {
    const read = vi.fn(() => bindings);
    const updateSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = read();
            return Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
          }),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    const relay = {
      ensureInternalRegistryRoute: vi.fn().mockResolvedValue('route'),
      revokeOwner: vi.fn().mockResolvedValue(undefined),
    };
    const dispatch = { sendDockerRegistryBindings: vi.fn().mockResolvedValue({ success: true }) };
    const registry = {
      issueToken: vi.fn().mockResolvedValue({ token: 'token', issuedAt: new Date().toISOString(), expiresIn: 120 }),
    };
    return {
      service: new RelayRegistryService(db as never, relay as never, dispatch as never, registry as never),
      read,
      updateSet,
      relay,
      dispatch,
      registry,
    };
  }

  it.each([
    'gateway/builds/source-1',
    'gateway/builds/source-1/web',
  ])('repairs existing Git/HA duplicate rows for %s during normal refresh', async (repository) => {
    const git = binding({ repository });
    const ha = binding({ id: 'ha-binding', repository, contextKind: 'availability', contextId: 'policy-1' });
    const h = setup([ha, git]);
    // refreshAll first checks abandoned builds, then lists nodes, then syncs.
    h.read.mockReturnValueOnce([]).mockReturnValueOnce([ha, git]);
    await (h.service as any).refreshAll();
    const snapshot = h.dispatch.sendDockerRegistryBindings.mock.calls[0]![1];
    expect(snapshot).toEqual([
      expect.objectContaining({ bindingId: git.id, repository, role: 'runtime', actions: ['pull'] }),
    ]);
    expect(h.registry.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: [{ repository, actions: ['pull'] }],
        allowed: [{ repository, actions: ['pull'] }],
      })
    );
    expect(h.relay.revokeOwner).toHaveBeenCalledWith('registry_secure_link', ha.id, { allowDeferredSnapshot: true });
    expect(h.relay.revokeOwner.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.dispatch.sendDockerRegistryBindings.mock.invocationCallOrder[0]!
    );
    expect(h.updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));

    // A subsequent release changes digest, not repository: row order must not
    // change the chosen transport or duplicate it.
    h.read.mockReturnValue([git, ha]);
    await h.service.syncNode('node-1');
    expect(h.dispatch.sendDockerRegistryBindings.mock.calls[1]![1]).toEqual(snapshot);
  });

  it('keeps mirror push permission scoped to its grant and downgrades after its revocation', async () => {
    const runtime = binding();
    const mirror = binding({
      id: 'mirror-binding',
      role: 'mirror',
      actions: ['pull', 'push'],
      contextKind: 'availability',
      contextId: 'policy-1',
    });
    const h = setup([runtime, mirror]);
    await h.service.syncNode('node-1');
    expect(h.dispatch.sendDockerRegistryBindings).toHaveBeenLastCalledWith('node-1', [
      expect.objectContaining({
        bindingId: mirror.id,
        role: 'mirror',
        actions: ['pull', 'push'],
      }),
    ]);
    expect(h.registry.issueToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subject: 'mirror:node-1:availability:policy-1',
        allowed: [{ repository: mirror.repository, actions: ['pull', 'push'] }],
      })
    );
    h.read.mockReturnValueOnce([mirror]).mockReturnValue([runtime]);
    await h.service.revokeBinding(mirror.id);
    expect(h.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked', generation: 2 }));
    expect(h.dispatch.sendDockerRegistryBindings).toHaveBeenLastCalledWith('node-1', [
      expect.objectContaining({
        bindingId: runtime.id,
        role: 'runtime',
        actions: ['pull'],
      }),
    ]);
    expect(h.registry.issueToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowed: [{ repository: runtime.repository, actions: ['pull'] }],
      })
    );
  });

  it('preserves another context until the last grant is revoked', async () => {
    const git = binding();
    const ha = binding({ id: 'ha-binding', contextKind: 'availability', contextId: 'policy-1' });
    const h = setup([git, ha]);
    await h.service.syncNode('node-1');
    h.read.mockReturnValueOnce([git]).mockReturnValue([ha]);
    await h.service.revokeContextBinding({ contextKind: 'container', contextId: git.contextId });
    expect(h.dispatch.sendDockerRegistryBindings).toHaveBeenLastCalledWith('node-1', [
      expect.objectContaining({ bindingId: ha.id }),
    ]);
    h.read.mockReturnValueOnce([ha]).mockReturnValue([]);
    await h.service.revokeContextBinding({ contextKind: 'availability', contextId: ha.contextId });
    expect(h.dispatch.sendDockerRegistryBindings).toHaveBeenLastCalledWith('node-1', []);
  });

  it('deduplicates overlapping build grants without removing builder permissions', async () => {
    const first = binding({
      id: 'build-1',
      role: 'builder',
      actions: ['pull', 'push'],
      contextKind: 'build',
      contextId: 'build-1',
    });
    const second = binding({ ...first, id: 'build-2', contextId: 'build-2' });
    const h = setup([second, first]);
    await h.service.syncNode('node-1');
    expect(h.dispatch.sendDockerRegistryBindings).toHaveBeenLastCalledWith('node-1', [
      expect.objectContaining({
        bindingId: first.id,
        role: 'builder',
        actions: ['pull', 'push'],
      }),
    ]);
  });

  it.each([
    [binding({ actions: ['pull', 'push'] }), binding({ id: 'ha', role: 'mirror', actions: ['pull', 'push'] })],
    [binding(), binding({ id: 'build', role: 'builder', actions: ['pull', 'push'] })],
    [binding(), binding({ id: 'mirror', role: 'mirror', actions: ['push'] })],
  ])('rejects invalid or incompatible grants without issuing a broader token', async (...bindings) => {
    const h = setup(bindings);
    await expect(h.service.syncNode('node-1')).rejects.toThrow();
    expect(h.registry.issueToken).not.toHaveBeenCalled();
    expect(h.dispatch.sendDockerRegistryBindings).not.toHaveBeenCalled();
    expect(h.relay.revokeOwner).not.toHaveBeenCalled();
  });

  it('keeps previous routes intact when the daemon rejects the replacement snapshot', async () => {
    const h = setup([binding(), binding({ id: 'ha', contextKind: 'availability' })]);
    h.dispatch.sendDockerRegistryBindings.mockResolvedValue({ success: false });
    await expect(h.service.syncNode('node-1')).rejects.toThrow('Docker daemon rejected');
    expect(h.relay.revokeOwner).not.toHaveBeenCalled();
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'Docker daemon rejected internal registry bindings' })
    );
  });
});

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

  it('completes context revocation when a disconnected node cannot be resynchronized', async () => {
    const bindings = [
      { id: 'binding-1', nodeId: 'node-online' },
      { id: 'binding-2', nodeId: 'node-offline' },
    ];
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(bindings) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    };
    const relayPolicy = { revokeOwner: vi.fn().mockResolvedValue(undefined) };
    const service = new RelayRegistryService(db as never, relayPolicy as never, {} as never, {} as never);
    vi.spyOn(service, 'syncNode').mockImplementation(async (nodeId) => {
      if (nodeId === 'node-offline') throw new Error('node is not connected');
    });

    await expect(
      service.revokeContextBinding({ contextKind: 'availability', contextId: 'policy-1' })
    ).resolves.toBeUndefined();
    expect(relayPolicy.revokeOwner).toHaveBeenCalledTimes(2);
  });
});
