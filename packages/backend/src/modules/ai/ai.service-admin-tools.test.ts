import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['admin:users', 'proxy:view'] as string[],
  isBlocked: false,
};

function createService({
  authService,
  groupService = {},
}: {
  authService: Record<string, unknown>;
  groupService?: Record<string, unknown>;
}) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    authService as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    groupService as never,
    {} as never,
    {} as never
  );
}

describe('AIService admin user lifecycle tools', () => {
  it('revalidates the actor scopes immediately before an assistant tool execution', async () => {
    const authService = {
      getUserById: vi.fn().mockResolvedValue({ ...BASE_USER, scopes: [] }),
      blockUser: vi.fn(),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool(BASE_USER, 'set_user_blocked', { userId: 'user-2', blocked: true })
    ).resolves.toMatchObject({ error: expect.stringContaining('PERMISSION_DENIED') });
    expect(authService.blockUser).not.toHaveBeenCalled();
  });

  it('creates users only when the target group is inside the actor scope set', async () => {
    const authService = {
      createUser: vi.fn().mockResolvedValue({ id: 'user-2', email: 'ops@example.com' }),
    };
    const groupService = {
      getGroup: vi.fn().mockResolvedValue({ id: 'group-2', scopes: ['proxy:view'], inheritedScopes: [] }),
    };
    const service = createService({ authService, groupService });

    await expect(
      service.executeTool(BASE_USER, 'create_user', {
        email: 'ops@example.com',
        name: 'Ops',
        groupId: 'group-2',
      })
    ).resolves.toEqual({
      result: { id: 'user-2', email: 'ops@example.com' },
      invalidateStores: ['users'],
    });

    expect(groupService.getGroup).toHaveBeenCalledWith('group-2');
    expect(authService.createUser).toHaveBeenCalledWith({
      email: 'ops@example.com',
      name: 'Ops',
      groupId: 'group-2',
    });
  });

  it('blocks, unblocks, and deletes users through route-equivalent privilege checks', async () => {
    const targetUser = {
      id: 'user-2',
      oidcSubject: 'oidc-user-2',
      scopes: ['proxy:view'],
    };
    const authService = {
      getUserById: vi.fn(async (userId: string) => (userId === BASE_USER.id ? BASE_USER : targetUser)),
      blockUser: vi.fn().mockResolvedValue({ id: 'user-2', isBlocked: true }),
      unblockUser: vi.fn().mockResolvedValue({ id: 'user-2', isBlocked: false }),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool(BASE_USER, 'set_user_blocked', { userId: 'user-2', blocked: true })
    ).resolves.toEqual({
      result: { id: 'user-2', isBlocked: true },
      invalidateStores: ['users'],
    });
    expect(authService.blockUser).toHaveBeenCalledWith('user-2');

    await expect(
      service.executeTool(BASE_USER, 'set_user_blocked', { userId: 'user-2', blocked: false })
    ).resolves.toEqual({
      result: { id: 'user-2', isBlocked: false },
      invalidateStores: ['users'],
    });
    expect(authService.unblockUser).toHaveBeenCalledWith('user-2');

    await expect(service.executeTool(BASE_USER, 'delete_user', { userId: 'user-2' })).resolves.toEqual({
      result: { success: true },
      invalidateStores: ['users'],
    });
    expect(authService.deleteUser).toHaveBeenCalledWith('user-2', 'user-1');
  });

  it('uses AuthService MFA grace handling when changing a user group', async () => {
    const targetUser = {
      id: 'user-2',
      oidcSubject: 'oidc-user-2',
      scopes: ['proxy:view'],
    };
    const updatedUser = { ...targetUser, groupId: 'group-2' };
    const authService = {
      getUserById: vi.fn(async (userId: string) => (userId === BASE_USER.id ? BASE_USER : targetUser)),
      assertCanUpdateUserGroup: vi.fn().mockResolvedValue(targetUser),
      updateUserGroup: vi.fn().mockResolvedValue(updatedUser),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool(BASE_USER, 'update_user_role', { userId: 'user-2', groupId: 'group-2' })
    ).resolves.toEqual({
      result: updatedUser,
      invalidateStores: ['users'],
    });

    expect(authService.updateUserGroup).toHaveBeenCalledWith('user-2', 'group-2');
  });

  it('replaces and resets a user additional permissions through AuthService privilege checks', async () => {
    const targetUser = {
      id: 'user-2',
      oidcSubject: 'oidc-user-2',
      scopes: ['proxy:view'],
      additionalScopes: [],
    };
    const authService = {
      getUserById: vi.fn(async (userId: string) => (userId === BASE_USER.id ? BASE_USER : targetUser)),
      assertCanUpdateUserAdditionalScopes: vi.fn(async (_actorId, _actorScopes, _userId, requestedScopes) => ({
        targetUser,
        additionalScopes: requestedScopes,
      })),
      updateUserAdditionalScopes: vi.fn(async (userId: string, additionalScopes: string[]) => ({
        ...targetUser,
        id: userId,
        additionalScopes,
      })),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool(BASE_USER, 'set_user_additional_permissions', {
        userId: 'user-2',
        additionalScopes: ['proxy:view'],
      })
    ).resolves.toEqual({
      result: { ...targetUser, additionalScopes: ['proxy:view'] },
      invalidateStores: ['users'],
    });
    expect(authService.assertCanUpdateUserAdditionalScopes).toHaveBeenLastCalledWith(
      'user-1',
      BASE_USER.scopes,
      'user-2',
      ['proxy:view']
    );

    await expect(
      service.executeTool(BASE_USER, 'set_user_additional_permissions', {
        userId: 'user-2',
        additionalScopes: [],
      })
    ).resolves.toEqual({
      result: { ...targetUser, additionalScopes: [] },
      invalidateStores: ['users'],
    });
    expect(authService.updateUserAdditionalScopes).toHaveBeenLastCalledWith('user-2', []);

    await expect(
      service.executeTool(BASE_USER, 'set_user_additional_permissions', { userId: 'user-2' })
    ).resolves.toMatchObject({ error: 'additionalScopes must be an array of permission scope strings' });
    expect(authService.updateUserAdditionalScopes).toHaveBeenCalledTimes(2);
  });

  it('rejects self and system user lifecycle mutations', async () => {
    const authService = {
      getUserById: vi.fn(async (userId: string) =>
        userId === BASE_USER.id
          ? BASE_USER
          : {
              id: 'system-user',
              oidcSubject: 'system:gateway-setup',
              scopes: [],
            }
      ),
      blockUser: vi.fn(),
      deleteUser: vi.fn(),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool(BASE_USER, 'set_user_blocked', { userId: BASE_USER.id, blocked: true })
    ).resolves.toMatchObject({ error: 'Cannot block yourself' });

    await expect(service.executeTool(BASE_USER, 'delete_user', { userId: BASE_USER.id })).resolves.toMatchObject({
      error: 'Cannot delete your own account',
    });

    await expect(
      service.executeTool(BASE_USER, 'set_user_blocked', { userId: 'system-user', blocked: true })
    ).resolves.toMatchObject({ error: 'Cannot modify the system user' });

    await expect(service.executeTool(BASE_USER, 'delete_user', { userId: 'system-user' })).resolves.toMatchObject({
      error: 'Cannot delete the system user',
    });
  });
});
