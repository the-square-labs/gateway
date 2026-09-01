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

  it('coalesces equivalent traffic requests and serves the fresh last-good result', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const commandStream = {
      write: vi.fn((_command, callback: (error?: Error) => void) => callback()),
    };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never);
    const request = { tailLines: 200, hostId: '', windowSeconds: 0 };

    const first = registry.requestTrafficStats('node-1', request, 10_000);
    const overlapping = registry.requestTrafficStats('node-1', request, 10_000);
    expect(overlapping).toBe(first);
    await vi.waitFor(() => expect(commandStream.write).toHaveBeenCalledOnce());

    const command = commandStream.write.mock.calls[0]?.[0];
    registry.handleCommandResult('node-1', {
      commandId: command.commandId,
      success: true,
      error: '',
      detail: '{"totalRequests":12}',
      data: Buffer.alloc(0),
    });
    await expect(first).resolves.toMatchObject({ success: true });

    await expect(registry.requestTrafficStats('node-1', request, 10_000)).resolves.toMatchObject({ success: true });
    expect(commandStream.write).toHaveBeenCalledOnce();
    expect(registry.getNode('node-1')?.lastTrafficStats).toEqual({ totalRequests: 12 });
  });

  it('serializes different traffic scans on the same nginx node', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const commandStream = {
      write: vi.fn((_command, callback: (error?: Error) => void) => callback()),
    };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', commandStream as never);

    const first = registry.requestTrafficStats(
      'node-1',
      { tailLines: 200, hostId: '11111111-1111-4111-8111-111111111111', windowSeconds: 120 },
      0
    );
    const second = registry.requestTrafficStats(
      'node-1',
      { tailLines: 200, hostId: '22222222-2222-4222-8222-222222222222', windowSeconds: 120 },
      0
    );
    await vi.waitFor(() => expect(commandStream.write).toHaveBeenCalledOnce());

    const firstCommand = commandStream.write.mock.calls[0]?.[0];
    registry.handleCommandResult('node-1', {
      commandId: firstCommand.commandId,
      success: true,
      error: '',
      detail: '{}',
      data: Buffer.alloc(0),
    });
    await first;
    await vi.waitFor(() => expect(commandStream.write).toHaveBeenCalledTimes(2));

    const secondCommand = commandStream.write.mock.calls[1]?.[0];
    registry.handleCommandResult('node-1', {
      commandId: secondCommand.commandId,
      success: true,
      error: '',
      detail: '{}',
      data: Buffer.alloc(0),
    });
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it('does not replay a queued traffic scan onto a replacement connection', async () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const firstStream = {
      write: vi.fn((_command, callback: (error?: Error) => void) => callback()),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-1', firstStream as never);

    const first = registry.requestTrafficStats(
      'node-1',
      { tailLines: 200, hostId: '11111111-1111-4111-8111-111111111111', windowSeconds: 120 },
      0
    );
    const queued = registry.requestTrafficStats(
      'node-1',
      { tailLines: 200, hostId: '22222222-2222-4222-8222-222222222222', windowSeconds: 120 },
      0
    );
    await vi.waitFor(() => expect(firstStream.write).toHaveBeenCalledOnce());

    const secondStream = {
      write: vi.fn((_command, callback: (error?: Error) => void) => callback()),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    await registry.register('node-1', 'nginx', 'worker-1', 'hash-2', secondStream as never);

    await expect(first).rejects.toThrow('Node disconnected');
    await expect(queued).rejects.toThrow('connection changed');
    expect(secondStream.write).not.toHaveBeenCalled();
  });

  it('expires old traffic cache entries and enforces the hard cap', () => {
    const registry = new NodeRegistryService(makeDb() as never);
    const cache = (registry as any).trafficStatsCache as Map<
      string,
      { sampledAt: number; result: { success: boolean } }
    >;
    cache.set('expired', { sampledAt: 1_000, result: { success: true } });
    (registry as any).pruneTrafficStatsCache(61_000);
    expect(cache.has('expired')).toBe(false);

    for (let index = 0; index < 4_100; index++) {
      cache.set(`entry-${index}`, { sampledAt: 100_000 + index, result: { success: true } });
    }
    (registry as any).pruneTrafficStatsCache(104_100);

    expect(cache.size).toBe(4_096);
    expect(cache.has('entry-0')).toBe(false);
    expect(cache.has('entry-4099')).toBe(true);
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

  it('marks a disconnected node offline when its persisted update deadline expired', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: 'node-1',
                hostname: 'worker-1',
                lastSeenAt: new Date(0),
                metadata: {
                  updateInProgress: true,
                  updateDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
                },
              },
            ]),
        }),
      })),
      update,
    };
    const registry = new NodeRegistryService(db as never);
    registry.setNodeUpdateInProgress('node-1', true);

    await registry.markStaleNodesOffline(0);

    expect(set).toHaveBeenCalledWith({ status: 'offline', updatedAt: expect.any(Date) });
    expect(registry.isNodeUpdateInProgress('node-1')).toBe(false);
  });
});
