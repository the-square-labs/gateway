import 'reflect-metadata';
import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { resolveWebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { createManagedDatabaseLogStreamWSHandlers } from './managed-database-logs.ws.js';
import { ManagedDatabaseService } from './managed-databases.service.js';

vi.mock('@/modules/auth/websocket-auth.js', () => ({ resolveWebSocketCredential: vi.fn() }));
vi.mock('@/services/node-dispatch.service.js', () => ({ NodeDispatchService: class {} }));
vi.mock('./managed-databases.service.js', () => ({ ManagedDatabaseService: class {} }));

const auth = vi.mocked(resolveWebSocketCredential);
const target = { nodeId: 'node', containerId: 'container', managedDatabaseId: 'mdb' };
const credential = { type: 'session', value: 'session' } as const;

beforeEach(() => {
  vi.useFakeTimers();
  auth.mockResolvedValue({ user: { id: 'user' }, scopes: ['databases:view:db'] } as never);
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
  const dispatch = {
    sendManagedDatabaseLogsCommand: vi.fn().mockResolvedValue({ success: true }),
    stopManagedDatabaseLogStream: vi.fn().mockResolvedValue({ success: true }),
  };
  const databases = {
    resolveLogTarget: vi.fn().mockResolvedValue(target),
    getLogs: vi.fn().mockResolvedValue(['2026-09-23T10:00:00.000000001Z first']),
  };
  container.registerInstance(NodeRegistryService, registry);
  container.registerInstance(NodeDispatchService, dispatch as never);
  container.registerInstance(ManagedDatabaseService, databases as never);
  const open = async () => {
    const handlers = createManagedDatabaseLogStreamWSHandlers('db', 200, credential);
    const ws = { send: vi.fn(), close: vi.fn() } as unknown as WSContext;
    handlers.onOpen(new Event('open'), ws);
    await vi.advanceTimersByTimeAsync(0);
    return { ws, close: () => handlers.onClose({}, ws) };
  };
  const newLines = (ws: WSContext) =>
    vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => JSON.parse(String(value)))
      .filter((message) => message.type === 'new')
      .flatMap((message) => message.lines);
  return { registry, dispatch, open, newLines };
}

describe('managed database log viewers', () => {
  it('fans one follow stream out to every viewer instead of freezing the first', async () => {
    const test = setup();
    const first = await test.open();
    const second = await test.open();

    test.registry.handleLogStream('node:container', ['line-1']);
    await vi.advanceTimersByTimeAsync(0);

    expect(test.newLines(first.ws)).toEqual(['line-1']);
    expect(test.newLines(second.ws)).toEqual(['line-1']);
  });

  it('keeps following for the remaining viewer and stops only when the last one leaves', async () => {
    const test = setup();
    const first = await test.open();
    const second = await test.open();

    first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.dispatch.stopManagedDatabaseLogStream).not.toHaveBeenCalled();
    test.registry.handleLogStream('node:container', ['line-2']);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.newLines(second.ws)).toEqual(['line-2']);

    second.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.dispatch.stopManagedDatabaseLogStream).toHaveBeenCalledTimes(1);
    expect(test.dispatch.stopManagedDatabaseLogStream).toHaveBeenCalledWith('node', 'mdb');
  });

  it('checks access at open and every 30 seconds, not per log chunk', async () => {
    const test = setup();
    const viewer = await test.open();
    expect(auth).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) test.registry.handleLogStream('node:container', [`line-${i}`]);
    await vi.advanceTimersByTimeAsync(0);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(test.newLines(viewer.ws)).toHaveLength(5);

    auth.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(auth).toHaveBeenCalledTimes(2);
    expect(viewer.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect(test.dispatch.stopManagedDatabaseLogStream).toHaveBeenCalledTimes(1);
  });
});
