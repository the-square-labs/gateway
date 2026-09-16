import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { objectStorageRoutes } from './object-storage.routes.js';
import { ObjectStorageService } from './object-storage.service.js';
import { ObjectStorageMonitoringService } from './object-storage-monitoring.service.js';

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireScopeForResource: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

afterEach(() => {
  container.clearInstances();
  vi.restoreAllMocks();
});

describe('Storage monitoring stream', () => {
  it('delivers retained snapshots before live polling and releases subscriptions on disconnect', async () => {
    const storageId = '11111111-1111-4111-8111-111111111111';
    const connection = { id: storageId, healthStatus: 'online' };
    const monitoring = Object.assign(new EventEmitter(), {
      getInitialHistory: vi.fn().mockResolvedValue([{ storageId, metrics: { cpu_pct: 12 } }]),
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
    });
    container.registerInstance(ObjectStorageService, {
      get: vi.fn().mockResolvedValue(connection),
      getHealthHistory: vi.fn().mockResolvedValue([]),
    } as unknown as ObjectStorageService);
    container.registerInstance(ObjectStorageMonitoringService, monitoring as unknown as ObjectStorageMonitoringService);
    const app = new Hono<AppEnv>().route('/storage', objectStorageRoutes);
    const response = await app.request(`/storage/${storageId}/monitoring/stream`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('event: history')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      body += decoder.decode(chunk.value);
    }
    expect(body).toContain('event: connected');
    expect(body).toContain('"cpu_pct":12');
    expect(monitoring.getInitialHistory).toHaveBeenCalledWith(connection);
    await vi.waitFor(() => expect(monitoring.registerClient).toHaveBeenCalledWith(storageId));
    await reader.cancel();
    await vi.waitFor(() => expect(monitoring.unregisterClient).toHaveBeenCalledTimes(1));
    expect(monitoring.listenerCount('snapshot')).toBe(0);
  });
});
