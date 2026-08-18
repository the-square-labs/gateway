import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import { PageRetentionService } from './page-retention.service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const OLD_ID = '33333333-3333-4333-8333-333333333333';

function queryChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable in these service tests.
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function project() {
  return {
    id: PROJECT_ID,
    maxDeployments: 1,
    storageUsedBytes: 200,
    storageQuotaBytes: 1000,
  };
}

function deployment(id: string, sequence: number) {
  return {
    id,
    projectId: PROJECT_ID,
    sequence,
    publicSlug: sequence === 2 ? 'newdeployment12' : 'olddeployment12',
    status: 'ready',
    artifactKey: `artifacts/${PROJECT_ID}/${id}.tar.gz`,
    compressedSizeBytes: 100,
    pinned: false,
    updatedAt: new Date('2026-08-17T10:00:00Z'),
  };
}

describe('PageRetentionService', () => {
  it('never removes a Deployment referenced by a Tag even when over the version limit', async () => {
    const old = deployment(OLD_ID, 1);
    const rows = [[project()], [deployment(NEW_ID, 2), old], [], [{ deploymentId: OLD_ID }], [], [], [], []];
    const db = { select: vi.fn(() => queryChain(rows.shift() ?? [])), update: vi.fn() };
    const store = { remove: vi.fn() };
    const eventBus = { publish: vi.fn() };
    const service = new PageRetentionService(
      db as unknown as DrizzleClient,
      { log: vi.fn() } as never,
      store as unknown as PageArtifactStore
    );
    service.setEventBus(eventBus as never);

    await expect(service.runProject(PROJECT_ID)).resolves.toEqual({
      itemsCleaned: 0,
      spaceFreedBytes: 0,
      protectedOverLimit: 1,
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(eventBus.publish).toHaveBeenCalledWith(
      'pages.project.changed',
      expect.objectContaining({ action: 'quota.blocked', projectId: PROJECT_ID })
    );
  });

  it('cleans an unreferenced old Deployment and decrements canonical storage once', async () => {
    const old = deployment(OLD_ID, 1);
    const rows = [[project()], [deployment(NEW_ID, 2), old], [], [], [], [], [], [], [], [], [], [], []];
    const claimReturning = vi.fn(async () => [{ ...old, status: 'cleaning', updatedAt: new Date() }]);
    const db = {
      select: vi.fn(() => queryChain(rows.shift() ?? [])),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: claimReturning })) })) })),
      transaction: vi.fn(async (callback) => {
        let updateCall = 0;
        const tx = {
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn(() => {
                updateCall += 1;
                return updateCall === 1 ? { returning: vi.fn(async () => [{ id: OLD_ID }]) } : Promise.resolve();
              }),
            })),
          })),
        };
        return callback(tx);
      }),
    };
    const store = { remove: vi.fn(async () => {}) };
    const audit = { log: vi.fn(async () => {}) };
    const cleanupRetainedDeployment = vi.fn(async () => {});
    const service = new PageRetentionService(
      db as unknown as DrizzleClient,
      audit as never,
      store as unknown as PageArtifactStore
    );
    service.setRuntimeAdapter({ cleanupRetainedDeployment });

    await expect(service.runProject(PROJECT_ID)).resolves.toEqual({
      itemsCleaned: 1,
      spaceFreedBytes: 100,
      protectedOverLimit: 0,
    });
    expect(cleanupRetainedDeployment).toHaveBeenCalledWith(OLD_ID);
    expect(store.remove).toHaveBeenCalledWith(old.artifactKey);
    expect(cleanupRetainedDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      store.remove.mock.invocationCallOrder[0]!
    );
    expect(db.transaction).toHaveBeenCalledOnce();
  });
});
