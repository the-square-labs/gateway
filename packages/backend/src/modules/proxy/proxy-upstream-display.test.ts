import { describe, expect, it, vi } from 'vitest';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

describe('attachDockerUpstreamDisplay', () => {
  it('exposes only the public active flag for an active Secure Link', async () => {
    const where = vi.fn().mockResolvedValueOnce([{ id: 'node-1', slug: 'docker-one', appearanceColor: 'pink' }]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    } as any;
    const host = {
      id: 'host-1',
      upstreamKind: 'docker_container',
      dockerNodeId: 'node-1',
      dockerDeploymentId: null,
      forwardHost: '127.0.0.1',
      forwardPort: 41001,
      dockerHostPort: 8080,
      secureLinkStatus: 'active',
      secureLinkGeneration: 2,
      secureLinkListenerPort: 41001,
      secureLinkConnectorPort: 42001,
      secureLinkLastError: null,
      secureLinkTargetNetwork: 'app-net',
      secureLinkTargetContainer: 'app',
      secureLinkTargetHost: null,
      secureLinkMigratedAt: new Date(),
    };

    const [result] = await attachDockerUpstreamDisplay(db, [host]);

    expect(result).toMatchObject({
      secureLinkActive: true,
      dockerNodeSlug: 'docker-one',
      dockerNodeAppearanceColor: 'pink',
      forwardHost: null,
      forwardPort: null,
      dockerHostPort: null,
    });
    expect(result).not.toHaveProperty('secureLinkStatus');
    expect(result).not.toHaveProperty('secureLinkGeneration');
    expect(result).not.toHaveProperty('secureLinkListenerPort');
    expect(result).not.toHaveProperty('secureLinkConnectorPort');
  });

  it('reports legacy Docker routes as not active', async () => {
    const where = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    } as any;

    const [result] = await attachDockerUpstreamDisplay(db, [
      {
        upstreamKind: 'docker_container',
        dockerNodeId: 'node-1',
        dockerDeploymentId: null,
        forwardHost: '172.20.0.136',
        forwardPort: 18082,
        dockerHostPort: 18082,
        secureLinkStatus: 'legacy',
      },
    ]);

    expect(result?.secureLinkActive).toBe(false);
  });

  it('attaches the Page Project, Tag, and appearance color to a Pages Route', async () => {
    const pageTarget = {
      proxyHostId: 'host-1',
      projectId: 'project-1',
      projectName: 'Docs',
      projectSlug: 'docs',
      projectAppearanceColor: 'purple',
      tagId: 'tag-1',
      tagName: 'production',
      deploymentId: 'deployment-1',
      status: 'ready',
      generation: 2,
      lastErrorCode: null,
    };
    const where = vi.fn().mockResolvedValue([pageTarget]);
    const secondJoin = vi.fn(() => ({ where }));
    const firstJoin = vi.fn(() => ({ innerJoin: secondJoin }));
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: firstJoin })) })),
    } as any;

    const [result] = await attachDockerUpstreamDisplay(db, [
      {
        id: 'host-1',
        upstreamKind: 'pages',
        dockerNodeId: null,
        dockerDeploymentId: null,
        forwardHost: null,
        forwardPort: null,
      },
    ]);

    expect(result?.pageTarget).toEqual({
      projectId: 'project-1',
      projectName: 'Docs',
      projectSlug: 'docs',
      projectAppearanceColor: 'purple',
      tagId: 'tag-1',
      tagName: 'production',
      deploymentId: 'deployment-1',
      status: 'ready',
      generation: 2,
      lastErrorCode: null,
    });
  });
});
