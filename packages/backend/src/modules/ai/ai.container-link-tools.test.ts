import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { ContainerLinksService } from '@/modules/docker/container-links/container-links.service.js';
import { manageContainerLinkForAgent } from './ai.container-link-tools.js';

vi.mock('@/modules/docker/docker-binding-target-identity.js', () => ({
  resolveBindingTargetContainerIdentity: async (_nodeId: string, name: string) => `container-${name}`,
}));

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const link = {
  id: '33333333-3333-4333-8333-333333333333',
  source: { nodeId: NODE_A, type: 'container', resourceId: 'api' },
  target: { nodeId: NODE_B, type: 'container', resourceId: 'db' },
  environment: {},
};

function service() {
  const fake = {
    listBySource: vi.fn(async () => []),
    listIncoming: vi.fn(async () => []),
    get: vi.fn(async () => link),
    create: vi.fn(async () => link),
    delete: vi.fn(async () => ({ success: true })),
    getRuntime: vi.fn(async () => ({ link, runtime: null })),
  };
  container.registerInstance(ContainerLinksService, fake as never);
  return fake;
}

const user = (scopes: string[]) => ({ id: 'user', scopes }) as never;

afterEach(() => container.reset());

describe('manage_container_link', () => {
  it('creates with the same consumer and target checks as the API', async () => {
    const links = service();

    await expect(
      manageContainerLinkForAgent(user([`docker:containers:edit:${NODE_A}`]), {
        operation: 'create',
        sourceNodeId: NODE_A,
        sourceType: 'container',
        sourceResourceId: 'api',
        targetNodeId: NODE_B,
        targetType: 'container',
        targetResourceId: 'db',
        targetPort: 5432,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(links.create).not.toHaveBeenCalled();

    await manageContainerLinkForAgent(user([`docker:containers:edit:${NODE_A}`, `docker:containers:link:${NODE_B}`]), {
      operation: 'create',
      sourceNodeId: NODE_A,
      sourceType: 'container',
      sourceResourceId: 'api',
      targetNodeId: NODE_B,
      targetType: 'container',
      targetResourceId: 'db',
      targetPort: 5432,
    });
    expect(links.create).toHaveBeenCalledWith(expect.objectContaining({ targetPort: 5432 }), 'user');
  });

  it('lists incoming links with view access to the target and deletes with the consumer rights', async () => {
    const links = service();

    await manageContainerLinkForAgent(user([`docker:containers:view:${NODE_B}`]), {
      operation: 'list',
      nodeId: NODE_B,
      type: 'container',
      resourceId: 'db',
      direction: 'incoming',
    });
    expect(links.listIncoming).toHaveBeenCalledWith(NODE_B, 'container', 'db');

    await expect(
      manageContainerLinkForAgent(user([`docker:containers:link:${NODE_B}`]), { operation: 'delete', linkId: link.id })
    ).rejects.toMatchObject({ statusCode: 403 });
    await manageContainerLinkForAgent(user([`docker:containers:edit:${NODE_A}`]), {
      operation: 'delete',
      linkId: link.id,
    });
    expect(links.delete).toHaveBeenCalledWith(link.id, 'user');
  });
});
