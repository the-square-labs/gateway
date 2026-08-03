import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { inferenceProviderConnections, users } from '@/db/schema/index.js';
import { AuthService, type NormalizedOidcClaims, normalizeOidcClaims } from './auth.service.js';
import { computeEffectiveUserAccess, fetchGroupScopeMap } from './live-session-user.js';

const authorizationCodeGrantMock = vi.hoisted(() => vi.fn());

vi.mock('openid-client', () => ({
  authorizationCodeGrant: authorizationCodeGrantMock,
}));

vi.mock('./live-session-user.js', () => ({
  resolveEffectiveGroupAccess: vi.fn().mockResolvedValue({
    groupName: 'admin',
    scopes: ['nodes:details'],
  }),
  resolveEffectiveUserAccess: vi.fn().mockImplementation((_db, _groupId, additionalScopes = []) =>
    Promise.resolve({
      groupName: 'admin',
      groupScopes: ['nodes:details'],
      additionalScopes,
      scopes: ['nodes:details', ...additionalScopes],
    })
  ),
  computeEffectiveGroupAccess: vi.fn(),
  computeEffectiveUserAccess: vi.fn(),
  fetchGroupScopeMap: vi.fn(),
}));

describe('AuthService.blockUser', () => {
  it('keeps sessions available so blocked users can reach status and logout endpoints', async () => {
    const dbUser = {
      id: '11111111-1111-4111-8111-111111111111',
      oidcSubject: 'oidc-user',
      email: 'user@example.com',
      name: 'User',
      avatarUrl: null,
      groupId: 'group-1',
      isBlocked: true,
    };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([dbUser]),
          })),
        })),
      })),
    };
    const sessionService = {
      destroyAllUserSessions: vi.fn(),
    };
    const eventBus = {
      publish: vi.fn(),
    };
    const service = new AuthService(db as any, sessionService as any, {} as any, {} as any, {} as any);
    service.setEventBus(eventBus as any);

    const user = await service.blockUser(dbUser.id);

    expect(user.isBlocked).toBe(true);
    expect(sessionService.destroyAllUserSessions).not.toHaveBeenCalled();
    expect(eventBus.publish).toHaveBeenCalledWith('user.changed', { id: dbUser.id, action: 'updated' });
    expect(eventBus.publish).toHaveBeenCalledWith(`permissions.changed.${dbUser.id}`, {
      scopes: [],
      groupId: null,
      reason: 'user_blocked',
    });
  });
});

describe('AuthService.deleteUser', () => {
  it('soft-deletes, revokes user-owned credentials, and preserves shared inference connections', async () => {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      oidcSubject: 'target-subject',
      email: 'target@example.com',
      name: 'Target',
      avatarUrl: null,
      groupId: 'group-original',
      additionalScopes: [],
      isBlocked: false,
      deletedAt: null,
    };
    const updatedValues: unknown[] = [];
    const deleteQuery = vi.fn((_table: unknown) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const updateQuery = vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        updatedValues.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue(table === users ? [{ id: target.id }] : []),
          })),
        };
      }),
    }));
    const db = {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(target) },
        permissionGroups: { findFirst: vi.fn().mockResolvedValue({ id: 'group-system-admin', name: 'system-admin' }) },
      },
      update: updateQuery,
      delete: deleteQuery,
    };
    const sessionService = { destroyAllUserSessions: vi.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: vi.fn() };
    const service = new AuthService(db as any, sessionService as any, {} as any, {} as any, {} as any);
    service.setEventBus(eventBus as any);

    await service.deleteUser(target.id, '11111111-1111-4111-8111-111111111111');

    expect(updatedValues[0]).toEqual(
      expect.objectContaining({
        groupId: 'group-system-admin',
        deletedFromGroupId: 'group-original',
        deletedByUserId: '11111111-1111-4111-8111-111111111111',
        isBlocked: true,
        deletedAt: expect.any(Date),
      })
    );
    expect(sessionService.destroyAllUserSessions).toHaveBeenCalledWith(target.id);
    expect(deleteQuery.mock.calls.map(([table]) => table)).not.toContain(inferenceProviderConnections);
    expect(eventBus.publish).toHaveBeenCalledWith(`permissions.changed.${target.id}`, {
      scopes: [],
      groupId: null,
      reason: 'user_deleted',
    });
  });
});

describe('AuthService user preferences', () => {
  it('reads the current AI approval mode', async () => {
    const findFirst = vi.fn().mockResolvedValue({ aiApprovalMode: 'bypass-non-destructive' });
    const service = new AuthService(
      { query: { users: { findFirst } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getUserPreferences('user-1')).resolves.toEqual({
      aiApprovalMode: 'bypass-non-destructive',
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { aiApprovalMode: true },
      })
    );
  });

  it('updates the current AI approval mode and emits a user update', async () => {
    const returning = vi.fn().mockResolvedValue([{ aiApprovalMode: 'always-ask' }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const eventBus = { publish: vi.fn() };
    const service = new AuthService(
      { update: vi.fn(() => ({ set })) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    service.setEventBus(eventBus as any);

    await expect(service.updateUserPreferences('user-1', { aiApprovalMode: 'always-ask' })).resolves.toEqual({
      aiApprovalMode: 'always-ask',
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        aiApprovalMode: 'always-ask',
        updatedAt: expect.any(Date),
      })
    );
    expect(eventBus.publish).toHaveBeenCalledWith('user.changed', {
      id: 'user-1',
      action: 'updated',
    });
  });
});

describe('AuthService.listUsers', () => {
  it('returns the persisted sign-in method for an admin reload', async () => {
    vi.mocked(fetchGroupScopeMap).mockResolvedValue(new Map());
    vi.mocked(computeEffectiveUserAccess).mockReturnValue({
      groupName: 'viewer',
      groupScopes: ['nodes:details'],
      additionalScopes: [],
      scopes: ['nodes:details'],
    });
    const service = new AuthService(
      {
        query: {
          users: {
            findMany: vi.fn().mockResolvedValue([
              {
                ...dbUser({ authMethod: 'password' }),
                additionalScopes: [],
                aiApprovalMode: 'normal',
                folderId: null,
                sortOrder: 0,
              },
            ]),
          },
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.listUsers()).resolves.toEqual([
      expect.objectContaining({ email: 'user@example.com', authMethod: 'password' }),
    ]);
  });
});

describe('AuthService additional permissions', () => {
  const targetUser = {
    id: '22222222-2222-4222-8222-222222222222',
    oidcSubject: 'target-user',
    email: 'target@example.com',
    name: 'Target',
    avatarUrl: null,
    groupId: 'group-1',
    groupName: 'viewer',
    groupScopes: ['nodes:details:node-1'],
    additionalScopes: [],
    scopes: ['nodes:details:node-1'],
    isBlocked: false,
  };

  function serviceWithTarget() {
    const service = new AuthService({} as any, {} as any, {} as any, {} as any, {} as any);
    vi.spyOn(service, 'getUserById').mockResolvedValue(targetUser);
    return service;
  }

  it('allows only valid additional scopes possessed by the actor', async () => {
    const service = serviceWithTarget();

    await expect(
      service.assertCanUpdateUserAdditionalScopes(
        'actor-1',
        ['nodes:details:node-1', 'nodes:console:node-1'],
        targetUser.id,
        ['nodes:console:node-1']
      )
    ).resolves.toEqual({ targetUser, additionalScopes: ['nodes:console:node-1'] });
  });

  it('rejects self-assignment and protected system scope grants', async () => {
    const service = serviceWithTarget();

    await expect(
      service.assertCanUpdateUserAdditionalScopes(targetUser.id, ['admin:system'], targetUser.id, [])
    ).rejects.toMatchObject({ code: 'SELF_PERMISSION_CHANGE' });
    await expect(
      service.assertCanUpdateUserAdditionalScopes('actor-1', ['admin:system', 'nodes:details:node-1'], targetUser.id, [
        'admin:system',
      ])
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('rejects invalid or unowned additional scopes', async () => {
    const service = serviceWithTarget();

    await expect(
      service.assertCanUpdateUserAdditionalScopes('actor-1', ['nodes:details:node-1'], targetUser.id, [
        'not:a:real:scope',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    await expect(
      service.assertCanUpdateUserAdditionalScopes('actor-1', ['nodes:details:node-1'], targetUser.id, [
        'nodes:console:node-1',
      ])
    ).rejects.toMatchObject({ code: 'PRIVILEGE_BOUNDARY' });
  });

  it('persists additional permissions across a group change and emits effective scopes', async () => {
    const updatedDbUser = {
      ...targetUser,
      groupId: 'group-2',
      additionalScopes: ['nodes:console:node-1'],
      aiApprovalMode: 'normal',
      folderId: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const returning = vi.fn().mockResolvedValue([updatedDbUser]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const eventBus = { publish: vi.fn() };
    const service = new AuthService(
      {
        query: { permissionGroups: { findFirst: vi.fn().mockResolvedValue({ id: 'group-2' }) } },
        update: vi.fn(() => ({ set })),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    service.setEventBus(eventBus as any);

    const updated = await service.updateUserGroup(targetUser.id, 'group-2');

    expect(updated.additionalScopes).toEqual(['nodes:console:node-1']);
    expect(updated.scopes).toEqual(['nodes:details', 'nodes:console:node-1']);
    expect(eventBus.publish).toHaveBeenCalledWith(`permissions.changed.${targetUser.id}`, {
      scopes: ['nodes:details', 'nodes:console:node-1'],
      groupId: 'group-2',
      reason: 'permissions_changed',
    });
  });
});

describe('normalizeOidcClaims', () => {
  it('requires a subject claim', () => {
    expect(() => normalizeOidcClaims({ email: 'user@example.com' })).toThrow('No subject claim in ID token');
  });

  it('allows missing email so existing subject-bound users can still be resolved', () => {
    expect(normalizeOidcClaims({ sub: 'oidc-sub' })).toMatchObject({
      oidcSubject: 'oidc-sub',
      email: null,
    });
    expect(normalizeOidcClaims({ sub: 'oidc-sub', email: '   ' })).toMatchObject({
      oidcSubject: 'oidc-sub',
      email: null,
    });
  });

  it('preserves the OIDC subject as an opaque identifier', () => {
    expect(normalizeOidcClaims({ sub: ' oidc-sub ', email: 'user@example.com' })).toMatchObject({
      oidcSubject: ' oidc-sub ',
      email: 'user@example.com',
    });
  });

  it('rejects subjects in the reserved Gateway system namespace', () => {
    expect(() => normalizeOidcClaims({ sub: 'system:external-user', email: 'user@example.com' })).toThrow(
      'OIDC subject uses a reserved Gateway namespace'
    );
  });

  it('normalizes email and treats only boolean true as verified', () => {
    expect(
      normalizeOidcClaims({
        sub: 'oidc-sub',
        email: ' User@Example.COM ',
        email_verified: true,
        name: 'User',
        picture: 'https://example.com/avatar.png',
      })
    ).toEqual({
      oidcSubject: 'oidc-sub',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: 'https://example.com/avatar.png',
    });

    expect(
      normalizeOidcClaims({
        sub: 'oidc-sub',
        email: 'user@example.com',
        email_verified: 'true',
      }).emailVerified
    ).toBe(false);
  });
});

describe('AuthService OIDC identity binding', () => {
  it('rejects a deleted subject before creating a session', async () => {
    const sessionService = { createSession: vi.fn() };
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: false,
      },
      existingBySubject: dbUser({ deletedAt: new Date() }),
      sessionService,
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'real-sub',
        email: 'user@example.com',
        emailVerified: true,
        name: 'User',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_DELETED' });
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('rejects an OIDC callback when OIDC was disabled after the redirect began', async () => {
    authorizationCodeGrantMock.mockClear();
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
        methods: { oidc: false },
      },
    });

    await expect(harness.service.getAuthorizationUrl()).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUTH_METHOD_DISABLED',
    });
    await expect(
      harness.service.handleCallback('https://gateway.example.com/callback?code=code&state=state', 'state')
    ).rejects.toMatchObject({ statusCode: 409, code: 'AUTH_METHOD_DISABLED' });
    expect(authorizationCodeGrantMock).not.toHaveBeenCalled();
  });

  it('allows an existing subject-bound user when the provider omits email', async () => {
    const existingUser = dbUser({
      oidcSubject: 'real-sub',
      email: 'old@example.com',
      name: 'Old Name',
      avatarUrl: null,
    });
    const updatedUser = { ...existingUser, name: 'New Name' };
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingBySubject: existingUser,
      updateReturning: updatedUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: null,
      emailVerified: false,
      name: 'New Name',
      avatarUrl: null,
    });

    expect(result.user.email).toBe('old@example.com');
    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'old@example.com',
        name: 'New Name',
      })
    );
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_profile_sync',
        details: expect.objectContaining({
          oidcSubject: 'real-sub',
          emailClaimMissing: true,
          emailVerified: false,
        }),
      })
    );
  });

  it('normalizes a missing OIDC name to the account email', async () => {
    const existingUser = dbUser({ oidcSubject: 'real-sub', name: null });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: false,
      },
      existingBySubject: existingUser,
      updateReturning: { ...existingUser, name: existingUser.email },
    });

    await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: existingUser.email,
      emailVerified: true,
      name: null,
      avatarUrl: null,
    });

    expect(harness.updateSet).toHaveBeenCalledWith(expect.objectContaining({ name: existingUser.email }));
  });

  it('allows an existing subject-bound user with unverified email and does not sync a changed email', async () => {
    const existingUser = dbUser({
      oidcSubject: 'real-sub',
      email: 'old@example.com',
      name: 'Old Name',
      avatarUrl: null,
    });
    const updatedUser = { ...existingUser, name: 'New Name', avatarUrl: 'https://example.com/avatar.png' };
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingBySubject: existingUser,
      updateReturning: updatedUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: 'new@example.com',
      emailVerified: false,
      name: 'New Name',
      avatarUrl: 'https://example.com/avatar.png',
    });

    expect(result.user.email).toBe('old@example.com');
    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'old@example.com',
        name: 'New Name',
        avatarUrl: 'https://example.com/avatar.png',
      })
    );
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_profile_sync',
        details: expect.objectContaining({
          oidcSubject: 'real-sub',
          emailChanged: false,
          emailClaimIgnored: true,
          emailVerified: false,
        }),
      })
    );
  });

  it('rejects pre-created user claim when verified-email mode is enabled and email is unverified', async () => {
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingByEmail: dbUser({
        id: 'user-1',
        oidcSubject: 'manual:user@example.com',
        email: 'user@example.com',
        groupId: 'admin-group',
      }),
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'real-sub',
        email: 'user@example.com',
        emailVerified: false,
        name: 'User',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'OIDC_EMAIL_NOT_VERIFIED',
    });
  });

  it('claims a pre-created user when verified-email mode is enabled and email is verified', async () => {
    const claimedUser = dbUser({
      id: 'user-1',
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      name: 'User',
    });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingByEmail: dbUser({
        id: 'user-1',
        oidcSubject: 'manual:user@example.com',
        email: 'user@example.com',
        groupId: 'admin-group',
      }),
      updateReturning: claimedUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });

    expect(result.user.oidcSubject).toBe('real-sub');
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_claimed',
        details: expect.objectContaining({
          previousOidcSubject: 'manual:user@example.com',
          oidcSubject: 'real-sub',
          emailVerified: true,
        }),
      })
    );
  });

  it('rejects post-bootstrap auto-create when verified-email mode is enabled and email is unverified', async () => {
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      userCount: 1,
      provisioningGroup: { id: 'viewer-group', name: 'viewer' },
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'real-sub',
        email: 'user@example.com',
        emailVerified: false,
        name: 'User',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'OIDC_EMAIL_NOT_VERIFIED',
    });
  });

  it('never grants the first arbitrary OIDC user the system-admin group', async () => {
    const createdUser = dbUser({
      id: 'user-1',
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      name: 'User',
      groupId: 'viewer-group',
    });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      userCount: 0,
      provisioningGroup: { id: 'viewer-group', name: 'viewer' },
      insertReturning: createdUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });

    expect(result.user.id).toBe('user-1');
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_provisioned',
        details: expect.objectContaining({
          oidcSubject: 'real-sub',
          emailVerified: true,
          bootstrap: false,
        }),
      })
    );
  });
});

function dbUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    id: 'user-1',
    oidcSubject: 'real-sub',
    authMethod: 'oidc',
    email: 'user@example.com',
    name: null,
    avatarUrl: null,
    groupId: 'group-1',
    isBlocked: false,
    ...overrides,
  };
}

interface DbUser {
  id: string;
  oidcSubject: string;
  authMethod: 'oidc' | 'password' | 'email_otp';
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  isBlocked: boolean;
  deletedAt?: Date | null;
}

function createAuthServiceHarness(options: {
  authSettings: {
    oidcAutoCreateUsers: boolean;
    oidcDefaultGroupId: string;
    oidcRequireVerifiedEmail: boolean;
    methods?: { oidc?: boolean };
  };
  existingBySubject?: DbUser | null;
  existingByEmail?: DbUser | null;
  userCount?: number;
  provisioningGroup?: { id: string; name: string } | null;
  updateReturning?: DbUser;
  insertReturning?: DbUser;
  sessionService?: { createSession: ReturnType<typeof vi.fn> };
}) {
  const updateSet = vi.fn((_: unknown) => ({
    where: vi.fn(() => ({
      returning: vi
        .fn()
        .mockResolvedValue([options.updateReturning ?? options.existingBySubject ?? options.existingByEmail]),
    })),
  }));
  const insertValues = vi.fn((_: unknown) => ({
    returning: vi.fn().mockResolvedValue([options.insertReturning]),
  }));

  const db = {
    query: {
      users: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(options.existingBySubject ?? null)
          .mockResolvedValueOnce(options.existingByEmail ?? null),
      },
      permissionGroups: {
        findFirst: vi.fn().mockResolvedValue(options.provisioningGroup ?? { id: 'viewer-group', name: 'viewer' }),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: options.userCount ?? 1 }]),
      })),
    })),
    update: vi.fn(() => ({
      set: updateSet,
    })),
    insert: vi.fn(() => ({
      values: insertValues,
    })),
  };
  const sessionService = options.sessionService ?? {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
  };
  const cacheService = {
    get: vi.fn().mockResolvedValue({ codeVerifier: 'verifier', state: 'state' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const authSettingsService = {
    getConfig: vi.fn().mockResolvedValue(options.authSettings),
  };
  const auditService = {
    log: vi.fn().mockResolvedValue(undefined),
  };
  const service = new AuthService(
    db as any,
    sessionService as any,
    cacheService as any,
    authSettingsService as any,
    auditService as any
  );
  (service as any).oidcConfig = {};

  return {
    auditService,
    sessionService,
    service,
    updateSet,
    async loginWithClaims(claims: NormalizedOidcClaims) {
      authorizationCodeGrantMock.mockResolvedValueOnce({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        claims: () => ({
          sub: claims.oidcSubject,
          email: claims.email,
          email_verified: claims.emailVerified,
          name: claims.name,
          picture: claims.avatarUrl,
        }),
      });

      return service.handleCallback('https://gateway.example.com/callback?code=code&state=state', 'state');
    },
  };
}
