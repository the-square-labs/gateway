import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { logRelay, NGINX_LOG_SUBSCRIBE_ACK_EVENT } from '@/modules/monitoring/log-relay.service.js';
import { createLogStreamHandlers } from './log-stream.js';

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger.js')>()),
  createChildLogger: () => logs,
}));

const nodeId = '11111111-1111-4111-8111-111111111111';
const ownedHostId = '22222222-2222-4222-8222-222222222222';
const otherHostId = '33333333-3333-4333-8333-333333333333';

function makeDbNode(
  node: null | { certificateSerial?: string | null; status?: string },
  hostOwnership: boolean | Array<boolean | Error> = true
) {
  const nodeRows = node
    ? [
        {
          certificateSerial: 'certificateSerial' in node ? node.certificateSerial : 'aa01',
          status: node.status ?? 'online',
        },
      ]
    : [];
  const ownershipResults = Array.isArray(hostOwnership) ? [...hostOwnership] : null;
  const defaultHostOwned = Array.isArray(hostOwnership) ? true : hostOwnership;
  const ownershipRows = defaultHostOwned ? [{ id: ownedHostId }] : [];
  const queuedRows = [nodeRows, ownershipRows];

  return {
    select: vi.fn(() => {
      const rows = queuedRows.shift() ?? ownershipRows;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (rows === ownershipRows && ownershipResults) {
                const result = ownershipResults.shift() ?? defaultHostOwned;
                if (result instanceof Error) throw result;
                return result ? ownershipRows : [];
              }
              return rows;
            }),
          })),
        })),
      };
    }),
  } as any;
}

function makeDelayedDbNode() {
  let resolveRows!: (rows: Array<{ certificateSerial: string | null; status: string }>) => void;
  const rowsPromise = new Promise<Array<{ certificateSerial: string | null; status: string }>>((resolve) => {
    resolveRows = resolve;
  });

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => rowsPromise),
          })),
        })),
      })),
    } as any,
    resolveRows,
  };
}

function makeStream(options: {
  cn?: string;
  serialNumber?: string;
  authorized?: boolean;
  includeAuthorized?: boolean;
}) {
  const socket: Record<string, unknown> = {
    authorizationError: options.authorized === false ? 'SELF_SIGNED_CERT_IN_CHAIN' : null,
    getPeerCertificate: () => ({
      subject: { CN: options.cn ?? nodeId },
      serialNumber: options.serialNumber ?? 'aa01',
    }),
  };
  if (options.includeAuthorized !== false) {
    socket.authorized = options.authorized ?? true;
  }

  return Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    getPeer: () => '127.0.0.1:12345',
    handler: {
      http2Stream: {
        session: {
          socket,
        },
      },
    },
  }) as any;
}

function makeDeps(
  db: any,
  connectedNode: { connectionId?: string; logStream: unknown } | null = { connectionId: 'conn-1', logStream: null }
) {
  if (connectedNode && !connectedNode.connectionId) connectedNode.connectionId = 'conn-1';
  return {
    db,
    registry: {
      getNode: vi.fn(() => connectedNode),
    },
    dispatch: {},
    auditService: {},
    caService: {},
    cryptoService: {},
    systemCA: {},
  } as any;
}

describe('StreamLogs daemon certificate identity', () => {
  it('turns away a stream that arrives before its node registered without a warning (M-4)', async () => {
    logs.warn.mockClear();
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01' }), null);
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => expect(stream.end).toHaveBeenCalled());
    expect(logs.debug).toHaveBeenCalledWith('Log stream rejected: node is not connected yet', { nodeId });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('installs cleanup handlers before async authentication completes', () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01' }));
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);

    expect(stream.listenerCount('error')).toBe(1);
    expect(stream.listenerCount('end')).toBe(1);
  });

  it('does not associate the log stream when it ends during async authentication', async () => {
    const connectedNode = { logStream: null };
    const delayed = makeDelayedDbNode();
    const deps = makeDeps(delayed.db, connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);
    stream.emit('end');
    delayed.resolveRows([{ certificateSerial: 'aa01', status: 'online' }]);

    await new Promise((resolve) => setImmediate(resolve));

    expect(connectedNode.logStream).toBe(null);
  });

  it('associates the log stream when authorized cert serial matches DB', async () => {
    const connectedNode = { logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(connectedNode.logStream).toBe(stream);
    });
    expect(stream.end).not.toHaveBeenCalled();
  });

  it('does not relay log entries from a stream that is no longer registered', async () => {
    const connectedNode = { connectionId: 'conn-1', logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });
    const emitSpy = vi.spyOn(logRelay, 'emit');

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(connectedNode.logStream).toBe(stream);
    });
    connectedNode.logStream = null;
    stream.emit('data', {
      entry: {
        hostId: ownedHostId,
        timestamp: '2026-05-02T00:00:00.000Z',
        remoteAddr: '127.0.0.1',
        method: 'GET',
        path: '/',
        status: 200,
        bodyBytesSent: '0',
        raw: 'log',
        logType: 'access',
        level: '',
      },
    });

    expect(stream.end).toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith('log', expect.anything());
    emitSpy.mockRestore();
  });

  it('relays nginx log entries only after host ownership is verified', async () => {
    const connectedNode = { connectionId: 'conn-1', logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }, true), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });
    const emitSpy = vi.spyOn(logRelay, 'emit');

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(connectedNode.logStream).toBe(stream);
    });
    stream.emit('data', {
      entry: {
        hostId: ownedHostId,
        timestamp: '2026-05-02T00:00:00.000Z',
        remoteAddr: '127.0.0.1',
        method: 'GET',
        path: '/',
        status: 200,
        bodyBytesSent: '0',
        raw: 'log',
        logType: 'access',
        level: '',
      },
    });

    await vi.waitFor(() => {
      expect(emitSpy).toHaveBeenCalledWith(
        'log',
        expect.objectContaining({
          nodeId,
          hostId: ownedHostId,
          raw: 'log',
        })
      );
    });
    emitSpy.mockRestore();
  });

  it('rejects nginx log entries for hosts not owned by the authenticated node', async () => {
    const connectedNode = { connectionId: 'conn-1', logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }, false), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });
    const emitSpy = vi.spyOn(logRelay, 'emit');

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(connectedNode.logStream).toBe(stream);
    });
    stream.emit('data', {
      entry: {
        hostId: otherHostId,
        timestamp: '2026-05-02T00:00:00.000Z',
        remoteAddr: '127.0.0.1',
        method: 'GET',
        path: '/',
        status: 200,
        bodyBytesSent: '0',
        raw: 'spoofed',
        logType: 'access',
        level: '',
      },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(emitSpy).not.toHaveBeenCalledWith('log', expect.anything());
    expect(stream.end).not.toHaveBeenCalled();
    emitSpy.mockRestore();
  });

  it('does not cache transient host ownership lookup failures', async () => {
    const connectedNode = { connectionId: 'conn-1', logStream: null };
    const deps = makeDeps(
      makeDbNode({ certificateSerial: 'AA:01' }, [new Error('database unavailable'), true]),
      connectedNode
    );
    const stream = makeStream({ serialNumber: 'aa01' });
    const emitSpy = vi.spyOn(logRelay, 'emit');

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(connectedNode.logStream).toBe(stream);
    });
    const entry = {
      hostId: ownedHostId,
      timestamp: '2026-05-02T00:00:00.000Z',
      remoteAddr: '127.0.0.1',
      method: 'GET',
      path: '/',
      status: 200,
      bodyBytesSent: '0',
      raw: 'log',
      logType: 'access',
      level: '',
    };
    stream.emit('data', { entry: { ...entry, raw: 'first' } });

    await new Promise((resolve) => setImmediate(resolve));
    expect(emitSpy).not.toHaveBeenCalledWith('log', expect.anything());

    stream.emit('data', { entry: { ...entry, raw: 'second' } });

    await vi.waitFor(() => {
      expect(emitSpy).toHaveBeenCalledWith(
        'log',
        expect.objectContaining({
          nodeId,
          hostId: ownedHostId,
          raw: 'second',
        })
      );
    });
    emitSpy.mockRestore();
  });

  it('rejects nginx subscribe acks for hosts not owned by the authenticated node', async () => {
    const connectedNode = { connectionId: 'conn-1', logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }, false), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });
    const emitSpy = vi.spyOn(logRelay, 'emit');

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(connectedNode.logStream).toBe(stream);
    });
    stream.emit('data', {
      subscribeAck: {
        hostId: otherHostId,
      },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(emitSpy).not.toHaveBeenCalledWith(NGINX_LOG_SUBSCRIBE_ACK_EVENT, expect.anything());
    expect(stream.end).not.toHaveBeenCalled();
    emitSpy.mockRestore();
  });

  it('rejects a log stream when the node command connection changes during authentication', async () => {
    const connectedNode = { connectionId: 'conn-1', logStream: null };
    const delayed = makeDelayedDbNode();
    const deps = makeDeps(delayed.db, connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);
    connectedNode.connectionId = 'conn-2';
    delayed.resolveRows([{ certificateSerial: 'aa01', status: 'online' }]);

    await vi.waitFor(() => {
      expect(stream.end).toHaveBeenCalled();
    });
    expect(connectedNode.logStream).toBe(null);
  });

  it('rejects the log stream when certificate serial does not match DB', async () => {
    const connectedNode = { logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'bb01' }), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(stream.end).toHaveBeenCalled();
    });
    expect(connectedNode.logStream).toBe(null);
  });

  it('rejects the log stream when no connected node exists', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01' }), null);
    const stream = makeStream({ serialNumber: 'aa01' });

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(stream.end).toHaveBeenCalled();
    });
  });

  it('rejects the log stream when mTLS authorization state is ambiguous', async () => {
    const connectedNode = { logStream: null };
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01' }), connectedNode);
    const stream = makeStream({ serialNumber: 'aa01', includeAuthorized: false });

    createLogStreamHandlers(deps).StreamLogs(stream);

    await vi.waitFor(() => {
      expect(stream.end).toHaveBeenCalled();
    });
    expect(connectedNode.logStream).toBe(null);
  });
});
