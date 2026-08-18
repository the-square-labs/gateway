import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import { PageMaintenanceService } from './page-maintenance.service.js';
import type { PageRetentionService } from './page-retention.service.js';

function queryChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin']) chain[method] = vi.fn(() => chain);
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable in these service tests.
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe('PageMaintenanceService', () => {
  it('expires stalled uploads, removes temporary data, and then applies retention', async () => {
    const tempKey = 'uploads/11111111-1111-4111-8111-111111111111.part';
    const row = {
      session: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'open',
        tempKey,
      },
      deployment: {
        id: '22222222-2222-4222-8222-222222222222',
        projectId: '33333333-3333-4333-8333-333333333333',
        publicSlug: 'abcdefghijklmnop',
      },
    };
    let updateCall = 0;
    const db = {
      select: vi.fn(() => queryChain([row])),
      transaction: vi.fn(async (callback) => {
        const tx = {
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn(() => {
                updateCall += 1;
                return updateCall === 1
                  ? { returning: vi.fn(async () => [{ id: row.session.id }]) }
                  : Promise.resolve();
              }),
            })),
          })),
        };
        return callback(tx);
      }),
    };
    const store = { remove: vi.fn(async () => {}) };
    const retention = {
      runAll: vi.fn(async () => ({ itemsCleaned: 1, spaceFreedBytes: 2048, protectedOverLimit: 0 })),
    };
    const eventBus = { publish: vi.fn() };
    const service = new PageMaintenanceService(
      db as unknown as DrizzleClient,
      store as unknown as PageArtifactStore,
      retention as unknown as PageRetentionService,
      eventBus as unknown as EventBusService
    );

    await expect(service.run()).resolves.toEqual({ itemsCleaned: 2, spaceFreedBytes: 2048 });
    expect(store.remove).toHaveBeenCalledWith(tempKey);
    expect(eventBus.publish).toHaveBeenCalledWith(
      'pages.deployment.changed',
      expect.objectContaining({
        projectId: row.deployment.projectId,
        status: 'failed',
        failureCode: 'PAGES_UPLOAD_EXPIRED',
      })
    );
    expect(retention.runAll).toHaveBeenCalledOnce();
  });
});
