import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { DockerManagementService } from './docker.service.js';
import {
  DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES,
  createDockerExecWSHandlers,
  isDockerExecPreauthMessageTooLarge,
  parseDockerExecTerminalSize,
  resizeDockerExec,
  resolveDockerExecUser,
} from './docker-exec.ws.js';

const authMocks = vi.hoisted(() => ({
  resolveWebSocketCredential: vi.fn(),
  resolveWebSocketCredentialForScopeBase: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('@/modules/auth/websocket-auth.js', () => authMocks);

afterEach(() => {
  container.reset();
  vi.clearAllMocks();
});

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

  it('defaults to root when the container cannot be inspected', async () => {
    const docker = {
      inspectContainer: vi.fn().mockRejectedValue(new Error('inspect failed')),
    };

    await expect(resolveDockerExecUser(docker as never, 'node-1', 'container-1')).resolves.toBe('root');
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
    expect(isDockerExecPreauthMessageTooLarge('€'.repeat(Math.ceil(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES / 3)))).toBe(true);
    expect(isDockerExecPreauthMessageTooLarge(new Uint8Array(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES + 1).buffer)).toBe(
      true
    );
  });

  it('closes an unauthenticated socket that sends an oversized binary frame', async () => {
    container.registerInstance(NodeDispatchService, {} as NodeDispatchService);
    container.registerInstance(NodeRegistryService, {} as NodeRegistryService);
    container.registerInstance(DockerManagementService, {} as DockerManagementService);
    const ws = { send: vi.fn(), close: vi.fn() };
    const handlers = createDockerExecWSHandlers('node-1', 'container-1', '/bin/sh', null);

    handlers.onOpen({} as never, ws as never);
    await handlers.onMessage(
      { data: new Uint8Array(DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES + 1).buffer } as never,
      ws as never
    );

    expect(JSON.parse(String(ws.send.mock.calls[0]?.[0]))).toEqual({
      type: 'error',
      message: 'Message too large before authentication',
    });
    expect(ws.close).toHaveBeenCalledWith(1009, 'Message too large');
    handlers.onClose({} as never, ws as never);
  });
});
