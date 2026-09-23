import 'reflect-metadata';
import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { resolveWebSocketCredentialForScopeBase } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { inspectUserContainer } from './docker-internal-containers.js';
import { createDockerLogStreamWSHandlers, DOCKER_LOG_FOLLOW_STOP_TAIL } from './docker-logs.ws.js';

vi.mock('@/modules/auth/websocket-auth.js', () => ({
  resolveWebSocketCredentialForScopeBase: vi.fn(),
}));
vi.mock('@/services/node-dispatch.service.js', () => ({ NodeDispatchService: class {} }));
vi.mock('./docker.service.js', () => ({ DockerManagementService: class {} }));
vi.mock('./availability/docker-availability.service.js', () => ({ DockerAvailabilityService: class {} }));
vi.mock('./docker-access-resource.service.js', () => ({ hasDockerResourceScope: vi.fn() }));
vi.mock('./docker-internal-containers.js', () => ({ inspectUserContainer: vi.fn() }));

const auth = vi.mocked(resolveWebSocketCredentialForScopeBase);
const inspect = vi.mocked(inspectUserContainer);
const allowed = { user: { id: 'user' }, scopes: ['docker:containers:view'] };
const success = { success: true, detail: '[]' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.mockResolvedValue(allowed as never);
  inspect.mockResolvedValue({ scopeResourceId: 'physical-scope' } as never);
  vi.mocked(hasDockerResourceScope).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  container.reset();
});

function setup() {
  const registry = new NodeRegistryService({} as never);
  vi.spyOn(registry, 'getNode').mockReturnValue({ nodeId: 'node' } as never);
  const register = vi.spyOn(registry, 'registerLogStreamHandler');
  const dispatch = { sendDockerLogsCommand: vi.fn().mockResolvedValue(success) };
  const availability = {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue({ nodeId: 'logical-node', resourceId: 'logical-scope' }),
  };
  container.registerInstance(NodeRegistryService, registry);
  container.registerInstance(NodeDispatchService, dispatch as never);
  container.registerInstance(DockerManagementService, {} as never);
  container.registerInstance(DockerAvailabilityService, availability as never);
  const handlers = createDockerLogStreamWSHandlers('node', 'container', 200, null);
  const open = () => {
    const ws = { send: vi.fn(), close: vi.fn() } as unknown as WSContext;
    handlers.onOpen(new Event('open'), ws);
    return ws;
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const messages = (ws: WSContext) => vi.mocked(ws.send).mock.calls.map(([value]) => JSON.parse(String(value)));
  const followCalls = () => logCommandOptions(dispatch).filter((options) => options.follow);
  const stopCalls = () =>
    logCommandOptions(dispatch).filter((options) => options.tailLines === DOCKER_LOG_FOLLOW_STOP_TAIL);
  return { registry, register, dispatch, availability, handlers, open, flush, messages, followCalls, stopCalls };
}

function logCommandOptions(dispatch: { sendDockerLogsCommand: ReturnType<typeof vi.fn> }) {
  return dispatch.sendDockerLogsCommand.mock.calls.map(([, , options]) => options as Record<string, unknown>);
}

describe('Docker log WebSocket ownership', () => {
  it.each([
    'auth',
    'placement',
    'inspect',
    'initial',
  ] as const)('does not register or start follow after closing during %s', async (stage) => {
    const test = setup();
    const pending = deferred<unknown>();
    if (stage === 'auth') auth.mockReturnValueOnce(pending.promise as never);
    if (stage === 'placement') test.availability.resolveRuntimeAccessIdentity.mockReturnValueOnce(pending.promise);
    if (stage === 'inspect') {
      test.availability.resolveRuntimeAccessIdentity.mockResolvedValueOnce(null);
      inspect.mockReturnValueOnce(pending.promise as never);
    }
    if (stage === 'initial') test.dispatch.sendDockerLogsCommand.mockReturnValueOnce(pending.promise);
    const old = test.open();
    await test.flush();
    test.handlers.onClose({}, old);
    const current = test.open();
    await test.flush();
    pending.resolve(stage === 'auth' ? allowed : stage === 'initial' ? success : { scopeResourceId: 'physical-scope' });
    await test.flush();

    expect(test.register).toHaveBeenCalledTimes(1);
    expect(test.dispatch.sendDockerLogsCommand.mock.calls.filter(([, , options]) => options.follow)).toHaveLength(1);
    expect(old.send).not.toHaveBeenCalled();
    expect(old.close).not.toHaveBeenCalled();
    test.registry.handleLogStream('node:container', ['live']);
    await test.flush();
    expect(test.messages(current)).toContainEqual({ type: 'new', lines: ['live'] });
  });

  it.each(['close', 'error', 'stop'] as const)('old %s cannot remove the newer live handler', async (action) => {
    const test = setup();
    const old = test.open();
    await test.flush();
    const current = test.open();
    await test.flush();
    if (action === 'close') test.handlers.onClose({}, old);
    if (action === 'error') test.handlers.onError(new Event('error'), old);
    if (action === 'stop') await test.handlers.onMessage(new MessageEvent('message', { data: '{"type":"stop"}' }), old);
    test.registry.handleLogStream('node:container', ['replacement']);
    await test.flush();
    expect(test.messages(current)).toContainEqual({ type: 'new', lines: ['replacement'] });
    expect(test.messages(old)).not.toContainEqual({ type: 'new', lines: ['replacement'] });
  });

  it.each(['reject', 'unsuccessful'] as const)('old follow-start %s cannot remove its replacement', async (failure) => {
    const test = setup();
    const pending = deferred<typeof success>();
    test.dispatch.sendDockerLogsCommand.mockResolvedValueOnce(success).mockReturnValueOnce(pending.promise);
    const old = test.open();
    await test.flush();
    const current = test.open();
    await test.flush();
    if (failure === 'reject') pending.reject(new Error('start failed'));
    else pending.resolve({ success: false, detail: '' });
    await test.flush();
    expect(old.close).toHaveBeenCalledWith(1011, 'Stream start failed');
    test.registry.handleLogStream('node:container', ['replacement']);
    await test.flush();
    expect(test.messages(current)).toContainEqual({ type: 'new', lines: ['replacement'] });
  });

  it('revocation removes only the revoked viewer and preserves logical authorization scope', async () => {
    const test = setup();
    const old = test.open();
    await test.flush();
    const current = test.open();
    await test.flush();
    // The first periodic re-check belongs to the older socket.
    auth.mockResolvedValueOnce(null as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(old.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(current.close).not.toHaveBeenCalled();
    test.registry.handleLogStream('node:container', ['replacement']);
    await test.flush();
    expect(test.messages(current)).toContainEqual({ type: 'new', lines: ['replacement'] });
    expect(test.messages(old)).not.toContainEqual({ type: 'new', lines: ['replacement'] });
    expect(test.stopCalls()).toHaveLength(0);
    expect(hasDockerResourceScope).toHaveBeenLastCalledWith(
      allowed.scopes,
      'docker:containers:view',
      'logical-node',
      'logical-scope'
    );
    expect(inspect).not.toHaveBeenCalled();
  });

  it('ignores access-revalidation results after the socket closes', async () => {
    const test = setup();
    const old = test.open();
    await test.flush();
    const pending = deferred<null>();
    auth.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    test.handlers.onClose({}, old);
    vi.mocked(old.send).mockClear();
    pending.resolve(null);
    await test.flush();
    expect(old.send).not.toHaveBeenCalled();
    expect(old.close).not.toHaveBeenCalled();
  });

  it('streams active logs and removes the current handler when authorization is revoked', async () => {
    const test = setup();
    const ws = test.open();
    await test.flush();
    expect(test.messages(ws)).toEqual([
      { type: 'initial', lines: [], hasMore: false },
      { type: 'connected', streaming: true },
    ]);
    test.registry.handleLogStream('node:container', ['live']);
    await test.flush();
    expect(test.messages(ws)).toContainEqual({ type: 'new', lines: ['live'] });
    auth.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(test.messages(ws)).toContainEqual({ type: 'auth_error', message: 'Access revoked or token expired' });
    const authCalls = auth.mock.calls.length;
    test.registry.handleLogStream('node:container', ['forbidden']);
    await test.flush();
    expect(auth).toHaveBeenCalledTimes(authCalls);
    expect(test.messages(ws)).not.toContainEqual({ type: 'new', lines: ['forbidden'] });
    expect(test.stopCalls()).toHaveLength(1);
  });

  it('checks access at open and on the timer, never per log chunk', async () => {
    const test = setup();
    const ws = test.open();
    await test.flush();
    const authCalls = auth.mock.calls.length;
    for (let index = 0; index < 5; index += 1) test.registry.handleLogStream('node:container', [`line ${index}`]);
    await test.flush();
    expect(auth).toHaveBeenCalledTimes(authCalls);
    expect(test.messages(ws).filter((message) => message.type === 'new')).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(auth).toHaveBeenCalledTimes(authCalls + 1);
  });

  it('fans live chunks out to every viewer of the same container', async () => {
    const test = setup();
    const first = test.open();
    await test.flush();
    const second = test.open();
    await test.flush();
    expect(test.register).toHaveBeenCalledTimes(1);
    test.registry.handleLogStream('node:container', ['shared']);
    await test.flush();
    expect(test.messages(first)).toContainEqual({ type: 'new', lines: ['shared'] });
    expect(test.messages(second)).toContainEqual({ type: 'new', lines: ['shared'] });
  });

  it.each([
    'close',
    'stop',
  ] as const)('one viewer %s keeps the other viewer and the daemon follow alive', async (action) => {
    const test = setup();
    const first = test.open();
    await test.flush();
    const second = test.open();
    await test.flush();
    if (action === 'close') test.handlers.onClose({}, first);
    else await test.handlers.onMessage(new MessageEvent('message', { data: '{"type":"stop"}' }), first);
    await test.flush();
    test.registry.handleLogStream('node:container', ['still live']);
    await test.flush();
    expect(test.messages(second)).toContainEqual({ type: 'new', lines: ['still live'] });
    expect(test.messages(first)).not.toContainEqual({ type: 'new', lines: ['still live'] });
    expect(test.stopCalls()).toHaveLength(0);
  });

  it('stops the daemon follow once the last viewer leaves', async () => {
    const test = setup();
    const first = test.open();
    await test.flush();
    const second = test.open();
    await test.flush();
    test.handlers.onClose({}, first);
    test.handlers.onError(new Event('error'), second);
    await test.flush();
    expect(test.dispatch.sendDockerLogsCommand).toHaveBeenLastCalledWith('node', 'container', {
      tailLines: DOCKER_LOG_FOLLOW_STOP_TAIL,
      follow: false,
    });
    expect(test.stopCalls()).toHaveLength(1);
    test.registry.handleLogStream('node:container', ['after stop']);
    await test.flush();
    expect(test.messages(first)).not.toContainEqual({ type: 'new', lines: ['after stop'] });
    expect(test.messages(second)).not.toContainEqual({ type: 'new', lines: ['after stop'] });
  });

  it('tolerates daemons that reject the follow stop', async () => {
    const test = setup();
    const ws = test.open();
    await test.flush();
    test.dispatch.sendDockerLogsCommand.mockRejectedValueOnce(new Error('unsupported'));
    test.handlers.onClose({}, ws);
    await test.flush();
    expect(test.stopCalls()).toHaveLength(1);
    const next = test.open();
    await test.flush();
    expect(test.messages(next)).toContainEqual({ type: 'connected', streaming: true });
  });

  it('restarts the daemon follow only after a pending stop has been handled', async () => {
    const test = setup();
    const first = test.open();
    await test.flush();
    const stop = deferred<typeof success>();
    test.dispatch.sendDockerLogsCommand.mockImplementation((_node: string, _container: string, options) =>
      options.tailLines === DOCKER_LOG_FOLLOW_STOP_TAIL ? stop.promise : Promise.resolve(success)
    );
    test.handlers.onClose({}, first);
    const next = test.open();
    await test.flush();
    expect(test.stopCalls()).toHaveLength(1);
    expect(test.followCalls()).toHaveLength(1);
    expect(test.messages(next)).not.toContainEqual({ type: 'connected', streaming: true });
    stop.resolve(success);
    await test.flush();
    expect(test.followCalls()).toHaveLength(2);
    expect(test.messages(next)).toContainEqual({ type: 'connected', streaming: true });
    test.registry.handleLogStream('node:container', ['resumed']);
    await test.flush();
    expect(test.messages(next)).toContainEqual({ type: 'new', lines: ['resumed'] });
  });

  it('does not reconnect a follow start that was stopped while its dispatch was pending', async () => {
    const test = setup();
    const pending = deferred<typeof success>();
    test.dispatch.sendDockerLogsCommand.mockResolvedValueOnce(success).mockReturnValueOnce(pending.promise);
    const ws = test.open();
    await test.flush();
    await test.handlers.onMessage(new MessageEvent('message', { data: '{"type":"stop"}' }), ws);
    pending.resolve(success);
    await test.flush();
    expect(test.messages(ws)).toContainEqual({ type: 'stopped' });
    expect(test.messages(ws)).not.toContainEqual({ type: 'connected', streaming: true });
  });
});
