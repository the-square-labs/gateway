import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { pageDeployments, pageTagActivations, pageTags } from '@/db/schema/index.js';
import { type PageTagActivationRequest, PageTagService } from './page-tag.service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const ACTIVATION_ID = '55555555-5555-4555-8555-555555555555';

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable in these service tests.
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function completionRequest(): PageTagActivationRequest {
  return {
    id: ACTIVATION_ID,
    projectId: PROJECT_ID,
    tagId: TAG_ID,
    tag: 'production',
    deploymentId: DEPLOYMENT_ID,
    publicSlug: 'abcdefghijklmnop',
    sequence: 10,
    expectedGeneration: 4,
    requestedById: null,
  };
}

function completionTransaction(finalStatus: () => Promise<unknown>) {
  return {
    update: vi.fn((table) => ({
      set: vi.fn((values) => ({
        where: vi.fn(() => {
          if (table === pageDeployments) return { returning: vi.fn(async () => [{ id: DEPLOYMENT_ID }]) };
          if (table === pageTags) return { returning: vi.fn(async () => [{ id: TAG_ID }]) };
          if (table === pageTagActivations && (values as { status?: string }).status === 'switching') {
            return { returning: vi.fn(async () => [{ id: ACTIVATION_ID }]) };
          }
          if (table === pageTagActivations && (values as { status?: string }).status === 'ready') {
            return { returning: finalStatus };
          }
          return { returning: vi.fn(async () => []) };
        }),
      })),
    })),
  };
}

describe('PageTagService activation ordering', () => {
  it('does not create a latest activation for an older Deployment than the current target', async () => {
    const results = [
      [{ id: DEPLOYMENT_ID, projectId: PROJECT_ID, status: 'ready', sequence: 10, publicSlug: 'older' }],
      [
        {
          id: TAG_ID,
          projectId: PROJECT_ID,
          name: 'latest',
          system: true,
          deploymentId: '44444444-4444-4444-8444-444444444444',
          generation: 3,
        },
      ],
      [{ sequence: 11 }],
      [{ sequence: null }],
    ];
    const tx = {
      select: vi.fn(() => selectChain(results.shift() ?? [])),
      update: vi.fn(),
      insert: vi.fn(),
    };
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new PageTagService(db as unknown as DrizzleClient, { log: vi.fn() } as never);

    await expect(
      service.beginActivation(PROJECT_ID, 'latest', DEPLOYMENT_ID, null, { systemLatest: true })
    ).resolves.toBeNull();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('prevents a superseded activation from changing the Tag generation target', async () => {
    const request: PageTagActivationRequest = {
      id: ACTIVATION_ID,
      projectId: PROJECT_ID,
      tagId: TAG_ID,
      tag: 'latest',
      deploymentId: DEPLOYMENT_ID,
      publicSlug: 'abcdefghijklmnop',
      sequence: 10,
      expectedGeneration: 4,
      requestedById: null,
    };
    const activationFailure = vi.fn();
    const tx = {
      update: vi.fn((table) => ({
        set: vi.fn((values) => ({
          where: vi.fn(() => {
            if (table === pageDeployments) return { returning: vi.fn(async () => [{ id: DEPLOYMENT_ID }]) };
            if (table === pageTags) return { returning: vi.fn(async () => []) };
            if (table === pageTagActivations && (values as { failureCode?: string }).failureCode) {
              activationFailure(values);
            }
            return { returning: vi.fn(async () => []) };
          }),
        })),
      })),
    };
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const audit = { log: vi.fn() };
    const service = new PageTagService(db as unknown as DrizzleClient, audit as never);

    await expect(service.completeActivation(request)).resolves.toBe(false);
    expect(activationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureCode: 'PAGE_TAG_ACTIVATION_SUPERSEDED' })
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rejects an empty final activation CAS before committing the Tag deployment', async () => {
    const finalStatus = vi.fn(async () => []);
    const tx = completionTransaction(finalStatus);
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new PageTagService(db as unknown as DrizzleClient, { log: vi.fn() } as never);

    await expect(service.completeActivation(completionRequest())).rejects.toMatchObject({
      code: 'PAGE_TAG_ACTIVATION_CHANGED',
    });
    expect(finalStatus).toHaveBeenCalledOnce();
  });

  it('propagates a final activation DB error without auditing a Tag move', async () => {
    const dbError = new Error('activation status write failed');
    const audit = { log: vi.fn() };
    const tx = completionTransaction(async () => {
      throw dbError;
    });
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new PageTagService(db as unknown as DrizzleClient, audit as never);

    await expect(service.completeActivation(completionRequest())).rejects.toBe(dbError);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses direct user management of the reserved latest Tag', async () => {
    const service = new PageTagService({} as DrizzleClient, { log: vi.fn() } as never);

    await expect(service.beginActivation(PROJECT_ID, 'latest', DEPLOYMENT_ID, 'user-1')).rejects.toMatchObject({
      code: 'PAGE_TAG_SYSTEM_MANAGED',
    });
  });
});
