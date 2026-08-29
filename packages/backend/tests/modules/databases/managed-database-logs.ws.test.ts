import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  resolveWebSocketCredential: vi.fn(),
  resolveLogTarget: vi.fn(),
  getLogs: vi.fn(),
  sendManagedDatabaseLogsCommand: vi.fn(),
  stopManagedDatabaseLogStream: vi.fn(),
  getNode: vi.fn(),
  registerLogStreamHandler: vi.fn(),
  removeLogStreamHandler: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/container.js', () => ({
  container: { resolve: mocks.resolve },
}));

vi.mock('@/lib/logger.js', () => ({
  createChildLogger: () => ({
    debug: mocks.loggerDebug,
    error: mocks.loggerError,
  }),
}));

vi.mock('@/modules/auth/websocket-auth.js', () => ({
  resolveWebSocketCredential: mocks.resolveWebSocketCredential,
}));

vi.mock('@/modules/databases/managed-databases.service.js', () => ({
  ManagedDatabaseService: class ManagedDatabaseService {},
}));

vi.mock('@/services/node-dispatch.service.js', () => ({
  NodeDispatchService: class NodeDispatchService {},
}));

vi.mock('@/services/node-registry.service.js', () => ({
  NodeRegistryService: class NodeRegistryService {},
}));

import { createManagedDatabaseLogStreamWSHandlers } from '@/modules/databases/managed-database-logs.ws.js';

const DATABASE_ID = 'database-1';
const TAIL_LINES = 2;
const TARGET = {
  nodeId: 'node-1',
  containerId: 'container-1',
  managedDatabaseId: DATABASE_ID,
};
const INITIAL_LINES = [
  '2026-08-29T10:00:00.000000002Z first line',
  '2026-08-29T10:00:01.000000004Z second line',
];
const HISTORY_LINES = ['2026-08-29T09:59:59.000000001Z older line'];

let registeredHandler: ((lines: string[], ended: boolean) => void) | undefined;

function createWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

function createHandlers() {
  mocks.resolve.mockReset();
  mocks.resolve
    .mockReturnValueOnce({
      resolveLogTarget: mocks.resolveLogTarget,
      getLogs: mocks.getLogs,
    })
    .mockReturnValueOnce({
      sendManagedDatabaseLogsCommand: mocks.sendManagedDatabaseLogsCommand,
      stopManagedDatabaseLogStream: mocks.stopManagedDatabaseLogStream,
    })
    .mockReturnValueOnce({
      getNode: mocks.getNode,
      registerLogStreamHandler: mocks.registerLogStreamHandler,
      removeLogStreamHandler: mocks.removeLogStreamHandler,
    });

  return createManagedDatabaseLogStreamWSHandlers(DATABASE_ID, TAIL_LINES, null);
}

async function waitForMessage(ws: ReturnType<typeof createWs>, message: Record<string, unknown>) {
  await vi.waitFor(() => expect(ws.send).toHaveBeenCalledWith(JSON.stringify(message)));
}

async function openStream() {
  const handlers = createHandlers();
  const ws = createWs();

  handlers.onOpen(new Event('open'), ws as any);
  await waitForMessage(ws, { type: 'connected', streaming: true });

  return { handlers, ws };
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredHandler = undefined;

  mocks.resolveWebSocketCredential.mockResolvedValue({ scopes: [`databases:view:${DATABASE_ID}`] });
  mocks.resolveLogTarget.mockResolvedValue(TARGET);
  mocks.getLogs.mockResolvedValue(INITIAL_LINES);
  mocks.sendManagedDatabaseLogsCommand.mockResolvedValue({ success: true });
  mocks.stopManagedDatabaseLogStream.mockResolvedValue(undefined);
  mocks.getNode.mockReturnValue({ id: TARGET.nodeId });
  mocks.registerLogStreamHandler.mockImplementation(
    (_key: string, handler: (lines: string[], ended: boolean) => void) => {
      registeredHandler = handler;
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managed database log stream websocket handlers', () => {
  it('rejects a client without database access before resolving the log target', async () => {
    const handlers = createHandlers();
    const ws = createWs();
    mocks.resolveWebSocketCredential.mockResolvedValue(null);

    handlers.onOpen(new Event('open'), ws as any);

    await waitForMessage(ws, {
      type: 'auth_error',
      message: 'Access revoked or token expired',
    });
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(mocks.resolveWebSocketCredential).toHaveBeenCalledWith(null, `databases:view:${DATABASE_ID}`);
    expect(mocks.resolveLogTarget).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as any);
  });

  it('closes an authenticated stream when the database node is unavailable', async () => {
    const handlers = createHandlers();
    const ws = createWs();
    mocks.getNode.mockReturnValue(undefined);

    handlers.onOpen(new Event('open'), ws as any);

    await waitForMessage(ws, {
      type: 'error',
      message: 'Database node is not connected',
    });
    expect(ws.close).toHaveBeenCalledWith(1011, 'Node not connected');
    expect(mocks.resolveLogTarget).toHaveBeenCalledWith(DATABASE_ID);
    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(mocks.registerLogStreamHandler).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as any);
  });

  it('opens history, follows new daemon lines, and loads more history on request', async () => {
    const olderLines = [...HISTORY_LINES, '2026-08-29T09:59:58.000000001Z oldest line'];
    mocks.getLogs.mockReset();
    mocks.getLogs.mockResolvedValueOnce(INITIAL_LINES).mockResolvedValueOnce(olderLines);
    const { handlers, ws } = await openStream();

    expect(mocks.getLogs).toHaveBeenNthCalledWith(1, DATABASE_ID, {
      tailLines: TAIL_LINES,
      follow: false,
      timestamps: true,
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'initial', lines: INITIAL_LINES, hasMore: true })
    );
    expect(mocks.sendManagedDatabaseLogsCommand).toHaveBeenCalledWith(TARGET.nodeId, TARGET.managedDatabaseId, {
      tailLines: 0,
      follow: true,
      timestamps: true,
      since: '2026-08-29T10:00:01.000000004Z',
    });

    registeredHandler?.(['2026-08-29T10:00:02.000000001Z live line'], false);
    await waitForMessage(ws, {
      type: 'new',
      lines: ['2026-08-29T10:00:02.000000001Z live line'],
    });

    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'load_more' }),
      }),
      ws as any
    );
    await waitForMessage(ws, { type: 'history', lines: olderLines, hasMore: false });

    expect(mocks.getLogs).toHaveBeenNthCalledWith(2, DATABASE_ID, {
      tailLines: 200,
      follow: false,
      timestamps: true,
      until: '2026-08-29T10:00:00.000000001Z',
    });

    handlers.onClose(new Event('close'), ws as any);
  });

  it('stops and closes the stream when the daemon reports the stream ended', async () => {
    const { handlers, ws } = await openStream();

    registeredHandler?.([], true);

    await waitForMessage(ws, { type: 'logs_ended' });
    expect(ws.close).toHaveBeenCalledWith(1000, 'Log stream ended');

    handlers.onClose(new Event('close'), ws as any);
    expect(mocks.removeLogStreamHandler).toHaveBeenCalledWith(`${TARGET.nodeId}:${TARGET.containerId}`);
    expect(mocks.removeLogStreamHandler).toHaveBeenCalledTimes(1);
    expect(mocks.stopManagedDatabaseLogStream).toHaveBeenCalledWith(TARGET.nodeId, TARGET.managedDatabaseId);
    expect(mocks.stopManagedDatabaseLogStream).toHaveBeenCalledTimes(1);
  });

  it('reports a daemon start failure and removes the registered handler', async () => {
    const handlers = createHandlers();
    const ws = createWs();
    mocks.sendManagedDatabaseLogsCommand.mockResolvedValue({
      success: false,
      error: 'daemon rejected log stream',
    });

    handlers.onOpen(new Event('open'), ws as any);

    await waitForMessage(ws, { type: 'error', message: 'daemon rejected log stream' });
    expect(ws.close).toHaveBeenCalledWith(1011, 'Stream start failed');
    expect(mocks.registerLogStreamHandler).toHaveBeenCalledWith(
      `${TARGET.nodeId}:${TARGET.containerId}`,
      expect.any(Function)
    );
    expect(mocks.removeLogStreamHandler).toHaveBeenCalledWith(`${TARGET.nodeId}:${TARGET.containerId}`);
    expect(mocks.stopManagedDatabaseLogStream).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as any);
  });

  it('revokes an active stream when the database scope disappears', async () => {
    const { handlers, ws } = await openStream();
    mocks.resolveWebSocketCredential.mockResolvedValueOnce(null);

    registeredHandler?.(['2026-08-29T10:00:02.000000001Z revoked line'], false);

    await waitForMessage(ws, {
      type: 'auth_error',
      message: 'Access revoked or token expired',
    });
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: 'new', lines: ['2026-08-29T10:00:02.000000001Z revoked line'] })
    );
    expect(mocks.removeLogStreamHandler).toHaveBeenCalledWith(`${TARGET.nodeId}:${TARGET.containerId}`);
    expect(mocks.removeLogStreamHandler).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(mocks.stopManagedDatabaseLogStream).toHaveBeenCalledWith(TARGET.nodeId, TARGET.managedDatabaseId)
    );
    expect(mocks.stopManagedDatabaseLogStream).toHaveBeenCalledTimes(1);

    handlers.onClose(new Event('close'), ws as any);
  });

  it.each(['close', 'error'] as const)('cleans up and stops the daemon stream on on%s', async (eventType) => {
    const { handlers, ws } = await openStream();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    if (eventType === 'close') {
      handlers.onClose(new Event('close'), ws as any);
    } else {
      handlers.onError(new Event('error'), ws as any);
    }

    expect(mocks.removeLogStreamHandler).toHaveBeenCalledWith(`${TARGET.nodeId}:${TARGET.containerId}`);
    expect(mocks.removeLogStreamHandler).toHaveBeenCalledTimes(1);
    expect(mocks.stopManagedDatabaseLogStream).toHaveBeenCalledWith(TARGET.nodeId, TARGET.managedDatabaseId);
    expect(mocks.stopManagedDatabaseLogStream).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
