import { describe, expect, it, vi } from 'vitest';
import { ProxyDockerUpstreamService } from './proxy-docker-upstream.service.js';

function queuedDb(results: Array<unknown[] | { where: unknown[] }>) {
  return {
    select: vi.fn(() => {
      const entry = results.shift() ?? [];
      const result = Array.isArray(entry) ? entry : entry.where;
      const query: any = {
        from: () => query,
        where: () => (Array.isArray(entry) ? query : Promise.resolve(result)),
        limit: async () => result,
      };
      return query;
    }),
  };
}

function snapshots(data: unknown[], refreshStatus: 'success' | 'error' = 'success') {
  return {
    getList: vi.fn(async () => ({
      data,
      revision: 1,
      observedAt: '2026-07-18T00:00:00Z',
      lastAttemptAt: '2026-07-18T00:00:00Z',
      lastError: refreshStatus === 'error' ? 'timeout' : null,
      refreshStatus,
    })),
  };
}

const connectedRegistry = { getNode: vi.fn(() => ({ id: 'node-1' })) };

describe('ProxyDockerUpstreamService', () => {
  it('keeps the container reference without depending on a published host endpoint', async () => {
    const service = new ProxyDockerUpstreamService(
      queuedDb([
        [
          {
            id: 'node-1',
            type: 'docker',
            status: 'online',
            serviceAddress: 'docker.internal',
            lastHealthReport: { localIpAddresses: ['10.0.0.10'] },
          },
        ],
      ]) as never,
      snapshots([
        {
          id: 'container-1',
          name: 'api',
          ports: [{ privatePort: 80, publicPort: 18080, type: 'tcp', ip: '0.0.0.0' }],
        },
      ]) as never,
      connectedRegistry as never
    );

    await expect(
      service.resolve(
        {
          upstreamKind: 'docker_container',
          dockerNodeId: 'node-1',
          dockerContainerName: 'api',
          dockerContainerPort: 80,
          dockerHostPort: 18080,
          dockerProtocol: 'tcp',
        },
        { actorScopes: ['docker:containers:view:node-1'], requireAvailable: true }
      )
    ).resolves.toMatchObject({
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerHostPort: null,
      dockerContainerName: 'api',
    });
  });

  it('does not expose a published binding address as the Docker upstream', async () => {
    const service = new ProxyDockerUpstreamService(
      queuedDb([
        [
          {
            id: 'node-1',
            type: 'docker',
            status: 'online',
            serviceAddress: null,
            lastHealthReport: { localIpAddresses: ['10.0.0.10'] },
          },
        ],
      ]) as never,
      snapshots([
        {
          name: 'api',
          ports: [{ privatePort: 80, publicPort: 18080, type: 'tcp', ip: '10.0.0.20' }],
        },
      ]) as never,
      connectedRegistry as never
    );

    const resolved = await service.resolve({
      upstreamKind: 'docker_container',
      dockerNodeId: 'node-1',
      dockerContainerName: 'api',
      dockerContainerPort: 80,
      dockerHostPort: 18080,
      dockerProtocol: 'tcp',
    });

    expect(resolved).toMatchObject({ forwardHost: '127.0.0.1', forwardPort: 1, dockerHostPort: null });
  });

  it('accepts an application port even when an old published mapping is loopback-only', async () => {
    const service = new ProxyDockerUpstreamService(
      queuedDb([
        [
          {
            id: 'node-1',
            type: 'docker',
            status: 'online',
            serviceAddress: 'docker.internal',
            lastHealthReport: null,
          },
        ],
      ]) as never,
      snapshots([
        {
          name: 'api',
          ports: [{ privatePort: 80, publicPort: 18080, type: 'tcp', ip: '127.0.0.1' }],
        },
      ]) as never,
      connectedRegistry as never
    );

    await expect(
      service.resolve({
        upstreamKind: 'docker_container',
        dockerNodeId: 'node-1',
        dockerContainerName: 'api',
        dockerContainerPort: 80,
        dockerHostPort: 18080,
        dockerProtocol: 'tcp',
      })
    ).resolves.toMatchObject({ dockerContainerPort: 80, dockerHostPort: null });
  });

  it('ignores changes to legacy published host ports', async () => {
    const service = new ProxyDockerUpstreamService(
      queuedDb([
        [
          {
            id: 'node-1',
            type: 'docker',
            status: 'online',
            serviceAddress: 'docker.internal',
            lastHealthReport: null,
          },
        ],
      ]) as never,
      snapshots([
        {
          name: 'api',
          ports: [{ privatePort: 80, publicPort: 28080, type: 'tcp', ip: '::' }],
        },
      ]) as never,
      connectedRegistry as never
    );

    const resolved = await service.resolve(
      {
        upstreamKind: 'docker_container',
        dockerNodeId: 'node-1',
        dockerContainerName: 'api',
        dockerContainerPort: 80,
        dockerHostPort: 18080,
        dockerProtocol: 'tcp',
      },
      { allowPortRebind: true }
    );

    expect(resolved).toMatchObject({ forwardPort: 1, dockerHostPort: null, dockerContainerPort: 80 });
  });

  it('resolves a deployment through its durable route and derived Docker node', async () => {
    const service = new ProxyDockerUpstreamService(
      queuedDb([
        [{ id: 'deployment-1', nodeId: 'node-1' }],
        [
          {
            id: 'node-1',
            type: 'docker',
            status: 'online',
            serviceAddress: null,
            lastHealthReport: { localIpAddresses: ['10.0.0.10'] },
          },
        ],
        { where: [{ id: 'route-1', deploymentId: 'deployment-1', hostPort: 19090, containerPort: 8080 }] },
      ]) as never,
      snapshots([]) as never,
      connectedRegistry as never
    );

    await expect(
      service.resolve({
        upstreamKind: 'docker_deployment',
        dockerDeploymentId: 'deployment-1',
        dockerContainerPort: 8080,
        dockerHostPort: 19090,
        dockerProtocol: 'tcp',
      })
    ).resolves.toMatchObject({
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerDeploymentId: 'deployment-1',
      dockerNodeId: 'node-1',
    });
  });

  it('rejects selecting a Docker target without view permission', async () => {
    const service = new ProxyDockerUpstreamService(
      queuedDb([]) as never,
      snapshots([]) as never,
      connectedRegistry as never
    );

    await expect(
      service.resolve(
        {
          upstreamKind: 'docker_container',
          dockerNodeId: 'node-1',
          dockerContainerName: 'api',
          dockerContainerPort: 80,
          dockerHostPort: 18080,
          dockerProtocol: 'tcp',
        },
        { actorScopes: ['proxy:create'], requireAvailable: true }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });
});
