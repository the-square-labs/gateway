import 'reflect-metadata';
import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { resolveWebSocketCredentialForScopeBase } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import {
  createDockerExecWSHandlers,
  DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES,
  dockerDaemonIsolatesExecSessions,
  isDockerExecPreauthMessageTooLarge,
  parseDockerExecTerminalSize,
  resizeDockerExec,
  resolveDockerExecUser,
} from './docker-exec.ws.js';

vi.mock('@/modules/auth/websocket-auth.js', () => ({
  resolveWebSocketCredentialForScopeBase: vi.fn(),
}));
vi.mock('@/services/node-dispatch.service.js', () => ({ NodeDispatchService: class {} }));
vi.mock('./docker.service.js', () => ({ DockerManagementService: class {} }));
vi.mock('./availability/docker-availability.service.js', () => ({ DockerAvailabilityService: class {} }));
vi.mock('./docker-access-resource.service.js', () => ({ hasDockerResourceScope: vi.fn() }));
vi.mock('./docker-internal-containers.js', () => ({ inspectUserContainer: vi.fn() }));

describe('resolveDockerExecUser', () => {
  it('uses the configured container execution user when present', async () => {
    const docker = {
      inspectContainer: vi.fn().mockResolvedValue({ Config: { User: 'node' } }),
    };

    await expect(resolveDockerExecUser(docker as never, 'node-1', 'container-1')).resolves.toBe('node');
    expect(docker.inspectContainer).toHaveBeenCalledWith('node-1', 'container-1');
  });

  it('preserves uid and gid execution user values', async () => {
    const docker = {
      inspectContainer: vi.fn().mockResolvedValue({ Config: { User: '1000:1000' } }),
    };

    await expect(resolveDockerExecUser(docker as never, 'node-1', 'container-1')).resolves.toBe('1000:1000');
  });

  it('defaults to root when the container has no configured execution user', async () => {
    const docker = {
      inspectContainer: vi.fn().mockResolvedValue({ Config: { User: '' } }),
    };

    await expect(resolveDockerExecUser(docker as never, 'node-1', 'container-1')).resolves.toBe('root');
  });

  it('refuses instead of falling back to root when the container cannot be inspected', async () => {
    const docker = {
      inspectContainer: vi.fn().mockRejectedValue(new Error('inspect failed')),
    };

    await expect(resolveDockerExecUser(docker as never, 'node-1', 'container-1')).rejects.toThrow(
      'Could not inspect the container'
    );
  });

  it('refuses when inspect returns no container data', async () => {
    const docker = { inspectContainer: vi.fn().mockResolvedValue(null) };

    await expect(resolveDockerExecUser(docker as never, 'node-1', 'container-1')).rejects.toThrow(
      'Could not inspect the container'
    );
  });
});

describe('dockerDaemonIsolatesExecSessions', () => {
  it.each<[string | null, boolean]>([
    ['v2.4.4', false],
    ['v2.4.5-rc.1', false],
    ['v2.4.5', true],
    ['2.4.5', true],
    ['v2.5.0-docker-rc.1', true],
    ['v2.10.0', true],
    ['dev', true],
    [null, false],
    ['', false],
    ['unknown', false],
  ])('daemon %s isolates console sessions: %s', (version, expected) => {
    expect(dockerDaemonIsolatesExecSessions(version)).toBe(expected);
  });
});

describe('Docker exec WebSocket session isolation', () => {
  const auth = vi.mocked(resolveWebSocketCredentialForScopeBase);
  const scopes = ['docker:containers:console'];
  const as = (id: string) => ({ user: { id }, scopes }) as never;
  const created = (execId: string, isNew: boolean) => ({
    success: true,
    detail: JSON.stringify({ exec_id: execId, is_new: isNew, buffer: ['c2VjcmV0'] }),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    auth.mockResolvedValue(as('user-a'));
    vi.mocked(hasDockerResourceScope).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    container.reset();
  });

  function setup(daemonVersion: string | null) {
    const registry = new NodeRegistryService({} as never);
    vi.spyOn(registry, 'getNode').mockReturnValue({ nodeId: 'node' } as never);
    const dispatch = { sendDockerExecCommand: vi.fn(), sendDockerFileCommand: vi.fn(), sendExecInput: vi.fn() };
    const docker = { inspectContainer: vi.fn().mockResolvedValue({ Config: { User: 'app' } }) };
    const availability = {
      resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue({ nodeId: 'node', resourceId: 'scope' }),
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ daemonVersion }] }) }) }),
    };
    container.registerInstance(NodeRegistryService, registry);
    container.registerInstance(NodeDispatchService, dispatch as never);
    container.registerInstance(DockerManagementService, docker as never);
    container.registerInstance(DockerAvailabilityService, availability as never);
    container.registerInstance(TOKENS.DrizzleClient, db as never);
    const handlers = createDockerExecWSHandlers('node', 'container', '/bin/sh', null);
    const open = async (userId: string) => {
      auth.mockResolvedValueOnce(as(userId));
      const ws = { send: vi.fn(), close: vi.fn() } as unknown as WSContext;
      handlers.onOpen(new Event('open'), ws);
      await vi.advanceTimersByTimeAsync(0);
      return ws;
    };
    const messages = (ws: WSContext) => vi.mocked(ws.send).mock.calls.map(([value]) => JSON.parse(String(value)));
    return { registry, dispatch, docker, handlers, open, messages };
  }

  it('refuses the console instead of running as root when the container cannot be inspected', async () => {
    const test = setup('v2.10.0');
    test.docker.inspectContainer.mockRejectedValueOnce(new Error('inspect failed'));
    const ws = await test.open('user-a');
    expect(test.dispatch.sendDockerExecCommand).not.toHaveBeenCalled();
    expect(test.messages(ws)).toContainEqual({
      type: 'error',
      message: 'Could not inspect the container to determine its user, so the console was not opened',
    });
    expect(ws.close).toHaveBeenCalledWith(1011, 'Container user unavailable');
  });

  it.each(['v2.4.4', null])('daemon %s: never attaches a user to a session another user opened', async (version) => {
    const test = setup(version);
    const execId = `exec-shared-${version}`;
    test.dispatch.sendDockerExecCommand
      .mockResolvedValueOnce(created(execId, true))
      .mockResolvedValueOnce(created(execId, false));
    const owner = await test.open('user-a');
    expect(test.messages(owner)).toContainEqual({ type: 'connected', execId, shell: '/bin/sh', isNew: true });

    const other = await test.open('user-b');
    expect(test.dispatch.sendDockerExecCommand).toHaveBeenLastCalledWith(
      'node',
      'create',
      expect.objectContaining({ containerId: 'container', user: 'app', sessionKey: 'user-b' })
    );
    expect(other.close).toHaveBeenCalledWith(1008, 'Console session belongs to another user');
    expect(test.messages(other).map((message) => message.type)).toEqual(['auth_error']);
    expect(test.registry.getExecHandlerCount(execId)).toBe(1);
    test.registry.handleExecOutput(execId, { execId, data: Buffer.from('private'), exited: false, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.messages(other).some((message) => message.type === 'output')).toBe(false);
  });

  it('lets the creator reattach to its own session on a daemon without isolation', async () => {
    const test = setup('v2.4.4');
    test.dispatch.sendDockerExecCommand
      .mockResolvedValueOnce(created('exec-own', true))
      .mockResolvedValueOnce(created('exec-own', false));
    const first = await test.open('user-a');
    test.handlers.onClose({}, first);
    const again = await test.open('user-a');
    expect(again.close).not.toHaveBeenCalled();
    expect(test.messages(again)).toContainEqual({
      type: 'connected',
      execId: 'exec-own',
      shell: '/bin/sh',
      isNew: false,
    });
  });

  it('trusts session reuse on daemons that isolate sessions per user', async () => {
    const test = setup('v2.4.5');
    test.dispatch.sendDockerExecCommand.mockResolvedValueOnce(created('exec-b', false));
    const ws = await test.open('user-b');
    expect(test.dispatch.sendDockerExecCommand).toHaveBeenCalledWith(
      'node',
      'create',
      expect.objectContaining({ sessionKey: 'user-b' })
    );
    expect(ws.close).not.toHaveBeenCalled();
    expect(test.messages(ws)).toContainEqual({ type: 'connected', execId: 'exec-b', shell: '/bin/sh', isNew: false });
  });
});

describe('Docker exec terminal resize', () => {
  it('accepts positive integer terminal dimensions', () => {
    expect(parseDockerExecTerminalSize(24, 120)).toEqual({ rows: 24, cols: 120 });
  });

  it.each([
    [0, 120],
    [24, 0],
    [-1, 120],
    [24.5, 120],
    [24, Number.NaN],
    [65_536, 120],
  ])('rejects invalid terminal dimensions (%s, %s)', (rows, cols) => {
    expect(parseDockerExecTerminalSize(rows, cols)).toBeNull();
  });

  it('routes resize commands by Docker exec ID', async () => {
    const sendDockerExecCommand = vi.fn().mockResolvedValue({ success: true });

    await resizeDockerExec({ sendDockerExecCommand } as never, 'node-1', 'exec-1', { rows: 36, cols: 140 });

    expect(sendDockerExecCommand).toHaveBeenCalledWith('node-1', 'resize', {
      containerId: 'exec-1',
      rows: 36,
      cols: 140,
    });
  });

  it('surfaces daemon resize failures', async () => {
    const sendDockerExecCommand = vi.fn().mockResolvedValue({
      success: false,
      error: 'resize rejected',
    });

    await expect(
      resizeDockerExec({ sendDockerExecCommand } as never, 'node-1', 'exec-1', { rows: 24, cols: 80 })
    ).rejects.toThrow('resize rejected');
  });
});

describe('Docker exec unauthenticated message limit', () => {
  it('limits oversized UTF-8 and binary payloads before authentication', () => {
    expect(isDockerExecPreauthMessageTooLarge('{"type":"resize","rows":24,"cols":120}')).toBe(false);
    expect(isDockerExecPreauthMessageTooLarge('x'.repeat(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES))).toBe(false);
    expect(isDockerExecPreauthMessageTooLarge('x'.repeat(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES + 1))).toBe(true);
    expect(isDockerExecPreauthMessageTooLarge('€'.repeat(Math.ceil(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES / 3)))).toBe(
      true
    );
    expect(isDockerExecPreauthMessageTooLarge(new Uint8Array(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES + 1).buffer)).toBe(
      true
    );
  });
});
