import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { createComposeLogsWSHandlers } from '@/modules/docker/docker-compose-logs.ws.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';

const authMocks = vi.hoisted(() => ({
  resolveWebSocketCredentialForScopeBase: vi.fn(),
}));

vi.mock('@/modules/auth/websocket-auth.js', () => authMocks);

const NODE_ID = 'node-1';
const PROJECT = 'demo';
const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';
const API_CONTAINER_ID = 'container-api';
const WORKER_CONTAINER_ID = 'container-worker';
const CREDENTIAL = { type: 'session', value: 'session-1' } as const;
const PROJECT_SCOPE = `docker:compose:view:${NODE_ID}/${PROJECT_ID}`;
const OTHER_PROJECT_SCOPE = `docker:compose:view:${NODE_ID}/${OTHER_PROJECT_ID}`;

const USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'users',
  scopes: [PROJECT_SCOPE],
  isBlocked: false,
} as User;

const CONTAINERS = [
  {
    id: API_CONTAINER_ID,
    name: 'demo-api-1',
    labels: { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'api' },
    state: 'running',
    scopeResourceId: 'resource-api',
  },
  {
    id: WORKER_CONTAINER_ID,
    name: 'demo-worker-1',
    labels: { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'worker' },
    state: 'running',
    scopeResourceId: 'resource-worker',
  },
  {
    id: 'container-other-project',
    name: 'other-api-1',
    labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'api' },
    state: 'running',
    scopeResourceId: 'resource-other',
  },
];

type MockWebSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type CommandResult = {
  commandId: string;
  success: boolean;
  error: string;
  detail: string;
  data: Buffer;
};

type Services = {
  dispatch: {
    sendDockerLogsCommand: ReturnType<typeof vi.fn>;
  };
  registry: {
    getNode: ReturnType<typeof vi.fn>;
    registerLogStreamHandler: ReturnType<typeof vi.fn>;
    removeLogStreamHandler: ReturnType<typeof vi.fn>;
    handleLogStream: ReturnType<typeof vi.fn>;
  };
  docker: {
    listContainers: ReturnType<typeof vi.fn>;
  };
  compose: {
    findByName: ReturnType<typeof vi.fn>;
  };
};

type RegisterOptions = {
  containers?: typeof CONTAINERS;
  initialLogs?: Record<string, string[]>;
  historyLogs?: Record<string, string[]>;
  initialResult?: Partial<CommandResult>;
  followResult?: Partial<CommandResult>;
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

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    commandId: 'command-1',
    success: true,
    error: '',
    detail: '',
    data: Buffer.alloc(0),
    ...overrides,
  };
}

function allowProjectAccess(): void {
  authMocks.resolveWebSocketCredentialForScopeBase.mockImplementation((_credential, scope) =>
    scope === 'docker:compose:view' ? { user: USER, scopes: [PROJECT_SCOPE] } : null
  );
}

function registerServices(options: RegisterOptions = {}): Services {
  const containers = options.containers ?? CONTAINERS;
  const handlers = new Map<string, (lines: string[], ended?: boolean) => void>();
  const initialLogs = options.initialLogs ?? {
    [API_CONTAINER_ID]: [
      '2026-08-29T00:00:02.000Z api ready',
      '2026-08-29T00:00:04.000Z api request',
    ],
    [WORKER_CONTAINER_ID]: ['2026-08-29T00:00:03.000Z worker ready'],
  };
  const historyLogs = options.historyLogs ?? {};

  const dispatch = {
    sendDockerLogsCommand: vi.fn().mockImplementation((_nodeId, containerId, command) => {
      if (command.follow) return Promise.resolve(result(options.followResult));
      if (command.tailLines === 200) {
        return Promise.resolve(
          result({ detail: JSON.stringify(historyLogs[containerId] ?? []) })
        );
      }
      return Promise.resolve(
        result({
          ...options.initialResult,
          detail: options.initialResult?.detail ?? JSON.stringify(initialLogs[containerId] ?? []),
        })
      );
    }),
  };
  const registry = {
    getNode: vi.fn().mockReturnValue({ nodeId: NODE_ID }),
    registerLogStreamHandler: vi.fn((key, handler) => handlers.set(key, handler)),
    removeLogStreamHandler: vi.fn((key) => handlers.delete(key)),
    handleLogStream: vi.fn((key, lines, ended) => handlers.get(key)?.(lines, ended)),
  };
  const docker = {
    listContainers: vi.fn().mockResolvedValue(containers),
  };
  const compose = {
    findByName: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
  };

  container.registerInstance(NodeDispatchService, dispatch as never);
  container.registerInstance(NodeRegistryService, registry as never);
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerComposeService, compose as never);

  return { dispatch, registry, docker, compose };
}

async function openSession(
  services: Services,
  project = PROJECT
): Promise<{
  handlers: ReturnType<typeof createComposeLogsWSHandlers>;
  ws: MockWebSocket;
}> {
  const ws = createWs();
  const handlers = createComposeLogsWSHandlers(NODE_ID, project, CREDENTIAL);
  handlers.onOpen({} as never, ws as never);
  await settleAsyncWork();
  expect(services.registry.registerLogStreamHandler).toHaveBeenCalled();
  return { handlers, ws };
}

beforeEach(() => {
  vi.useFakeTimers();
  authMocks.resolveWebSocketCredentialForScopeBase.mockReset();
});

afterEach(() => {
  container.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Compose logs WebSocket initial authorization', () => {
  it('denies an unauthenticated initial connection before reading Docker state', async () => {
    const services = registerServices();
    authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(null);
    const ws = createWs();
    const handlers = createComposeLogsWSHandlers(NODE_ID, PROJECT, CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Auth failed');
    expect(services.docker.listContainers).not.toHaveBeenCalled();
    expect(services.dispatch.sendDockerLogsCommand).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });

  it('allows the requested project scope and exposes only that project history', async () => {
    const services = registerServices();
    allowProjectAccess();

    const { handlers, ws } = await openSession(services);

    expect(sentMessages(ws)).toEqual([
      {
        type: 'connected',
        project: PROJECT,
        containers: [
          { id: API_CONTAINER_ID, name: 'demo-api-1', service: 'api', state: 'running' },
          { id: WORKER_CONTAINER_ID, name: 'demo-worker-1', service: 'worker', state: 'running' },
        ],
      },
      {
        type: 'initial',
        lines: [
          'api | 2026-08-29T00:00:02.000Z api ready',
          'worker | 2026-08-29T00:00:03.000Z worker ready',
          'api | 2026-08-29T00:00:04.000Z api request',
        ],
        hasMore: false,
      },
    ]);
    expect(services.dispatch.sendDockerLogsCommand).toHaveBeenCalledWith(
      NODE_ID,
      API_CONTAINER_ID,
      expect.objectContaining({ tailLines: 0, follow: true, timestamps: true })
    );
    expect(services.dispatch.sendDockerLogsCommand).toHaveBeenCalledWith(
      NODE_ID,
      WORKER_CONTAINER_ID,
      expect.objectContaining({
        tailLines: 0,
        follow: true,
        timestamps: true,
        since: '2026-08-29T00:00:04.000Z',
      })
    );
    handlers.onClose({} as never, ws as never);
  });

  it('denies a project-scoped credential for a different project', async () => {
    const services = registerServices();
    authMocks.resolveWebSocketCredentialForScopeBase.mockImplementation((_credential, scope) =>
      scope === 'docker:compose:view' ? { user: USER, scopes: [OTHER_PROJECT_SCOPE] } : null
    );
    const ws = createWs();
    const handlers = createComposeLogsWSHandlers(NODE_ID, PROJECT, CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Auth failed');
    expect(services.docker.listContainers).not.toHaveBeenCalled();
    expect(services.dispatch.sendDockerLogsCommand).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });

  it('does not treat an unrelated node-details scope as Compose access', async () => {
    const services = registerServices();
    authMocks.resolveWebSocketCredentialForScopeBase.mockImplementation((_credential, scope) =>
      scope === 'docker:compose:view' ? { user: USER, scopes: ['nodes:details'] } : null
    );
    const ws = createWs();
    const handlers = createComposeLogsWSHandlers(NODE_ID, PROJECT, CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Auth failed');
    expect(services.docker.listContainers).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });
});

describe('Compose logs WebSocket permission revocation', () => {
  it('revalidates an active stream and stops forwarding after project access is revoked', async () => {
    const services = registerServices();
    allowProjectAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();
    ws.close.mockClear();
    authMocks.resolveWebSocketCredentialForScopeBase.mockResolvedValue(null);

    await vi.advanceTimersByTimeAsync(30_000);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'auth_error', message: 'Access revoked or token expired' }]);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    services.registry.handleLogStream(`${NODE_ID}:${API_CONTAINER_ID}`, ['2026-08-29T00:01:00.000Z secret']);
    await settleAsyncWork();
    expect(sentMessages(ws)).not.toContainEqual(expect.objectContaining({ type: 'new' }));
    handlers.onClose({} as never, ws as never);
  });
});

describe('Compose logs WebSocket history and follow lifecycle', () => {
  it('forwards authorized daemon follow lines with their service prefix', async () => {
    const services = registerServices();
    allowProjectAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();

    services.registry.handleLogStream(`${NODE_ID}:${WORKER_CONTAINER_ID}`, [
      '2026-08-29T00:01:00.000Z worker job complete',
    ]);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([
      {
        type: 'new',
        lines: ['worker | 2026-08-29T00:01:00.000Z worker job complete'],
      },
    ]);
    handlers.onClose({} as never, ws as never);
  });

  it('returns bounded older history for an authorized load_more request', async () => {
    const services = registerServices({
      containers: [CONTAINERS[0]],
      historyLogs: {
        [API_CONTAINER_ID]: ['2026-08-28T23:59:00.000Z api earlier'],
      },
    });
    allowProjectAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();

    await handlers.onMessage(
      { data: JSON.stringify({ type: 'load_more' }) } as never,
      ws as never
    );
    await settleAsyncWork();

    expect(sentMessages(ws)).toContainEqual({
      type: 'history',
      lines: ['api | 2026-08-28T23:59:00.000Z api earlier'],
      hasMore: false,
    });
    expect(services.dispatch.sendDockerLogsCommand).toHaveBeenCalledWith(
      NODE_ID,
      API_CONTAINER_ID,
      expect.objectContaining({
        tailLines: 200,
        follow: false,
        timestamps: true,
        until: expect.any(String),
      })
    );
    handlers.onClose({} as never, ws as never);
  });
});

describe('Compose logs WebSocket daemon lifecycle', () => {
  it('reports a clean daemon end and closes the stream', async () => {
    const services = registerServices();
    allowProjectAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();

    services.registry.handleLogStream(`${NODE_ID}:${API_CONTAINER_ID}`, [], true);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'logs_ended', service: 'api' }]);
    expect(ws.close).toHaveBeenCalledWith(1012, 'Compose container log stream ended');
    handlers.onClose({} as never, ws as never);
  });

  it('reports a follow-start failure and terminates the stream', async () => {
    const services = registerServices({ followResult: { success: false, error: 'daemon unavailable' } });
    allowProjectAccess();
    const ws = createWs();
    const handlers = createComposeLogsWSHandlers(NODE_ID, PROJECT, CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toContainEqual({ type: 'error', message: 'daemon unavailable' });
    expect(ws.close).toHaveBeenCalledWith(1011, 'Stream start failed');
    handlers.onClose({} as never, ws as never);
  });

  it('reports an initial daemon failure before registering follow handlers', async () => {
    const services = registerServices({
      initialResult: { success: false, error: 'initial daemon failure', detail: '' },
    });
    allowProjectAccess();
    const ws = createWs();
    const handlers = createComposeLogsWSHandlers(NODE_ID, PROJECT, CREDENTIAL);

    handlers.onOpen({} as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toContainEqual({ type: 'error', message: 'initial daemon failure' });
    expect(ws.close).toHaveBeenCalledWith(1011, 'Initial fetch failed');
    expect(services.registry.registerLogStreamHandler).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });
});

describe('Compose logs WebSocket cleanup and stop lifecycle', () => {
  it.each(['onClose', 'onError'] as const)('removes follow delivery and keepalive on %s', async (lifecycle) => {
    const services = registerServices();
    allowProjectAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();

    if (lifecycle === 'onClose') handlers.onClose({} as never, ws as never);
    else handlers.onError({} as never, ws as never);

    await vi.advanceTimersByTimeAsync(30_000);
    services.registry.handleLogStream(`${NODE_ID}:${API_CONTAINER_ID}`, ['2026-08-29T00:01:00.000Z after close']);
    await settleAsyncWork();

    expect(ws.send).not.toHaveBeenCalled();
    handlers.onClose({} as never, ws as never);
  });

  it('stops all follow handlers and acknowledges an explicit stop', async () => {
    const services = registerServices();
    allowProjectAccess();
    const { handlers, ws } = await openSession(services);
    ws.send.mockClear();

    await handlers.onMessage({ data: JSON.stringify({ type: 'stop' }) } as never, ws as never);
    await settleAsyncWork();

    expect(sentMessages(ws)).toEqual([{ type: 'stopped' }]);
    services.registry.handleLogStream(`${NODE_ID}:${API_CONTAINER_ID}`, ['2026-08-29T00:01:00.000Z after stop']);
    services.registry.handleLogStream(`${NODE_ID}:${WORKER_CONTAINER_ID}`, ['2026-08-29T00:01:00.000Z after stop']);
    await settleAsyncWork();
    expect(sentMessages(ws)).not.toContainEqual(expect.objectContaining({ type: 'new' }));
    handlers.onClose({} as never, ws as never);
  });
});
