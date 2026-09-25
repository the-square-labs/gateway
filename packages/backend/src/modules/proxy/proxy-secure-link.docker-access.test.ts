import { describe, expect, it, vi } from 'vitest';
import { ProxyDockerUpstreamService } from './proxy-docker-upstream.service.js';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const HOST = { id: '11111111-1111-4111-8111-111111111111', type: 'proxy', nodeId: 'nginx-node' } as any;
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';
// A token that may edit the Routes of folder F and nothing on Docker.
const FOLDER_EDITOR = ['proxy:view:folder/F', 'proxy:edit:folder/F'];

/** The real upstream resolver, as Route upstreams use it, over fakes for its reads. */
function upstreams() {
  const db = {
    select: vi.fn(() => {
      const query: any = {
        from: () => query,
        where: () => query,
        limit: async () => [{ id: DEPLOYMENT_ID, nodeId: NODE_ID, type: 'docker', status: 'online' }],
      };
      return query;
    }),
  };
  const snapshots = {
    getList: vi.fn(async () => ({
      data: [{ id: 'runtime-other', name: 'other-team-api', ports: [] }],
      revision: 1,
      refreshStatus: 'success',
    })),
  };
  const accessResources = { ensureContainer: vi.fn(async () => 'other-team-api') };
  return new ProxyDockerUpstreamService(
    db as never,
    snapshots as never,
    { getNode: vi.fn(() => ({ id: NODE_ID })) } as never,
    accessResources as never
  );
}

function service(link?: Record<string, unknown>) {
  const update = vi.fn();
  const db = {
    query: { proxyAdditionalSecureLinks: { findFirst: vi.fn(async () => link ?? null) } },
    insert: vi.fn(),
    update,
    transaction: vi.fn(),
  };
  const secureLinks = new ProxySecureLinkService(
    db as never,
    {} as never,
    { revokeOwner: vi.fn() } as never,
    'connector@sha256:test',
    upstreams()
  );
  vi.spyOn(secureLinks as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
  return { secureLinks, db };
}

const otherTeamContainer = {
  upstreamKind: 'docker_container' as const,
  dockerNodeId: NODE_ID,
  dockerContainerName: 'other-team-api',
  dockerContainerPort: 8080,
};

describe('Additional Secure Link Docker targets', () => {
  it('refuses to point a link at a container the caller cannot view (create and retarget)', async () => {
    const { secureLinks, db } = service({
      id: LINK_ID,
      proxyHostId: HOST.id,
      name: 'api',
      purpose: 'user_managed',
      upstreamKind: 'docker_container',
      status: 'active',
      generation: 1,
    });

    await expect(
      secureLinks.retargetAdditional(HOST, LINK_ID, otherTeamContainer, FOLDER_EDITOR)
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(
      secureLinks.createAdditional(HOST, { name: 'stolen', ...otherTeamContainer }, FOLDER_EDITOR)
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses a deployment the caller cannot view', async () => {
    const { secureLinks } = service();

    await expect(
      (secureLinks as any).resolveAdditionalTarget(
        {
          name: 'api',
          upstreamKind: 'docker_deployment',
          dockerDeploymentId: DEPLOYMENT_ID,
          dockerContainerPort: 8080,
        },
        FOLDER_EDITOR
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('accepts a container the caller can view, like a Route upstream', async () => {
    const { secureLinks } = service();

    await expect(
      (secureLinks as any).resolveAdditionalTarget({ name: 'api', ...otherTeamContainer }, [
        ...FOLDER_EDITOR,
        `docker:containers:view:${NODE_ID}`,
      ])
    ).resolves.toMatchObject({ nodeId: NODE_ID, container: 'other-team-api', applicationPort: 8080 });
  });

  it('does not need the snapshot cache for broad or node-wide Docker view', async () => {
    const { secureLinks } = service();
    // The cache has not seen this container yet.
    const target = { name: 'api', ...otherTeamContainer, dockerContainerName: 'just-created' };

    await expect(
      (secureLinks as any).resolveAdditionalTarget(target, [...FOLDER_EDITOR, `docker:containers:view:${NODE_ID}`])
    ).resolves.toMatchObject({ container: 'just-created' });
    await expect(
      (secureLinks as any).resolveAdditionalTarget(target, ['proxy:edit', 'docker:containers:view'])
    ).resolves.toMatchObject({ container: 'just-created' });
    // A scoped caller still needs the container identity, so a cache miss is refused.
    await expect(
      (secureLinks as any).resolveAdditionalTarget(target, [
        ...FOLDER_EDITOR,
        `docker:containers:view:${NODE_ID}:some-other`,
      ])
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });
  });
});
