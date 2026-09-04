import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';

const authMocks = vi.hoisted(() => ({
  resolveWebSocketCredential: vi.fn(),
  resolveWebSocketCredentialForScopeBase: vi.fn(),
}));

vi.mock('@/modules/auth/websocket-auth.js', () => authMocks);

import { createDockerLogStreamWSHandlers } from '@/modules/docker/docker-logs.ws.js';

const NODE_ID = 'node-1';
const CONTAINER_ID = 'container-1';
const RESOURCE_ID = 'resource-1';
const OTHER_RESOURCE_ID = 'resource-2';
const VIEW_SCOPE = 'docker:containers:view';
const RESOURCE_SCOPE = `${VIEW_SCOPE}:${NODE_ID}/${RESOURCE_ID}`;
const CREDENTIAL = { type: 'session' as const, value: 'session-1' };
const USER = { id: 'user-1' } as User;
const STREAM_KEY = `${NODE_ID}:${CONTAINER_ID}`;

const INITIAL_LINES = [
  '2026-08-29T10:00:00.000000001Z oldest line',
  '2026-08-29T10:00:01.000000002Z newest line',
];
const FOLLOW_LINE = '2026-08-29T10:00:02.000000003Z follow line';

type LogHandler = (lines: string[], ended?: boolean) => void;

function createWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

function readMessages(ws: ReturnType<typeof createWs>): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>);
}

function createRegistry(connected = true) {
  const handlers = new Map<string, LogHandler>();
  const registry = {
    getNode: vi.fn().mockReturnValue(connected ? { id: NODE_ID } : undefined),
    registerLogStreamHandler: vi.fn((key: string, handler: LogHandler) => {
      handlers.set(key, handler);
      return () => {
        registry.removeLogStreamHandler(key);
      };
    }),
    removeLogStreamHandler: vi.fn((key: string) => {
      handlers.delete(key);
    }),
    handleLogStream: vi.fn((key: string, lines: string[], ended?: boolean) => {
      handlers.get(key)?.(lines, ended);
    }),
  };

  return registry;
}

function registerDependencies(options: { inspect?: unknown; connected?: boolean } = {}) {
  const dispatch = {
    sendDockerLogsCommand: vi.fn(),
  };
  const registry = createRegistry(options.connected ?? true);
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue(
      options.inspect === undefined
        ? { scopeResourceId: RESOURCE_ID, Config: { Labels: {} } }
        : options.inspect
    ),
  };

  container.registerInstance(NodeDispatchService, dispatch as never);
  container.registerInstance(NodeRegistryService, registry as never);
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
  } as never);

  return { dispatch, registry, docker };
}

function configureAuth(scopes: string[] = [RESOURCE_SCOPE]) {
  const result = { user: USER, scopes };
  authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(result);
  authMocks.resolveWebSocketCredential.mockResolvedValue(result);
}

async function settleAsyncWork() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

async function openStream(options: { initialLines?: string[]; inspect?: unknown; followResult?: unknown } = {}) {
  configureAuth();
  const dependencies = registerDependencies({ inspect: options.inspect });
  const initialLines = options.initialLines ?? INITIAL_LINES;
  dependencies.dispatch.sendDockerLogsCommand
    .mockResolvedValueOnce({ success: true, detail: JSON.stringify(initialLines) })
    .mockResolvedValueOnce(options.followResult ?? { success: true });

  const ws = createWs();
  const handlers = createDockerLogStreamWSHandlers(NODE_ID, CONTAINER_ID, INITIAL_LINES.length, CREDENTIAL);
  handlers.onOpen(new Event('open'), ws as never);
  await settleAsyncWork();

  return { ...dependencies, handlers, ws };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
  container.reset();
});

describe('Docker log WebSocket initial authorization', () => {
  it('rejects a connection when the initial authentication is unavailable', async () => {
    authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(null);
    const { dispatch, docker, registry } = registerDependencies();
    const ws = createWs();
    const handlers = createDockerLogStreamWSHandlers(NODE_ID, CONTAINER_ID, INITIAL_LINES.length, CREDENTIAL);

    handlers.onOpen(new Event('open'), ws as never);
    await settleAsyncWork();

    expect(readMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(dispatch.sendDockerLogsCommand).not.toHaveBeenCalled();
    expect(registry.registerLogStreamHandler).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as never);
  });

  it('allows an exact resource-scoped container and starts history followed by live logs', async () => {
    const { dispatch, registry, docker, handlers, ws } = await openStream();

    expect(docker.inspectContainer).toHaveBeenCalledWith(NODE_ID, CONTAINER_ID);
    expect(dispatch.sendDockerLogsCommand).toHaveBeenNthCalledWith(1, NODE_ID, CONTAINER_ID, {
      tailLines: INITIAL_LINES.length,
      follow: false,
      timestamps: true,
    });
    expect(dispatch.sendDockerLogsCommand).toHaveBeenNthCalledWith(2, NODE_ID, CONTAINER_ID, {
      tailLines: 0,
      follow: true,
      timestamps: true,
      since: '2026-08-29T10:00:01.000000002Z',
    });
    expect(readMessages(ws)).toEqual([
      { type: 'initial', lines: INITIAL_LINES, hasMore: true },
      { type: 'connected', streaming: true },
    ]);
    expect(registry.registerLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY, expect.any(Function));
    expect(authMocks.resolveWebSocketCredential).not.toHaveBeenCalled();

    registry.handleLogStream(STREAM_KEY, [FOLLOW_LINE]);
    await settleAsyncWork();

    expect(readMessages(ws)).toContainEqual({ type: 'new', lines: [FOLLOW_LINE] });
    expect(authMocks.resolveWebSocketCredentialForScopeBase).toHaveBeenCalledWith(
      CREDENTIAL,
      VIEW_SCOPE
    );

    handlers.onClose(new Event('close'), ws as never);
  });

  it('denies a resource-scoped container that does not match the inspected resource', async () => {
    configureAuth([`${VIEW_SCOPE}:${NODE_ID}/${OTHER_RESOURCE_ID}`]);
    const { dispatch, docker, registry } = registerDependencies();
    const ws = createWs();
    const handlers = createDockerLogStreamWSHandlers(NODE_ID, CONTAINER_ID, INITIAL_LINES.length, CREDENTIAL);

    handlers.onOpen(new Event('open'), ws as never);
    await settleAsyncWork();

    expect(docker.inspectContainer).toHaveBeenCalledWith(NODE_ID, CONTAINER_ID);
    expect(readMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(dispatch.sendDockerLogsCommand).not.toHaveBeenCalled();
    expect(registry.registerLogStreamHandler).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as never);
  });

  it('denies a Gateway-internal container even when its resource scope matches', async () => {
    configureAuth();
    const { dispatch, docker, registry } = registerDependencies({
      inspect: {
        scopeResourceId: RESOURCE_ID,
        Config: { Labels: { 'wiolett.gateway.managed': 'secure-link-connector' } },
      },
    });
    const ws = createWs();
    const handlers = createDockerLogStreamWSHandlers(NODE_ID, CONTAINER_ID, INITIAL_LINES.length, CREDENTIAL);

    handlers.onOpen(new Event('open'), ws as never);
    await settleAsyncWork();

    expect(docker.inspectContainer).toHaveBeenCalledWith(NODE_ID, CONTAINER_ID);
    expect(readMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(dispatch.sendDockerLogsCommand).not.toHaveBeenCalled();
    expect(registry.registerLogStreamHandler).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as never);
  });
});

describe('Docker log WebSocket stream lifecycle', () => {
  it('revokes an active stream when the resource permission is removed', async () => {
    const stream = await openStream();
    authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(null);

    stream.registry.handleLogStream(STREAM_KEY, [FOLLOW_LINE]);
    await settleAsyncWork();

    expect(readMessages(stream.ws)).toContainEqual({
      type: 'auth_error',
      message: 'Access revoked or token expired',
    });
    expect(readMessages(stream.ws)).not.toContainEqual({ type: 'new', lines: [FOLLOW_LINE] });
    expect(stream.registry.removeLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY);
    expect(stream.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    stream.registry.handleLogStream(STREAM_KEY, ['2026-08-29T10:00:03.000000004Z after revoke']);
    await settleAsyncWork();
    expect(readMessages(stream.ws)).not.toContainEqual({
      type: 'new',
      lines: ['2026-08-29T10:00:03.000000004Z after revoke'],
    });

    stream.handlers.onClose(new Event('close'), stream.ws as never);
  });

  it('revokes an active stream during keepalive permission revalidation', async () => {
    const stream = await openStream();
    authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(null);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(readMessages(stream.ws)).toContainEqual({
      type: 'auth_error',
      message: 'Access revoked or token expired',
    });
    expect(stream.registry.removeLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY);
    expect(stream.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    stream.handlers.onClose(new Event('close'), stream.ws as never);
  });

  it('loads older history through the public message handler with an exclusive timestamp', async () => {
    const historyLines = Array.from({ length: 200 }, (_, index) =>
      index === 0 ? '2026-08-29T09:00:00.000000000Z older line' : `older line ${index}`
    );
    const stream = await openStream();
    stream.dispatch.sendDockerLogsCommand.mockResolvedValueOnce({
      success: true,
      detail: JSON.stringify(historyLines),
    });

    await stream.handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'load_more' }) }),
      stream.ws as never
    );
    await settleAsyncWork();

    expect(stream.dispatch.sendDockerLogsCommand).toHaveBeenNthCalledWith(3, NODE_ID, CONTAINER_ID, {
      tailLines: 200,
      follow: false,
      timestamps: true,
      until: '2026-08-29T10:00:00.000000000Z',
    });
    expect(readMessages(stream.ws)).toContainEqual({ type: 'history', lines: historyLines, hasMore: true });

    stream.handlers.onClose(new Event('close'), stream.ws as never);
  });

  it('stops the live handler through the public stop message', async () => {
    const stream = await openStream();
    stream.registry.removeLogStreamHandler.mockClear();

    await stream.handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'stop' }) }),
      stream.ws as never
    );

    expect(stream.registry.removeLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY);
    expect(readMessages(stream.ws)).toContainEqual({ type: 'stopped' });

    stream.registry.handleLogStream(STREAM_KEY, [FOLLOW_LINE]);
    await settleAsyncWork();
    expect(readMessages(stream.ws)).not.toContainEqual({ type: 'new', lines: [FOLLOW_LINE] });

    stream.handlers.onClose(new Event('close'), stream.ws as never);
  });

  it('closes after the daemon ends the follow stream', async () => {
    const stream = await openStream();

    stream.registry.handleLogStream(STREAM_KEY, [], true);
    await settleAsyncWork();

    expect(readMessages(stream.ws)).toContainEqual({ type: 'logs_ended' });
    expect(stream.ws.close).toHaveBeenCalledWith(1012, 'Log stream ended');

    stream.handlers.onClose(new Event('close'), stream.ws as never);
  });

  it('closes without starting follow mode when the initial daemon read fails', async () => {
    configureAuth();
    const { dispatch, registry } = registerDependencies();
    dispatch.sendDockerLogsCommand.mockRejectedValueOnce(new Error('daemon read failed'));
    const ws = createWs();
    const handlers = createDockerLogStreamWSHandlers(NODE_ID, CONTAINER_ID, INITIAL_LINES.length, CREDENTIAL);

    handlers.onOpen(new Event('open'), ws as never);
    await settleAsyncWork();

    expect(readMessages(ws)).toEqual([{ type: 'error', message: 'daemon read failed' }]);
    expect(ws.close).toHaveBeenCalledWith(1011, 'Initial fetch failed');
    expect(dispatch.sendDockerLogsCommand).toHaveBeenCalledTimes(1);
    expect(registry.registerLogStreamHandler).not.toHaveBeenCalled();

    handlers.onClose(new Event('close'), ws as never);
  });

  it('cleans the registered handler when the daemon rejects follow mode', async () => {
    const stream = await openStream({ followResult: { success: false, error: 'daemon follow failed' } });

    expect(readMessages(stream.ws)).toEqual([
      { type: 'initial', lines: INITIAL_LINES, hasMore: true },
      { type: 'error', message: 'daemon follow failed' },
    ]);
    expect(stream.ws.close).toHaveBeenCalledWith(1011, 'Stream start failed');
    expect(stream.registry.registerLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY, expect.any(Function));
    expect(stream.registry.removeLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY);

    stream.handlers.onClose(new Event('close'), stream.ws as never);
  });

  it.each(['onClose', 'onError'] as const)('cleans the keepalive timer and follow handler on %s', async (eventName) => {
    const stream = await openStream();
    stream.registry.removeLogStreamHandler.mockClear();
    authMocks.resolveWebSocketCredentialForScopeBase.mockClear();

    if (eventName === 'onClose') {
      stream.handlers.onClose(new Event('close'), stream.ws as never);
    } else {
      stream.handlers.onError(new Event('error'), stream.ws as never);
    }

    expect(stream.registry.removeLogStreamHandler).toHaveBeenCalledWith(STREAM_KEY);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(authMocks.resolveWebSocketCredentialForScopeBase).not.toHaveBeenCalled();

    stream.registry.handleLogStream(STREAM_KEY, [FOLLOW_LINE]);
    await settleAsyncWork();
    expect(readMessages(stream.ws)).not.toContainEqual({ type: 'new', lines: [FOLLOW_LINE] });
  });
});
