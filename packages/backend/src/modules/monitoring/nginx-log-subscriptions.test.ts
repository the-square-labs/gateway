import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  getNginxLogHistory,
  logRelay,
  NGINX_LOG_SUBSCRIBE_ACK_EVENT,
  type RelayedLogEntry,
  resetNginxLogHistoryForTest,
} from './log-relay.service.js';
import {
  requestNginxHostLogHistory,
  resetNginxLogSubscriptionsForTest,
  subscribeNginxHostLogs,
} from './nginx-log-subscriptions.js';

function createRegistry(node: unknown): NodeRegistryService {
  return {
    getNode: vi.fn(() => node),
  } as unknown as NodeRegistryService;
}

describe('subscribeNginxHostLogs', () => {
  beforeEach(() => {
    resetNginxLogSubscriptionsForTest();
    resetNginxLogHistoryForTest();
  });

  it('subscribes and unsubscribes nginx log stream', () => {
    const write = vi.fn();
    const registry = createRegistry({ type: 'nginx', logStream: { write } });

    const subscription = subscribeNginxHostLogs(registry, 'node-1', 'host-1', 50);

    expect(subscription.ok).toBe(true);
    expect(write).toHaveBeenCalledWith({ subscribe: { hostId: 'host-1', tailLines: 50 } });

    if (subscription.ok) subscription.cleanup();

    expect(write).toHaveBeenLastCalledWith({ unsubscribe: { hostId: 'host-1' } });
  });

  it('shares a daemon subscription across multiple SSE clients', () => {
    const write = vi.fn();
    const registry = createRegistry({ type: 'nginx', logStream: { write } });

    const first = subscribeNginxHostLogs(registry, 'node-1', 'host-1', 50);
    const second = subscribeNginxHostLogs(registry, 'node-1', 'host-1', 50);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);

    if (first.ok) first.cleanup();
    expect(write).toHaveBeenCalledTimes(1);

    if (second.ok) second.cleanup();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({ unsubscribe: { hostId: 'host-1' } });
  });

  it('resubscribes when the daemon log stream reconnects', () => {
    const firstWrite = vi.fn();
    const secondWrite = vi.fn();
    const node = { type: 'nginx', logStream: { write: firstWrite } };
    const registry = createRegistry(node);

    const first = subscribeNginxHostLogs(registry, 'node-1', 'host-1', 50);
    node.logStream = { write: secondWrite };
    const second = subscribeNginxHostLogs(registry, 'node-1', 'host-1', 50);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(firstWrite).toHaveBeenCalledTimes(1);
    expect(firstWrite).toHaveBeenCalledWith({ subscribe: { hostId: 'host-1', tailLines: 50 } });
    expect(secondWrite).toHaveBeenCalledTimes(1);
    expect(secondWrite).toHaveBeenCalledWith({ subscribe: { hostId: 'host-1', tailLines: 50 } });

    if (first.ok) first.cleanup();
    if (second.ok) second.cleanup();
    expect(secondWrite).toHaveBeenLastCalledWith({ unsubscribe: { hostId: 'host-1' } });
  });

  it('returns an error when nginx log stream is unavailable', () => {
    const registry = createRegistry({ type: 'nginx', logStream: null });

    const subscription = subscribeNginxHostLogs(registry, 'node-1', 'host-1', 50);

    expect(subscription).toEqual({ ok: false, message: 'Nginx log stream is not connected' });
  });

  it('loads history only from the requested node and host', async () => {
    const write = vi.fn();
    const registry = createRegistry({ type: 'nginx', logStream: { write } });
    const entry: RelayedLogEntry = {
      nodeId: 'node-1',
      hostId: 'host-1',
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

    const resultPromise = requestNginxHostLogHistory(registry, 'node-1', 'host-1', 1, 50);
    logRelay.emit('log', { ...entry, nodeId: 'node-2' });
    logRelay.emit('log', entry);
    logRelay.emit(NGINX_LOG_SUBSCRIBE_ACK_EVENT, { nodeId: 'node-2', hostId: 'host-1' });
    logRelay.emit(NGINX_LOG_SUBSCRIBE_ACK_EVENT, { nodeId: 'node-1', hostId: 'host-1' });

    await expect(resultPromise).resolves.toEqual({ ok: true, entries: [entry] });
    expect(write).toHaveBeenCalledWith({ subscribe: { hostId: 'host-1', tailLines: -1 } });
  });

  it('does not complete history requests from another node ack', async () => {
    const write = vi.fn();
    const registry = createRegistry({ type: 'nginx', logStream: { write } });

    const resultPromise = requestNginxHostLogHistory(registry, 'node-1', 'host-1', 1, 10);
    logRelay.emit(NGINX_LOG_SUBSCRIBE_ACK_EVENT, { nodeId: 'node-2', hostId: 'host-1' });

    await expect(resultPromise).resolves.toEqual({ ok: false, message: 'Timed out while loading nginx log history' });
  });

  it('retains a bounded server-side host buffer for reconnect replay', () => {
    const baseEntry: RelayedLogEntry = {
      nodeId: 'node-1',
      hostId: 'host-1',
      timestamp: '2026-08-28T00:00:00.000Z',
      remoteAddr: '127.0.0.1',
      method: 'GET',
      path: '/',
      status: 200,
      bodyBytesSent: '0',
      raw: 'log',
      logType: 'access',
      level: '',
    };

    for (let index = 0; index < 305; index += 1) {
      logRelay.emit('log', {
        ...baseEntry,
        timestamp: `2026-08-28T00:00:${String(index).padStart(3, '0')}Z`,
      });
    }

    const replay = getNginxLogHistory('host-1');
    expect(replay).toHaveLength(300);
    expect(replay[0]?.timestamp).toContain('005Z');
    replay.length = 0;
    expect(getNginxLogHistory('host-1')).toHaveLength(300);
  });
});
