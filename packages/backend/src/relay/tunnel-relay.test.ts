import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RelayAuthorizationRepository, type RelayQueryClient } from './authorization-repository.js';
import type { DatabaseTunnelMessage, RelayStream } from './protocol.js';
import {
  parseDatabaseTunnelCapability,
  type RelayTunnelConnection,
  StandaloneDatabaseTunnelRelay,
} from './tunnel-relay.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const DATABASE_NODE_ID = '22222222-2222-4222-8222-222222222222';
const DATABASE_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';

function stream(writeResult = true) {
  const messages: DatabaseTunnelMessage[] = [];
  const value: RelayStream = {
    write: vi.fn((message: DatabaseTunnelMessage) => {
      messages.push(message);
      return writeResult;
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    once: vi.fn((_event: 'drain', listener: () => void) => {
      listener();
      return value;
    }),
    end: vi.fn(),
  };
  return { value, messages };
}

function repository(options: { readyBindings?: string[]; failReconcile?: boolean } = {}) {
  const query = async (text: string) => {
    if (text.includes('WHERE binding_id = $1')) {
      return {
        rows: [
          {
            binding_id: BINDING_ID,
            managed_database_id: DATABASE_ID,
            source_node_id: SOURCE_ID,
            binding_status: 'ready',
            database_node_id: DATABASE_NODE_ID,
            database_status: 'ready',
          },
        ],
      };
    }
    if (text.includes('managed_database_id = $1')) {
      return {
        rows: [
          {
            managed_database_id: DATABASE_ID,
            database_node_id: DATABASE_NODE_ID,
            database_status: 'ready',
          },
        ],
      };
    }
    if (text.includes('ANY($1::uuid[])')) {
      if (options.failReconcile) throw new Error('postgres unavailable');
      return { rows: (options.readyBindings ?? [BINDING_ID]).map((binding_id) => ({ binding_id })) };
    }
    return { rows: [] };
  };
  return RelayAuthorizationRepository.forTest({
    query: query as RelayQueryClient['query'],
  });
}

function connection(
  nodeId: string,
  nodeType: 'docker' | 'databases',
  lane: 'data' | 'interactive' | 'monitoring',
  target: RelayStream,
  bindingId?: string
): RelayTunnelConnection {
  return { nodeId, nodeType, lane, bindingId, stream: target, maxChunkBytes: 1024 * 1024 };
}

describe('StandaloneDatabaseTunnelRelay', () => {
  it('keeps the daemon capability contract wire-compatible', () => {
    expect(parseDatabaseTunnelCapability(`database_tunnel_v2:data:${BINDING_ID}`)).toEqual({
      lane: 'data',
      bindingId: BINDING_ID,
    });
    expect(parseDatabaseTunnelCapability('database_tunnel_v2:interactive')).toEqual({ lane: 'interactive' });
    expect(parseDatabaseTunnelCapability('database_tunnel_v3:interactive')).toBeNull();
  });

  it('authorizes and routes a binding session between the source and database daemon', async () => {
    const sourceStream = stream();
    const targetStream = stream();
    const relay = new StandaloneDatabaseTunnelRelay(repository());
    const source = connection(SOURCE_ID, 'docker', 'data', sourceStream.value, BINDING_ID);
    const target = connection(DATABASE_NODE_ID, 'databases', 'data', targetStream.value, BINDING_ID);
    relay.register(source);
    relay.register(target);

    await relay.handleOpen(source, { tunnelId: 'session-1', bindingId: BINDING_ID, managedDatabaseId: DATABASE_ID });
    expect(targetStream.messages[0]).toEqual({
      open: { tunnelId: 'session-1', bindingId: BINDING_ID, managedDatabaseId: DATABASE_ID },
    });

    relay.handleData(source, {
      tunnelId: 'session-1',
      bindingId: BINDING_ID,
      data: Buffer.from('request'),
    });
    expect(targetStream.messages.at(-1)?.data?.data).toEqual(Buffer.from('request'));
    expect(relay.getStats()).toMatchObject({ sessions: 1, activeBindingIds: [BINDING_ID] });
  });

  it('applies backpressure without losing the session', async () => {
    const sourceStream = stream();
    const targetStream = stream();
    const relay = new StandaloneDatabaseTunnelRelay(repository());
    const source = connection(SOURCE_ID, 'docker', 'data', sourceStream.value, BINDING_ID);
    relay.register(source);
    relay.register(connection(DATABASE_NODE_ID, 'databases', 'data', targetStream.value, BINDING_ID));
    await relay.handleOpen(source, { tunnelId: 'session-1', bindingId: BINDING_ID, managedDatabaseId: DATABASE_ID });

    vi.mocked(targetStream.value.write).mockReturnValue(false);
    relay.handleData(source, { tunnelId: 'session-1', bindingId: BINDING_ID, data: Buffer.from('request') });
    expect(sourceStream.value.pause).toHaveBeenCalled();
    expect(sourceStream.value.resume).toHaveBeenCalled();
    expect(relay.getStats().sessions).toBe(1);
  });

  it('keeps existing sessions when reconciliation cannot query PostgreSQL', async () => {
    const sourceStream = stream();
    const targetStream = stream();
    const relay = new StandaloneDatabaseTunnelRelay(repository({ failReconcile: true }));
    const source = connection(SOURCE_ID, 'docker', 'data', sourceStream.value, BINDING_ID);
    relay.register(source);
    relay.register(connection(DATABASE_NODE_ID, 'databases', 'data', targetStream.value, BINDING_ID));
    await relay.handleOpen(source, { tunnelId: 'session-1', bindingId: BINDING_ID, managedDatabaseId: DATABASE_ID });

    await expect(relay.reconcileBindings()).rejects.toThrow('Relay binding reconciliation failed');
    expect(relay.getStats().sessions).toBe(1);
  });

  it('revokes active sessions after a successful grouped non-ready result', async () => {
    const sourceStream = stream();
    const targetStream = stream();
    const relay = new StandaloneDatabaseTunnelRelay(repository({ readyBindings: [] }));
    const source = connection(SOURCE_ID, 'docker', 'data', sourceStream.value, BINDING_ID);
    relay.register(source);
    relay.register(connection(DATABASE_NODE_ID, 'databases', 'data', targetStream.value, BINDING_ID));
    await relay.handleOpen(source, { tunnelId: 'session-1', bindingId: BINDING_ID, managedDatabaseId: DATABASE_ID });

    await relay.reconcileBindings();
    expect(relay.getStats().sessions).toBe(0);
    expect(sourceStream.messages.at(-1)?.error?.code).toBe('BINDING_REVOKED');
    expect(targetStream.messages.at(-1)?.error?.code).toBe('BINDING_REVOKED');
  });

  it('bridges one app driver Duplex to the database daemon lane', async () => {
    const targetStream = stream();
    const relay = new StandaloneDatabaseTunnelRelay(repository());
    const target = connection(DATABASE_NODE_ID, 'databases', 'interactive', targetStream.value);
    relay.register(target);

    const driver = await relay.openAppTunnel(DATABASE_ID, 'interactive');
    expect(targetStream.messages[0]?.open?.managedDatabaseId).toBe(DATABASE_ID);
    const open = targetStream.messages[0]!.open!;
    driver.write(Buffer.from('query'));
    expect(targetStream.messages.at(-1)?.data?.data).toEqual(Buffer.from('query'));

    const received = once(driver, 'data');
    relay.handleData(target, {
      tunnelId: open.tunnelId,
      bindingId: open.bindingId,
      data: Buffer.from('row'),
    });
    await expect(received).resolves.toEqual([Buffer.from('row')]);
    driver.destroy();
  });

  it('pauses the database daemon until a stalled app reader consumes buffered output', async () => {
    const targetStream = stream();
    const relay = new StandaloneDatabaseTunnelRelay(repository());
    const target = connection(DATABASE_NODE_ID, 'databases', 'interactive', targetStream.value);
    relay.register(target);

    const driver = await relay.openAppTunnel(DATABASE_ID, 'interactive');
    const open = targetStream.messages[0]!.open!;
    relay.handleData(target, {
      tunnelId: open.tunnelId,
      bindingId: open.bindingId,
      data: Buffer.alloc(1024 * 1024),
    });

    expect(targetStream.value.pause).toHaveBeenCalledOnce();
    expect(targetStream.value.resume).not.toHaveBeenCalled();

    const received = once(driver, 'data');
    driver.resume();
    await received;
    expect(targetStream.value.resume).toHaveBeenCalledOnce();
    driver.destroy();
  });
});
