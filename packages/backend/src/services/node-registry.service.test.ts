import { describe, expect, it, vi } from 'vitest';
import { NodeRegistryService } from './node-registry.service.js';

describe('NodeRegistryService', () => {
  function makeDb() {
    return {
      select: vi.fn((selection?: Record<string, unknown>) => ({
        from: () => ({
          where: () => {
            if (selection && 'id' in selection && 'hostname' in selection) {
              return Promise.resolve([{ id: 'node-1', hostname: 'worker-1' }]);
            }

            return {
              limit: () => Promise.resolve([{ healthHistory: [] }]),
            };
          },
        }),
      })),
      update: vi.fn(() => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      })),
    };
  }

  it('observes ongoing disconnected offline nodes for stateful notification windows', async () => {
    const db = makeDb();
    const evaluator = {
      observeStatefulEvent: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new NodeRegistryService(db as never);
    registry.setEvaluator(evaluator as never);

    await registry.recordHealthChecks();

    expect(evaluator.observeStatefulEvent).toHaveBeenCalledWith(
      'node',
      'offline',
      { type: 'node', id: 'node-1', name: 'worker-1' },
      { hostname: 'worker-1' }
    );
  });

  it('closes replaced command and log streams when a node reconnects', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const oldCommandStream = { end: vi.fn(), destroy: vi.fn() };
    const oldLogStream = { end: vi.fn(), destroy: vi.fn() };
    const newCommandStream = { end: vi.fn(), destroy: vi.fn() };

    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', oldCommandStream as never);
    const connected = registry.getNode('node-1');
    if (connected) connected.logStream = oldLogStream as never;

    await registry.register('node-1', 'nginx', 'worker-1', 'hash-2', newCommandStream as never);

    expect(oldCommandStream.end).toHaveBeenCalled();
    expect(oldCommandStream.destroy).toHaveBeenCalled();
    expect(oldLogStream.end).toHaveBeenCalled();
    expect(oldLogStream.destroy).toHaveBeenCalled();
  });

  it('tracks capabilities from the current live registration', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const firstStream = { end: vi.fn(), destroy: vi.fn() };
    const secondStream = { end: vi.fn(), destroy: vi.fn() };

    await registry.register('node-1', 'docker', 'worker-1', 'hash-1', firstStream as never, {
      capabilities: ['docker_compose_v1'],
    });
    expect(registry.hasCapability('node-1', 'docker_compose_v1')).toBe(true);

    await registry.register('node-1', 'docker', 'worker-1', 'hash-2', secondStream as never, { capabilities: [] });
    expect(registry.hasCapability('node-1', 'docker_compose_v1')).toBe(false);
  });

  it('does not register a node when the DB online update fails', async () => {
    const db = makeDb();
    db.update.mockReturnValueOnce({
      set: () => ({
        where: () => Promise.reject(new Error('db failed')),
      }),
    } as never);
    const registry = new NodeRegistryService(db as never);
    const commandStream = { end: vi.fn(), destroy: vi.fn() };

    await expect(registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never)).rejects.toThrow(
      'db failed'
    );

    expect(registry.getNode('node-1')).toBeUndefined();
  });

  it('does not register a node when the registration is superseded during the DB update', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const commandStream = { end: vi.fn(), destroy: vi.fn() };
    let current = true;

    await expect(
      registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never, {
        isCurrentRegistration: () => {
          const result = current;
          current = false;
          return result;
        },
      })
    ).rejects.toThrow('Registration superseded');

    expect(registry.getNode('node-1')).toBeUndefined();
  });

  it('separates command stream acceptance from eventual completion', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const commandStream = {
      write: vi.fn((_command, callback: (error?: Error) => void) => callback()),
    };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never);

    const dispatched = registry.dispatchCommand('node-1', { requestHealth: {} }, 30_000);
    await expect(dispatched.accepted).resolves.toBeUndefined();

    const command = commandStream.write.mock.calls[0]?.[0];
    registry.handleCommandResult('node-1', {
      commandId: command.commandId,
      success: true,
      error: '',
      detail: 'ok',
      data: Buffer.alloc(0),
    });
    await expect(dispatched.result).resolves.toMatchObject({ success: true, detail: 'ok' });
  });

  it('handles the acceptance promise for legacy sendCommand callers', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const accepted = Promise.reject(new Error('write failed'));
    const acceptedCatch = vi.spyOn(accepted, 'catch');
    const result = Promise.reject(new Error('write failed'));
    vi.spyOn(registry, 'dispatchCommand').mockReturnValue({ accepted, result });

    await expect(registry.sendCommand('node-1', { requestHealth: {} })).rejects.toThrow('write failed');
    expect(acceptedCatch).toHaveBeenCalledOnce();
  });

  it('rejects both command acceptance and completion when the node disconnects first', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const commandStream = { write: vi.fn() };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never);

    const dispatched = registry.dispatchCommand('node-1', { requestHealth: {} }, 30_000);
    const accepted = expect(dispatched.accepted).rejects.toThrow('Node disconnected');
    const result = expect(dispatched.result).rejects.toThrow('Node disconnected');
    await registry.deregister('node-1', commandStream as never);

    await Promise.all([accepted, result]);
  });

  it('preserves node status when the daemon disconnects during an update', async () => {
    const db = makeDb();
    const registry = new NodeRegistryService(db as never);
    const commandStream = { write: vi.fn() };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never);
    db.update.mockClear();
    registry.setNodeUpdateInProgress('node-1', true);

    await registry.deregister('node-1', commandStream as never);

    expect(db.update).not.toHaveBeenCalled();
    expect(registry.getNode('node-1')).toBeUndefined();
  });

  it('does not mark a disconnected updating node offline as stale', async () => {
    const update = vi.fn(() => ({
      set: () => ({ where: () => Promise.resolve() }),
    }));
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: 'node-1',
                hostname: 'worker-1',
                lastSeenAt: new Date(0),
                metadata: { updateInProgress: true },
              },
            ]),
        }),
      })),
      update,
    };
    const registry = new NodeRegistryService(db as never);

    await registry.markStaleNodesOffline(0);

    expect(update).not.toHaveBeenCalled();
  });
});
