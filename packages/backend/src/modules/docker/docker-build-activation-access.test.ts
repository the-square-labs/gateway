import { describe, expect, it, vi } from 'vitest';
import { assertBuildActivationAccess } from './docker-build-activation-access.js';

function dbForFolder(folderId: string | undefined) {
  return {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ folderId, id: folderId, isSystem: false }] }) }),
    })),
  };
}

describe('pending Deployment and Compose activation access', () => {
  it.each([
    'container',
    'compose',
  ] as const)('uses the current %s folder assignment and effective actor grants', async (kind) => {
    const scope = kind === 'compose' ? 'docker:compose:create' : 'docker:containers:create';
    const db = dbForFolder('folder-1');
    const actor = { id: 'user', scopes: [`${scope}:folder/folder-1`] };
    const auth = { getUserById: vi.fn().mockResolvedValue(actor) };
    await expect(assertBuildActivationAccess(db as never, auth, 'user', 'node', 'resource', kind)).resolves.toBe(actor);
    expect(db.select).toHaveBeenCalledTimes(2);
    actor.scopes = [`${scope}:folder/other`];
    await expect(
      assertBuildActivationAccess(db as never, auth, 'user', 'node', 'resource', kind)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it.each([
    null,
    { isBlocked: true, scopes: ['*'] },
    { isDeleted: true, scopes: ['*'] },
    { scopes: [] },
  ])('rejects invalid actor %j', async (actor) => {
    const auth = { getUserById: vi.fn().mockResolvedValue(actor) };
    await expect(
      assertBuildActivationAccess(dbForFolder(undefined) as never, auth, 'user', 'node', 'project', 'compose')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects ownerless activation rather than using the automation identity', async () => {
    const auth = { getUserById: vi.fn() };
    await expect(
      assertBuildActivationAccess(dbForFolder(undefined) as never, auth, null, 'node', 'project', 'compose')
    ).rejects.toMatchObject({ code: 'BUILD_ACTOR_FORBIDDEN' });
    expect(auth.getUserById).not.toHaveBeenCalled();
  });
});
