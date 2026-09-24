import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { SessionService } from '@/services/session.service.js';
import { AIService } from './ai.service.js';

const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const FOLDER_ID = '33333333-3333-4333-8333-333333333333';

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
  auditService = { log: vi.fn() },
}: {
  authService: Record<string, unknown>;
  groupService?: Record<string, unknown>;
  auditService?: Record<string, unknown>;
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
    auditService as never,
    {} as never,
    {} as never,
    groupService as never,
    {} as never,
    {} as never
  );
}

afterEach(() => {
  container.reset();
  vi.restoreAllMocks();
});

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

  it('creates users like POST /admin/users: schema, group boundary, creator grant, and audit', async () => {
    const authService = {
      createUser: vi.fn().mockResolvedValue({ id: 'user-2', email: 'ops@example.com', groupId: GROUP_ID }),
      grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
    };
    const groupService = {
      getGroup: vi.fn().mockResolvedValue({ id: GROUP_ID, scopes: ['proxy:view'], inheritedScopes: [] }),
    };
    const auditService = { log: vi.fn() };
    const service = createService({ authService, groupService, auditService });

    await expect(
      service.executeTool(BASE_USER, 'create_user', {
        email: 'ops@example.com',
        name: 'Ops',
        groupId: GROUP_ID,
      })
    ).resolves.toEqual({
      result: { id: 'user-2', email: 'ops@example.com', groupId: GROUP_ID },
      invalidateStores: ['users'],
    });

    expect(groupService.getGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(authService.createUser).toHaveBeenCalledWith({
      email: 'ops@example.com',
      name: 'Ops',
      groupId: GROUP_ID,
      groupIds: [GROUP_ID],
      authMethod: 'oidc',
    });
    expect(authService.grantCreatedResourcePermissions).toHaveBeenCalledWith('user-1', 'admin:users', 'user-2');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.create', resourceId: 'user-2', userId: 'user-1' })
    );
  });

  it('rejects user creation that the route would reject', async () => {
    const authService = { createUser: vi.fn() };
    const groupService = {
      getGroup: vi.fn().mockResolvedValue({ id: GROUP_ID, scopes: ['admin:system'], inheritedScopes: [] }),
    };
    const service = createService({ authService, groupService });

    await expect(
      service.executeTool(BASE_USER, 'create_user', { email: 'ops@example.com', name: ' ', groupId: GROUP_ID })
    ).resolves.toMatchObject({ error: expect.stringContaining('Name is required') });
    await expect(
      service.executeTool(BASE_USER, 'create_user', { email: 'ops@example.com', name: 'Ops', groupId: GROUP_ID })
    ).resolves.toMatchObject({ error: 'Cannot assign a group with permissions you do not possess' });

    const folderService = { assertFolderExists: vi.fn() };
    container.registerInstance(AdminUserFolderService, folderService as unknown as AdminUserFolderService);
    const folderScopedActor = { ...BASE_USER, scopes: [`admin:users:folder/${FOLDER_ID}`] };
    await expect(
      service.executeTool(folderScopedActor, 'create_user', {
        email: 'ops@example.com',
        name: 'Ops',
        groupId: GROUP_ID,
        folderId: '44444444-4444-4444-8444-444444444444',
      })
    ).resolves.toMatchObject({ error: 'Select an authorized destination user folder' });
    expect(folderService.assertFolderExists).not.toHaveBeenCalled();
    expect(authService.createUser).not.toHaveBeenCalled();
  });

  it('lists only the users inside the actor admin:users grants', async () => {
    const authService = {
      listUsers: vi.fn().mockResolvedValue([{ id: 'user-2' }, { id: 'user-3' }]),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['admin:users:user-3'] }, 'list_users', {})
    ).resolves.toEqual({ result: [{ id: 'user-3' }], invalidateStores: [] });
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
    const updatedUser = { ...targetUser, groupId: GROUP_ID };
    const authService = {
      getUserById: vi.fn(async (userId: string) => (userId === BASE_USER.id ? BASE_USER : targetUser)),
      assertCanUpdateUserGroup: vi.fn().mockResolvedValue(targetUser),
      updateUserGroup: vi.fn().mockResolvedValue(updatedUser),
    };
    const service = createService({ authService });

    await expect(
      service.executeTool(BASE_USER, 'update_user_role', { userId: 'user-2', groupId: GROUP_ID })
    ).resolves.toEqual({
      result: updatedUser,
      invalidateStores: ['users'],
    });

    expect(authService.assertCanUpdateUserGroup).toHaveBeenCalledWith('user-1', BASE_USER.scopes, 'user-2', [GROUP_ID]);
    expect(authService.updateUserGroup).toHaveBeenCalledWith('user-2', [GROUP_ID]);
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

describe('AIService manage_user tool', () => {
  const targetUser = {
    id: 'user-2',
    oidcSubject: null,
    email: 'ops@example.com',
    name: 'Ops',
    authMethod: 'password',
    scopes: ['proxy:view'],
  };
  const systemAdmin = { ...BASE_USER, scopes: ['admin:system', 'admin:users', 'proxy:view'] };

  /** getUserById serves both the pre-execution actor refresh and the target lookup. */
  function authService<Extra extends Record<string, unknown>>(
    actor: typeof BASE_USER,
    extra: Extra = {} as Extra,
    target: Record<string, unknown> = targetUser
  ) {
    return {
      getUserById: vi.fn(async (id: string) => (id === actor.id ? actor : id === target.id ? target : null)),
      ...extra,
    };
  }

  it('renames a local account and records the same audit event as the route', async () => {
    const auth = authService(BASE_USER, {
      updateLocalUserName: vi.fn().mockResolvedValue({ ...targetUser, name: 'Operations' }),
    });
    const auditService = { log: vi.fn() };
    const service = createService({ authService: auth, auditService });

    await expect(
      service.executeTool(BASE_USER, 'manage_user', { operation: 'rename', userId: 'user-2', name: ' Operations ' })
    ).resolves.toEqual({ result: { ...targetUser, name: 'Operations' }, invalidateStores: ['users'] });
    expect(auth.updateLocalUserName).toHaveBeenCalledWith('user-2', 'Operations');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.rename',
        resourceId: 'user-2',
        details: { targetUserId: 'user-2', previousName: 'Ops', name: 'Operations' },
      })
    );
  });

  it('enforces the per-user admin:users grant and the privilege boundary', async () => {
    const scopedActor = { ...BASE_USER, scopes: ['admin:users:user-3'] };
    const scopedAuth = authService(scopedActor, { updateUserAvatar: vi.fn() });
    await expect(
      createService({ authService: scopedAuth }).executeTool(scopedActor, 'manage_user', {
        operation: 'reset_avatar',
        userId: 'user-2',
      })
    ).resolves.toMatchObject({ error: 'Missing required scope: admin:users:user-2' });

    const auth = authService(BASE_USER, { updateUserAvatar: vi.fn() }, { ...targetUser, scopes: ['admin:system'] });
    await expect(
      createService({ authService: auth }).executeTool(BASE_USER, 'manage_user', {
        operation: 'reset_avatar',
        userId: 'user-2',
      })
    ).resolves.toMatchObject({ error: 'Cannot manage a system administrator' });
    expect(scopedAuth.updateUserAvatar).not.toHaveBeenCalled();
    expect(auth.updateUserAvatar).not.toHaveBeenCalled();
  });

  it('resets MFA only for admin:system and ends the target browser sessions', async () => {
    const mfaService = { resetMfa: vi.fn().mockResolvedValue(undefined) };
    const sessionService = { destroyAllUserSessions: vi.fn().mockResolvedValue(undefined) };
    container.registerInstance(MfaService, mfaService as unknown as MfaService);
    container.registerInstance(SessionService, sessionService as unknown as SessionService);
    const auditService = { log: vi.fn() };

    await expect(
      createService({ authService: authService(BASE_USER), auditService }).executeTool(BASE_USER, 'manage_user', {
        operation: 'reset_mfa',
        userId: 'user-2',
      })
    ).resolves.toMatchObject({ error: 'Missing required scope: admin:system' });
    expect(mfaService.resetMfa).not.toHaveBeenCalled();

    await expect(
      createService({ authService: authService(systemAdmin), auditService }).executeTool(systemAdmin, 'manage_user', {
        operation: 'reset_mfa',
        userId: 'user-2',
      })
    ).resolves.toEqual({ result: { message: 'MFA reset and browser sessions revoked' }, invalidateStores: ['users'] });
    expect(mfaService.resetMfa).toHaveBeenCalledWith('user-2');
    expect(sessionService.destroyAllUserSessions).toHaveBeenCalledWith('user-2');
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.mfa_reset' }));
  });

  it('lists and revokes another user browser sessions', async () => {
    const sessionService = {
      listPublicUserSessions: vi.fn().mockResolvedValue([{ id: 'public-1', current: false }]),
      revokeUserSessionByPublicId: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      destroyAllUserSessions: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(SessionService, sessionService as unknown as SessionService);
    const auditService = { log: vi.fn() };
    const service = createService({ authService: authService(BASE_USER), auditService });

    await expect(
      service.executeTool(BASE_USER, 'manage_user', { operation: 'list_sessions', userId: 'user-2' })
    ).resolves.toEqual({ result: [{ id: 'public-1', current: false }], invalidateStores: ['users'] });
    expect(sessionService.listPublicUserSessions).toHaveBeenCalledWith('user-2', '');

    await expect(
      service.executeTool(BASE_USER, 'manage_user', {
        operation: 'revoke_session',
        userId: 'user-2',
        sessionId: 'public-1',
      })
    ).resolves.toEqual({ result: { message: 'Session revoked' }, invalidateStores: ['users'] });
    await expect(
      service.executeTool(BASE_USER, 'manage_user', {
        operation: 'revoke_session',
        userId: 'user-2',
        sessionId: 'public-2',
      })
    ).resolves.toMatchObject({ error: 'Session not found' });
    await expect(
      service.executeTool(BASE_USER, 'manage_user', { operation: 'revoke_all_sessions', userId: 'user-2' })
    ).resolves.toEqual({ result: { message: 'All sessions revoked' }, invalidateStores: ['users'] });
    expect(sessionService.revokeUserSessionByPublicId).toHaveBeenCalledWith('user-2', 'public-1');
    expect(sessionService.destroyAllUserSessions).toHaveBeenCalledWith('user-2');
    expect(auditService.log.mock.calls.map(([entry]) => entry.action)).toEqual(
      expect.arrayContaining(['user.session_revoke', 'user.sessions_revoke_all'])
    );
  });

  it('keeps deleted-account inspection and restore behind admin:system', async () => {
    const extra = {
      listDeletedUsers: vi.fn().mockResolvedValue([{ id: 'user-9' }]),
      restoreUser: vi.fn().mockResolvedValue({ id: 'user-9', groupId: GROUP_ID }),
    };
    await expect(
      createService({ authService: authService(BASE_USER, extra) }).executeTool(BASE_USER, 'manage_user', {
        operation: 'list_deleted',
      })
    ).resolves.toMatchObject({ error: 'Missing required scope: admin:system' });

    const service = createService({ authService: authService(systemAdmin, extra) });
    await expect(service.executeTool(systemAdmin, 'manage_user', { operation: 'list_deleted' })).resolves.toEqual({
      result: [{ id: 'user-9' }],
      invalidateStores: ['users'],
    });
    await expect(
      service.executeTool(systemAdmin, 'manage_user', { operation: 'restore', userId: 'user-9', groupIds: [GROUP_ID] })
    ).resolves.toEqual({ result: { id: 'user-9', groupId: GROUP_ID }, invalidateStores: ['users'] });
    expect(extra.restoreUser).toHaveBeenCalledWith('user-9', [GROUP_ID]);
  });

  it('rejects unknown operations and missing user ids before any target lookup', async () => {
    const auth = authService(BASE_USER);
    const service = createService({ authService: auth });

    await expect(
      service.executeTool(BASE_USER, 'manage_user', { operation: 'impersonate', userId: 'user-2' })
    ).resolves.toMatchObject({ error: 'Unsupported user operation: impersonate' });
    await expect(
      service.executeTool(BASE_USER, 'manage_user', { operation: 'rename', name: 'X' })
    ).resolves.toMatchObject({ error: 'userId is required' });
    expect(auth.getUserById).not.toHaveBeenCalledWith('user-2');
  });
});
