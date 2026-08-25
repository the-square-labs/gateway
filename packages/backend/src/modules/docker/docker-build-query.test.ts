import { describe, expect, it, vi } from 'vitest';
import { DockerBuildQuery } from './docker-build-query.js';

describe('DockerBuildQuery', () => {
  it('includes persisted artifacts in build list rows', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const build = {
      id: '11111111-1111-4111-8111-111111111111',
      builderNodeId: null,
      createdAt: now,
    };
    const source = {
      targetKind: 'container',
      nodeId: '22222222-2222-4222-8222-222222222222',
      containerName: 'api',
      deploymentId: null,
      autoDeploy: true,
    };
    const artifact = {
      id: '33333333-3333-4333-8333-333333333333',
      buildId: build.id,
      status: 'ready',
      policyDecision: 'approved',
    };
    let selectCall = 0;
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                innerJoin: vi.fn(() => ({
                  leftJoin: vi.fn(() => ({
                    where: vi.fn(() => ({
                      orderBy: vi.fn(() => ({ limit: vi.fn(async () => [{ build, source, provider: 'github' }]) })),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return {
          from: vi.fn(() => ({ where: vi.fn(async () => [artifact]) })),
        };
      }),
    };

    await expect(new DockerBuildQuery(db as never).list()).resolves.toEqual([
      expect.objectContaining({
        id: build.id,
        artifact,
        sourceAutoDeploy: true,
        target: expect.objectContaining({ kind: 'container', name: 'api' }),
      }),
    ]);
  });
});
