import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DATABASE_TUNNEL_IDLE_TIMEOUT_MS, type DatabaseTunnelMessage, DatabaseTunnelRelay } from './database-tunnel.js';

const APP_NODE_ID = '11111111-1111-4111-8111-111111111111';
const DATABASE_NODE_ID = '22222222-2222-4222-8222-222222222222';
const BINDING_ID = '33333333-3333-4333-8333-333333333333';
const DATABASE_ID = '44444444-4444-4444-8444-444444444444';

class FakeStream extends EventEmitter {
  readonly writes: DatabaseTunnelMessage[] = [];
  paused = false;
  acceptWrites = true;

  write(message: DatabaseTunnelMessage): boolean {
    this.writes.push(message);
    return this.acceptWrites;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  end(): void {}
}

function makeDb(result: unknown[]) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin, where }));
  return { select: vi.fn(() => ({ from })) };
}

function registerPair(relay: DatabaseTunnelRelay, maxChunkBytes = 1024) {
  const source = new FakeStream();
  const target = new FakeStream();
  relay.register({
    nodeId: APP_NODE_ID,
    nodeType: 'docker',
    lane: 'data',
    bindingId: BINDING_ID,
    stream: source as never,
    maxChunkBytes,
  });
  relay.register({
    nodeId: DATABASE_NODE_ID,
    nodeType: 'databases',
    lane: 'data',
    bindingId: BINDING_ID,
    stream: target as never,
    maxChunkBytes,
  });
  relay.register({
    nodeId: DATABASE_NODE_ID,
    nodeType: 'databases',
    lane: 'interactive',
    stream: target as never,
    maxChunkBytes,
  });
  return { source, target };
}

const open = {
  tunnelId: 'tunnel_1',
  bindingId: BINDING_ID,
  managedDatabaseId: DATABASE_ID,
};

describe('DatabaseTunnelRelay', () => {
  it('authorizes an exact binding pair and relays bounded raw frames in both directions', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: APP_NODE_ID,
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { source, target } = registerPair(relay);

    await relay.handleOpen(APP_NODE_ID, open);
    relay.handleData(APP_NODE_ID, { tunnelId: open.tunnelId, bindingId: BINDING_ID, data: Buffer.from('request') });
    relay.handleData(DATABASE_NODE_ID, {
      tunnelId: open.tunnelId,
      bindingId: BINDING_ID,
      data: Buffer.from('response'),
    });
    relay.handleClose(APP_NODE_ID, { tunnelId: open.tunnelId, bindingId: BINDING_ID });

    expect(target.writes).toEqual([
      { open },
      { data: { tunnelId: open.tunnelId, bindingId: BINDING_ID, data: Buffer.from('request') } },
      { close: { tunnelId: open.tunnelId, bindingId: BINDING_ID } },
    ]);
    expect(source.writes).toEqual([
      { data: { tunnelId: open.tunnelId, bindingId: BINDING_ID, data: Buffer.from('response') } },
    ]);
  });

  it('rejects a binding that is not active for the claimed source node', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: '55555555-5555-4555-8555-555555555555',
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { source, target } = registerPair(relay);

    await relay.handleOpen(APP_NODE_ID, open);

    expect(target.writes).toEqual([]);
    expect(source.writes[0]?.error?.code).toBe('BINDING_NOT_AUTHORIZED');
  });

  it('terminates both sides when a frame exceeds either negotiated limit', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: APP_NODE_ID,
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { source, target } = registerPair(relay, 4);
    await relay.handleOpen(APP_NODE_ID, open);

    relay.handleData(APP_NODE_ID, {
      tunnelId: open.tunnelId,
      bindingId: BINDING_ID,
      data: Buffer.from('oversized'),
    });

    expect(source.writes.at(-1)?.error?.code).toBe('FRAME_TOO_LARGE');
    expect(target.writes.at(-1)?.error?.code).toBe('FRAME_TOO_LARGE');
  });

  it('revokes existing sessions immediately when a binding is deleted', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: APP_NODE_ID,
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { source, target } = registerPair(relay);
    await relay.handleOpen(APP_NODE_ID, open);

    relay.revokeBinding(BINDING_ID);
    relay.handleData(APP_NODE_ID, { tunnelId: open.tunnelId, bindingId: BINDING_ID, data: Buffer.from('request') });

    expect(source.writes.at(-2)?.error?.code).toBe('BINDING_REVOKED');
    expect(target.writes.at(-1)?.error?.code).toBe('BINDING_REVOKED');
    expect(source.writes.at(-1)?.error?.code).toBe('TUNNEL_NOT_FOUND');
  });

  it('pauses the sender until the receiving stream drains', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: APP_NODE_ID,
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { source, target } = registerPair(relay);
    await relay.handleOpen(APP_NODE_ID, open);
    target.acceptWrites = false;

    relay.handleData(APP_NODE_ID, { tunnelId: open.tunnelId, bindingId: BINDING_ID, data: Buffer.from('data') });
    expect(source.paused).toBe(true);

    target.emit('drain');
    expect(source.paused).toBe(false);
  });

  it('caps a binding and releases capacity after close', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: APP_NODE_ID,
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { source, target } = registerPair(relay);

    for (let index = 0; index < 16; index += 1) {
      await relay.handleOpen(APP_NODE_ID, { ...open, tunnelId: `binding_a_${index}` });
    }
    await relay.handleOpen(APP_NODE_ID, { ...open, tunnelId: 'binding_a_overflow' });
    expect(source.writes.at(-1)?.error?.code).toBe('RESOURCE_EXHAUSTED');
    expect(target.writes.filter((entry) => entry.open)).toHaveLength(16);

    relay.handleClose(APP_NODE_ID, { tunnelId: 'binding_a_0', bindingId: BINDING_ID });
    await relay.handleOpen(APP_NODE_ID, { ...open, tunnelId: 'binding_a_retry' });
    expect(target.writes.filter((entry) => entry.open)).toHaveLength(17);
  });

  it('opens a private backend tunnel without a workload binding', async () => {
    const db = makeDb([{ id: DATABASE_ID, nodeId: DATABASE_NODE_ID, status: 'ready' }]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const { target } = registerPair(relay);

    const tunnel = await relay.openGatewayTunnel(DATABASE_ID);
    const openFrame = target.writes[0]?.open;
    expect(openFrame).toMatchObject({ managedDatabaseId: DATABASE_ID });
    expect(openFrame?.bindingId).not.toBe(BINDING_ID);

    await new Promise<void>((resolve, reject) => {
      tunnel.write(Buffer.from('request'), (error) => (error ? reject(error) : resolve()));
    });
    expect(target.writes[1]?.data?.data).toEqual(Buffer.from('request'));

    const response = new Promise<Buffer>((resolve) => tunnel.once('data', resolve));
    relay.handleData(DATABASE_NODE_ID, {
      tunnelId: openFrame!.tunnelId,
      bindingId: openFrame!.bindingId,
      data: Buffer.from('response'),
    });
    await expect(response).resolves.toEqual(Buffer.from('response'));

    tunnel.end();
    expect(target.writes.at(-1)?.close).toEqual({
      tunnelId: openFrame!.tunnelId,
      bindingId: openFrame!.bindingId,
    });
  });

  it('keeps an application binding on its own data lane while monitoring uses a separate target stream', async () => {
    const db = makeDb([
      {
        bindingId: BINDING_ID,
        targetNodeId: APP_NODE_ID,
        bindingStatus: 'ready',
        managedDatabaseId: DATABASE_ID,
        databaseNodeId: DATABASE_NODE_ID,
        databaseStatus: 'ready',
      },
    ]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const dataSource = new FakeStream();
    const dataTarget = new FakeStream();
    const monitoringTarget = new FakeStream();
    const dataSourceConnection = {
      nodeId: APP_NODE_ID,
      nodeType: 'docker',
      lane: 'data',
      bindingId: BINDING_ID,
      stream: dataSource as never,
      maxChunkBytes: 1024,
    } as const;
    relay.register(dataSourceConnection);
    relay.register({
      nodeId: DATABASE_NODE_ID,
      nodeType: 'databases',
      lane: 'data',
      bindingId: BINDING_ID,
      stream: dataTarget as never,
      maxChunkBytes: 1024,
    });
    relay.register({
      nodeId: DATABASE_NODE_ID,
      nodeType: 'databases',
      lane: 'monitoring',
      stream: monitoringTarget as never,
      maxChunkBytes: 1024,
    });

    await relay.handleOpen(dataSourceConnection, open);
    expect(dataTarget.writes).toEqual([{ open }]);
    expect(monitoringTarget.writes).toEqual([]);
  });

  it('routes Gateway monitoring through the monitoring lane rather than interactive traffic', async () => {
    const db = makeDb([{ id: DATABASE_ID, nodeId: DATABASE_NODE_ID, status: 'ready' }]);
    const relay = new DatabaseTunnelRelay({ db: db as never });
    const interactiveTarget = new FakeStream();
    const monitoringTarget = new FakeStream();
    relay.register({
      nodeId: DATABASE_NODE_ID,
      nodeType: 'databases',
      lane: 'interactive',
      stream: interactiveTarget as never,
      maxChunkBytes: 1024,
    });
    relay.register({
      nodeId: DATABASE_NODE_ID,
      nodeType: 'databases',
      lane: 'monitoring',
      stream: monitoringTarget as never,
      maxChunkBytes: 1024,
    });

    const tunnel = await relay.openGatewayTunnel(DATABASE_ID, 'monitoring');
    expect(monitoringTarget.writes[0]?.open?.managedDatabaseId).toBe(DATABASE_ID);
    expect(interactiveTarget.writes).toEqual([]);
    tunnel.destroy();
  });

  it('closes idle tunnel sessions and frees their admission slot', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb([
        {
          bindingId: BINDING_ID,
          targetNodeId: APP_NODE_ID,
          bindingStatus: 'ready',
          managedDatabaseId: DATABASE_ID,
          databaseNodeId: DATABASE_NODE_ID,
          databaseStatus: 'ready',
        },
      ]);
      const relay = new DatabaseTunnelRelay({ db: db as never });
      const { source, target } = registerPair(relay);
      await relay.handleOpen(APP_NODE_ID, open);

      await vi.advanceTimersByTimeAsync(DATABASE_TUNNEL_IDLE_TIMEOUT_MS);

      expect(source.writes.at(-1)?.error?.code).toBe('IDLE_TIMEOUT');
      expect(target.writes.at(-1)?.error?.code).toBe('IDLE_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });
});
