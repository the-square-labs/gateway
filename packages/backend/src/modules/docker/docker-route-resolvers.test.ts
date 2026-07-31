import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { AppError } from '@/middleware/error-handler.js';
import { DOCKER_DEPLOYMENT_MANAGED_LABEL } from './docker-deployment-labels.js';
import {
  hasDockerNodeRouteAccess,
  resolveDockerContainerByName,
  resolveDockerDeploymentIdByName,
  resolveDockerNodeBySlug,
  resolveDockerVolumeByName,
} from './docker-route-resolvers.js';

function dbReturning(rows: unknown[]): DrizzleClient {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) } as unknown as DrizzleClient;
}

describe('Docker route resolvers', () => {
  it('authorizes broad and matching scoped Docker access only', () => {
    expect(hasDockerNodeRouteAccess(['docker:volumes:view'], 'node-1')).toBe(true);
    expect(hasDockerNodeRouteAccess(['docker:containers:manage:node-1'], 'node-1')).toBe(true);
    expect(hasDockerNodeRouteAccess(['docker:containers:manage:node-2'], 'node-1')).toBe(false);
    expect(hasDockerNodeRouteAccess(['docker:containers:create'], 'node-1')).toBe(false);
    expect(hasDockerNodeRouteAccess(['docker:containers:config:node-1'], 'node-1')).toBe(true);
    expect(hasDockerNodeRouteAccess(['docker:containers:export:node-1/container-1'], 'node-1')).toBe(true);
    expect(hasDockerNodeRouteAccess(['docker:containers:view:node-1/container-1'], 'node-1')).toBe(true);
  });

  it('resolves Docker nodes and deployments through exact database matches', async () => {
    const node = { id: 'node-1', slug: 'edge', type: 'docker' };
    await expect(resolveDockerNodeBySlug(dbReturning([node]), 'edge')).resolves.toBe(node);
    await expect(resolveDockerDeploymentIdByName(dbReturning([{ id: 'deployment-1' }]), 'node-1', 'API')).resolves.toBe(
      'deployment-1'
    );
    await expect(resolveDockerNodeBySlug(dbReturning([]), 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('accepts only the exact canonical container name and hides managed internals', async () => {
    await expect(
      resolveDockerContainerByName({ inspectContainer: vi.fn().mockResolvedValue({ Name: '/API' }) }, 'node-1', 'API')
    ).resolves.toMatchObject({ Name: '/API' });
    await expect(
      resolveDockerContainerByName({ inspectContainer: vi.fn().mockResolvedValue({ Name: '/api' }) }, 'node-1', 'API')
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      resolveDockerContainerByName(
        {
          inspectContainer: vi.fn().mockResolvedValue({
            Name: '/API',
            Config: { Labels: { [DOCKER_DEPLOYMENT_MANAGED_LABEL]: 'true' } },
          }),
        },
        'node-1',
        'API'
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('accepts only the exact canonical volume name and maps daemon misses to 404', async () => {
    await expect(
      resolveDockerVolumeByName({ inspectVolume: vi.fn().mockResolvedValue({ Name: 'Data' }) }, 'node-1', 'Data')
    ).resolves.toMatchObject({ Name: 'Data' });
    await expect(
      resolveDockerVolumeByName({ inspectVolume: vi.fn().mockResolvedValue({ Name: 'data' }) }, 'node-1', 'Data')
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      resolveDockerVolumeByName(
        { inspectVolume: vi.fn().mockRejectedValue(new AppError(502, 'DISPATCH_ERROR', 'volume not found')) },
        'node-1',
        'missing'
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
