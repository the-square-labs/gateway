import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES, createDockerExecWSHandlers } from '@/modules/docker/docker-exec.ws.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';

const authMocks = vi.hoisted(() => ({
  resolveWebSocketCredential: vi.fn(),
  resolveWebSocketCredentialForScopeBase: vi.fn(),
}));

vi.mock('@/modules/auth/websocket-auth.js', () => authMocks);

const NODE_ID = 'node-1';
const CONTAINER_ID = 'container-1';
const RESOURCE_ID = 'resource-1';
const EXEC_ID = 'exec-1';
const CREDENTIAL = { type: 'session', value: 'session-1' } as const;
const SCOPED_CONSOLE_SCOPE = `docker:containers:console:${NODE_ID}/${RESOURCE_ID}`;
const USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'users',
  scopes: [SCOPED_CONSOLE_SCOPE],
  isBlocked: false,
} as User;

type MockWebSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type Services = {
  dispatch: {
    sendDockerExecCommand: ReturnType<typeof vi.fn>;
    sendDockerFileCommand: ReturnType<typeof vi.fn>;
    sendExecInput: ReturnType<typeof vi.fn>;
  };
  registry: {
    getNode: ReturnType<typeof vi.fn>;
    registerExecHandler: ReturnType<typeof vi.fn>;
    removeExecHandler: ReturnType<typeof vi.fn>;
  };
  docker: {
    inspectContainer: ReturnType<typeof vi.fn>;
  };
};

function createWs(): MockWebSocket {
  return { send: vi.fn(), close: vi.fn() };
}

function sentMessages(ws: MockWebSocket): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>);
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function allowScopedAccess(): void {
  const authResult = { user: USER, scopes: [SCOPED_CONSOLE_SCOPE] };
  authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(authResult);
  authMocks.resolveWebSocketCredential.mockResolvedValue(authResult);
}

function registerServices(options: {
  inspectData?: Record<string, unknown>;
  execDetail?: string;
} = {}): Services {
  const dispatch = {
    sendDockerExecCommand: vi.fn().mockResolvedValue({
      success: true,
      detail: options.execDetail ?? JSON.stringify({ exec_id: EXEC_ID, is_new: true }),
    }),
    sendDockerFileCommand: vi.fn().mockResolvedValue({ success: false }),
    sendExecInput: vi.fn(),
  };
  const registry = {
    getNode: vi.fn().mockReturnValue({ nodeId: NODE_ID }),
    registerExecHandler: vi.fn(),
    removeExecHandler: vi.fn(),
  };
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue(
      options.inspectData ?? {
        scopeResourceId: RESOURCE_ID,
        Config: { Labels: {}, User: 'node' },
      }
    ),
  };

  container.registerInstance(NodeDispatchService, dispatch as never);
  container.registerInstance(NodeRegistryService, registry as never);
  container.registerInstance(DockerManagementService, docker as never);
  return { dispatch, registry, docker };
}

async function openSession(
  services: Services,
  shell = '/bin/sh'
): Promise<{
  handlers: ReturnType<typeof createDockerExecWSHandlers>;
  ws: MockWebSocket;
}> {
  const ws = createWs();
  const handlers = createDockerExecWSHandlers(NODE_ID, CONTAINER_ID, shell, CREDENTIAL);
  handlers.onOpen({} as never, ws as never);
  await settleAsyncWork();
  expect(services.registry.registerExecHandler).toHaveBeenCalledWith(EXEC_ID, expect.any(Function));
  return { handlers, ws };
}

function registeredOutputHandler(services: Services): (output: Record<string, unknown>) => void {
  return services.registry.registerExecHandler.mock.calls[0]?.[1] as (output: Record<string, unknown>) => void;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  container.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Docker exec WebSocket authentication lifecycle', () => {
  it('denies the connection when initial access is unavailable', async () => {
    const services = registerServices();
    authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(null);
    const ws = createWs();
    const handlers = createDockerExecWSHandlers(NODE_ID, CONTAINER_ID, '/bin/sh', CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(services.dispatch.sendDockerExecCommand).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });

  it('denies Gateway-internal containers even when the scoped permission matches', async () => {
    const services = registerServices({
      inspectData: {
        scopeResourceId: RESOURCE_ID,
        Config: {
          Labels: { 'wiolett.gateway.managed': 'secure-link-connector' },
          User: 'root',
        },
      },
    });
    allowScopedAccess();
    const ws = createWs();
    const handlers = createDockerExecWSHandlers(NODE_ID, CONTAINER_ID, '/bin/sh', CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(services.dispatch.sendDockerExecCommand).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });

  it('allows a container with a matching node/resource scope and registers its exec session', async () => {
    const services = registerServices();
    allowScopedAccess();

    const { handlers, ws } = await openSession(services);

    expect(authMocks.resolveWebSocketCredentialForScopeBase).toHaveBeenCalledWith(
      CREDENTIAL,
      'docker:containers:console'
    );
    expect(services.dispatch.sendDockerExecCommand).toHaveBeenCalledWith(
      NODE_ID,
      'create',
      expect.objectContaining({
        containerId: CONTAINER_ID,
        command: ['/bin/sh'],
        tty: true,
        stdin: true,
        user: 'node',
        sessionKey: USER.id,
      })
    );
    expect(sentMessages(ws)).toContainEqual({ type: 'connected', execId: EXEC_ID, shell: '/bin/sh', isNew: true });
    handlers.onClose({} as never, ws as never);
  });
});

describe('Docker exec WebSocket permission revocation', () => {
  it('blocks input after the scoped permission is revoked', async () => {
    const services = registerServices();
    allowScopedAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();
    authMocks.resolveWebSocketCredential.mockResolvedValue(null);

    await handlers.onMessage(
      { data: JSON.stringify({ type: 'input', data: Buffer.from('pwd').toString('base64') }) } as never,
      ws as never
    );

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(services.dispatch.sendExecInput).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });

  it('does not forward output or exit events after the scoped permission is revoked', async () => {
    const services = registerServices();
    allowScopedAccess();
    const { handlers, ws } = await openSession(services);
    const outputHandler = registeredOutputHandler(services);
    ws.send.mockClear();
    authMocks.resolveWebSocketCredential.mockResolvedValue(null);

    outputHandler({ data: Buffer.from('secret'), exited: true, exitCode: 7 });
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(sentMessages(ws)).not.toContainEqual(expect.objectContaining({ type: 'output' }));
    expect(sentMessages(ws)).not.toContainEqual(expect.objectContaining({ type: 'exit' }));
    handlers.onClose({} as never, ws as never);
  });
});

describe('Docker exec WebSocket replay and exit lifecycle', () => {
  it('replays buffered output and closes after forwarding a process exit', async () => {
    const services = registerServices({
      execDetail: JSON.stringify({
        exec_id: EXEC_ID,
        is_new: false,
        buffer: ['aGVsbG8=', 'd29ybGQ='],
      }),
    });
    allowScopedAccess();
    const { handlers, ws } = await openSession(services);
    const outputHandler = registeredOutputHandler(services);

    expect(sentMessages(ws)).toEqual([
      { type: 'connected', execId: EXEC_ID, shell: '/bin/sh', isNew: false },
      { type: 'output', data: 'aGVsbG8=' },
      { type: 'output', data: 'd29ybGQ=' },
    ]);

    outputHandler({ data: Buffer.from('live'), exited: true, exitCode: 23 });
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([
      { type: 'connected', execId: EXEC_ID, shell: '/bin/sh', isNew: false },
      { type: 'output', data: 'aGVsbG8=' },
      { type: 'output', data: 'd29ybGQ=' },
      { type: 'output', data: 'bGl2ZQ==' },
      { type: 'exit', exitCode: 23 },
    ]);
    expect(ws.close).toHaveBeenCalledWith(1000, 'Process exited');
    handlers.onClose({} as never, ws as never);
  });
});

describe('Docker exec WebSocket cleanup', () => {
  it('cleans the keepalive timer and registered output handler on close', async () => {
    const services = registerServices();
    allowScopedAccess();
    const { handlers, ws } = await openSession(services);
    const outputHandler = registeredOutputHandler(services);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    handlers.onClose({} as never, ws as never);

    expect(services.registry.removeExecHandler).toHaveBeenCalledWith(EXEC_ID, outputHandler);
    expect(services.registry.removeExecHandler).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    handlers.onClose({} as never, ws as never);
    expect(services.registry.removeExecHandler).toHaveBeenCalledTimes(1);
  });

  it('cleans the keepalive timer and registered output handler on error', async () => {
    const services = registerServices();
    allowScopedAccess();
    const { handlers, ws } = await openSession(services);
    const outputHandler = registeredOutputHandler(services);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    handlers.onError({} as never, ws as never);

    expect(services.registry.removeExecHandler).toHaveBeenCalledWith(EXEC_ID, outputHandler);
    expect(services.registry.removeExecHandler).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    handlers.onError({} as never, ws as never);
    expect(services.registry.removeExecHandler).toHaveBeenCalledTimes(1);
  });
});

describe('Docker exec WebSocket pre-auth lifecycle', () => {
  it('closes an unauthenticated socket that sends an oversized binary frame', async () => {
    registerServices();
    authMocks.resolveWebSocketCredentialForScopeBase.mockImplementation(() => new Promise(() => {}));
    const ws = createWs();
    const handlers = createDockerExecWSHandlers(NODE_ID, CONTAINER_ID, '/bin/sh', CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await handlers.onMessage(
      { data: new Uint8Array(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES + 1).buffer } as never,
      ws as never
    );

    expect(sentMessages(ws)).toEqual([{ type: 'error', message: 'Message too large before authentication' }]);
    expect(ws.close).toHaveBeenCalledWith(1009, 'Message too large');
    handlers.onClose({} as never, ws as never);
  });
});
