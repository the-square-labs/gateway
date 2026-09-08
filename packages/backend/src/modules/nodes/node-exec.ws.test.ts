import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { createDockerExecWSHandlers } from '@/modules/docker/docker-exec.ws.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { createNodeExecWSHandlers, EXEC_OUTPUT_MAX_BYTES, EXEC_OUTPUT_MAX_CHUNKS } from './node-exec.ws.js';

const auth = vi.hoisted(() => ({
  resolveWebSocketCredential: vi.fn(),
  resolveWebSocketCredentialForScopeBase: vi.fn(),
}));
vi.mock('@/modules/auth/websocket-auth.js', () => auth);
vi.mock('@/lib/logger.js', () => ({ createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));
const allowed = {
  user: { id: 'user', isBlocked: false },
  scopes: ['nodes:console:n', 'docker:containers:console:n/r'],
};
const credential = { type: 'session', value: 'session' } as const;
const result = { success: true, detail: '{"exec_id":"exec"}' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.resolveWebSocketCredential.mockReset().mockResolvedValue(allowed);
  auth.resolveWebSocketCredentialForScopeBase.mockReset().mockResolvedValue(allowed);
});
afterEach(() => {
  container.clearInstances();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each(['node', 'docker'] as const)('%s console lifetime', (kind) => {
  function setup() {
    const dispatch = {
      sendNodeExecCommand: vi.fn().mockResolvedValue(result),
      sendDockerExecCommand: vi.fn().mockResolvedValue(result),
      sendExecInput: vi.fn(),
    };
    const registry = { getNode: vi.fn().mockReturnValue({}), registerExecHandler: vi.fn(), removeExecHandler: vi.fn() };
    container.registerInstance(NodeDispatchService, dispatch as never);
    container.registerInstance(NodeRegistryService, registry as never);
    container.registerInstance(DockerManagementService, {
      inspectContainer: vi.fn().mockResolvedValue({ scopeResourceId: 'r', Config: { Labels: {}, User: 'node' } }),
    } as never);
    container.registerInstance(DockerAvailabilityService, {
      resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
    } as never);
    const handlers =
      kind === 'node'
        ? createNodeExecWSHandlers('n', '/bin/sh', credential)
        : createDockerExecWSHandlers('n', 'c', '/bin/sh', credential);
    const ws = { send: vi.fn(), close: vi.fn() };
    const authCall = kind === 'node' ? auth.resolveWebSocketCredential : auth.resolveWebSocketCredentialForScopeBase;
    const create = kind === 'node' ? dispatch.sendNodeExecCommand : dispatch.sendDockerExecCommand;
    return { handlers, ws, registry, dispatch, authCall, create };
  }

  it('does not create or register after close during authentication', async () => {
    const s = setup();
    const gate = deferred<typeof allowed>();
    s.authCall.mockReturnValueOnce(gate.promise);
    s.handlers.onOpen({} as never, s.ws as never);
    s.handlers.onClose({}, s.ws as never);
    gate.resolve(allowed);
    await settle();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.registry.registerExecHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not register after close during dispatch or remove unrelated reusable handlers', async () => {
    const s = setup();
    const gate = deferred<typeof result>();
    s.create.mockReturnValueOnce(gate.promise);
    s.handlers.onOpen({} as never, s.ws as never);
    await settle();
    expect(s.create).toHaveBeenCalledTimes(1);
    s.handlers.onClose({}, s.ws as never);
    gate.resolve(result);
    await settle();
    expect(s.registry.registerExecHandler).not.toHaveBeenCalled();
    expect(s.registry.removeExecHandler).not.toHaveBeenCalled();
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['bytes', 'chunks'] as const)('closes on %s backlog overflow and discards pending output', async (limit) => {
    const s = setup();
    s.handlers.onOpen({} as never, s.ws as never);
    await settle();
    const output = s.registry.registerExecHandler.mock.calls[0][1];
    const gate = deferred<typeof allowed>();
    s.authCall.mockReturnValue(gate.promise);
    s.ws.send.mockClear();
    const data = Buffer.alloc(limit === 'bytes' ? EXEC_OUTPUT_MAX_BYTES : 1);
    const count = limit === 'bytes' ? 2 : EXEC_OUTPUT_MAX_CHUNKS + 1;
    for (let i = 0; i < count; i++) output({ data });
    expect(s.ws.close).toHaveBeenCalledWith(1013, 'Terminal output backlog exceeded');
    expect(s.registry.removeExecHandler).toHaveBeenCalledWith('exec', output);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve(allowed);
    await settle();
    output({ data: Buffer.from('late') });
    await settle();
    expect(s.ws.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(['error']);
    expect(JSON.parse(s.ws.send.mock.calls[0][0]).code).toBe('EXEC_OUTPUT_OVERFLOW');
  });

  it('drops a pending authorized output on close and performs no further auth', async () => {
    const s = setup();
    s.handlers.onOpen({} as never, s.ws as never);
    await settle();
    const output = s.registry.registerExecHandler.mock.calls[0][1];
    const gate = deferred<typeof allowed>();
    s.authCall.mockReturnValue(gate.promise);
    s.ws.send.mockClear();
    output({ data: Buffer.from('secret') });
    s.handlers.onClose({}, s.ws as never);
    const calls = s.authCall.mock.calls.length;
    gate.resolve(allowed);
    await settle();
    output({ data: Buffer.from('late') });
    await settle();
    expect(s.ws.send).not.toHaveBeenCalled();
    expect(s.authCall).toHaveBeenCalledTimes(calls);
    expect(s.registry.removeExecHandler).toHaveBeenCalledTimes(1);
  });

  it('does not stack keepalive access checks while one is pending', async () => {
    const s = setup();
    s.handlers.onOpen({} as never, s.ws as never);
    await settle();
    const gate = deferred<typeof allowed>();
    s.authCall.mockReturnValue(gate.promise);
    const calls = s.authCall.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.authCall).toHaveBeenCalledTimes(calls + 1);
    s.handlers.onClose({}, s.ws as never);
    s.ws.send.mockClear();
    gate.resolve(allowed);
    await settle();
    expect(s.ws.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues draining ordered output below the limit without bypassing auth', async () => {
    const s = setup();
    s.handlers.onOpen({} as never, s.ws as never);
    await settle();
    const output = s.registry.registerExecHandler.mock.calls[0][1];
    const initialCalls = s.authCall.mock.calls.length;
    s.ws.send.mockClear();
    for (let i = 0; i < EXEC_OUTPUT_MAX_CHUNKS * 2; i++) {
      output({ data: Buffer.from(String(i)) });
      await settle();
    }
    expect(s.authCall).toHaveBeenCalledTimes(initialCalls + EXEC_OUTPUT_MAX_CHUNKS * 2);
    expect(s.ws.send).toHaveBeenCalledTimes(EXEC_OUTPUT_MAX_CHUNKS * 2);
    expect(s.ws.close).not.toHaveBeenCalled();
    s.handlers.onClose({}, s.ws as never);
    expect(vi.getTimerCount()).toBe(0);
  });

  if (kind === 'docker')
    it('fences handler registration after close during initial resize', async () => {
      const s = setup();
      const gate = deferred<typeof result>();
      s.create.mockResolvedValueOnce(result).mockReturnValueOnce(gate.promise);
      s.handlers.onOpen({} as never, s.ws as never);
      await s.handlers.onMessage(
        { data: JSON.stringify({ type: 'resize', rows: 24, cols: 80 }) } as never,
        s.ws as never
      );
      await settle();
      expect(s.create).toHaveBeenCalledTimes(2);
      s.handlers.onClose({}, s.ws as never);
      gate.resolve(result);
      await settle();
      expect(s.registry.registerExecHandler).not.toHaveBeenCalled();
      expect(s.registry.removeExecHandler).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
});
