import { describe, expect, it, vi } from 'vitest';
import { dockerChildScopeResourceId } from '@/modules/docker/docker-access-resource.service.js';
import {
  assertContainerLinkSourceAccess,
  assertContainerLinkTargetAccess,
  assertContainerLinkViewAccess,
} from './container-link-access.js';

// A resource-scoped caller is judged by the container's access identity; the test names it after the container.
vi.mock('@/modules/docker/docker-binding-target-identity.js', () => ({
  resolveBindingTargetContainerIdentity: async (_nodeId: string, name: string) => `container-${name}`,
}));

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';

const container = (nodeId: string, name: string) => ({ nodeId, type: 'container' as const, resourceId: name });

describe('container link permissions (D11)', () => {
  it('needs edit on the consumer and link on the target', async () => {
    const scopes = [`docker:containers:edit:${NODE_A}`, `docker:containers:link:${NODE_B}`];

    await expect(
      assertContainerLinkSourceAccess(scopes, container(NODE_A, 'api'), { environment: false })
    ).resolves.toBeUndefined();
    await expect(assertContainerLinkTargetAccess(scopes, container(NODE_B, 'db'))).resolves.toBeUndefined();
  });

  it('refuses a target without docker:containers:link', async () => {
    const scopes = [`docker:containers:edit:${NODE_A}`, `docker:containers:edit:${NODE_B}`];

    await expect(assertContainerLinkTargetAccess(scopes, container(NODE_B, 'db'))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('needs docker:containers:environment when the link sets variables', async () => {
    const scopes = [`docker:containers:edit:${NODE_A}`];

    await expect(
      assertContainerLinkSourceAccess(scopes, container(NODE_A, 'api'), { environment: true })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      assertContainerLinkSourceAccess(
        [...scopes, `docker:containers:environment:${NODE_A}`],
        container(NODE_A, 'api'),
        {
          environment: true,
        }
      )
    ).resolves.toBeUndefined();
  });

  it('checks a deployment by its own resource grant', async () => {
    const target = { nodeId: NODE_B, type: 'deployment' as const, resourceId: DEPLOYMENT };
    const granted = [`docker:containers:link:${dockerChildScopeResourceId(NODE_B, DEPLOYMENT)}`];

    await expect(assertContainerLinkTargetAccess(granted, target)).resolves.toBeUndefined();
    await expect(
      assertContainerLinkTargetAccess([`docker:containers:link:${dockerChildScopeResourceId(NODE_B, PROJECT)}`], target)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('uses docker:compose:manage on both ends of a Compose service', async () => {
    const service = { nodeId: NODE_A, type: 'compose_service' as const, resourceId: `${PROJECT}:web` };

    await expect(
      assertContainerLinkSourceAccess([`docker:compose:manage:${NODE_A}`], service, { environment: true })
    ).resolves.toBeUndefined();
    await expect(assertContainerLinkTargetAccess([`docker:containers:link:${NODE_A}`], service)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(assertContainerLinkViewAccess([`docker:compose:view:${NODE_A}`], service)).resolves.toBeUndefined();
  });
});
