import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { hasScope } from '@/lib/permissions.js';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { resolveRequestedTokenScopes, TokensService } from './tokens.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_HASH = 'token-hash';

function createDb({
  userGroupId,
  tokenScopes,
  groups,
}: {
  userGroupId: string;
  tokenScopes: string[];
  groups: Array<{ id: string; name: string; parentId: string | null; scopes: string[] }>;
}) {
  const updateExecute = vi.fn().mockResolvedValue(undefined);

  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: updateExecute,
        }),
      }),
    }),
    query: {
      apiTokens: {
        findFirst: vi.fn().mockResolvedValue({
          id: '22222222-2222-4222-8222-222222222222',
          userId: USER_ID,
          tokenHash: TOKEN_HASH,
          scopes: tokenScopes,
        }),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER_ID,
          oidcSubject: 'oidc-user',
          email: 'admin@example.com',
          name: 'Admin',
          avatarUrl: null,
          groupId: userGroupId,
          isBlocked: false,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue(groups),
      },
    },
  };
}

function createService(db: any) {
  return new TokensService(db, { log: vi.fn().mockResolvedValue(undefined) } as any);
}

describe('TokensService.validateToken', () => {
  it('never lets a destination-only creation grant reach existing resources through a token', async () => {
    // Reviewer repro: the owner can create containers on n1 but cannot view the ones already there.
    const db = createDb({
      userGroupId: 'creator-group',
      tokenScopes: ['docker:containers:view', 'docker:containers:view:node/n1'],
      groups: [{ id: 'creator-group', name: 'creators', parentId: null, scopes: ['docker:containers:create:node/n1'] }],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual([]);
    expect(hasScope(result?.scopes ?? [], 'docker:containers:view:n1/c1')).toBe(false);
  });

  it('never lets a folder creation grant reach the folder contents through a token', async () => {
    const folder = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const db = {
      ...createDb({
        userGroupId: 'creator-group',
        tokenScopes: ['proxy:view', `proxy:view:${folder}`],
        groups: [{ id: 'creator-group', name: 'creators', parentId: null, scopes: [`proxy:create:${folder}`] }],
      }),
      // Folder expansion: the folder holds route host-1.
      select: vi.fn((fields: Record<string, unknown>) => ({
        from: () =>
          'parentId' in fields
            ? Promise.resolve([{ id: folder.slice('folder/'.length), parentId: null }])
            : { where: async () => [{ id: 'host-1', folderId: folder.slice('folder/'.length) }] },
      })),
    };

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual([]);
    expect(hasScope(result?.scopes ?? [], 'proxy:view:host-1')).toBe(false);
  });

  it('keeps a token folder grant bounded by an owner who can view that folder', async () => {
    const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const db = {
      ...createDb({
        userGroupId: 'viewer-group',
        tokenScopes: [`proxy:view:folder/${folderId}`],
        groups: [{ id: 'viewer-group', name: 'viewers', parentId: null, scopes: ['proxy:view'] }],
      }),
      select: vi.fn((fields: Record<string, unknown>) => ({
        from: () =>
          'parentId' in fields
            ? Promise.resolve([{ id: folderId, parentId: null }])
            : { where: async () => [{ id: 'host-1', folderId }] },
      })),
    };

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual([`proxy:view:folder/${folderId}`, 'proxy:view:host-1']);
  });

  it('bounds token scopes by the token owner current group after demotion', async () => {
    const db = createDb({
      userGroupId: 'viewer-group',
      tokenScopes: ['admin:users', 'nodes:details'],
      groups: [
        { id: 'admin-group', name: 'admin', parentId: null, scopes: ['admin:users', 'nodes:details'] },
        { id: 'viewer-group', name: 'viewer', parentId: null, scopes: ['nodes:details'] },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.user.groupName).toBe('viewer');
    expect(result?.user.scopes).toEqual(['nodes:details']);
    expect(result?.scopes).toEqual(['nodes:details']);
  });

  it('allows only the currently granted resource when a broad token owner is narrowed', async () => {
    const db = createDb({
      userGroupId: 'limited-group',
      tokenScopes: ['nodes:details'],
      groups: [{ id: 'limited-group', name: 'limited', parentId: null, scopes: ['nodes:details:node-1'] }],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual(['nodes:details:node-1']);
  });

  it('uses inherited current group scopes when bounding a token', async () => {
    const db = createDb({
      userGroupId: 'child-group',
      tokenScopes: ['status-page:manage', 'admin:users'],
      groups: [
        { id: 'parent-group', name: 'parent', parentId: null, scopes: ['status-page:manage'] },
        { id: 'child-group', name: 'child', parentId: 'parent-group', scopes: ['nodes:details'] },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.user.scopes).toEqual(['nodes:details', 'status-page:manage']);
    expect(result?.scopes).toEqual(['status-page:manage']);
  });

  it('filters user-only AI scopes from existing tokens but keeps delegable inference access', async () => {
    const db = createDb({
      userGroupId: 'admin-group',
      tokenScopes: ['feat:ai:use', 'feat:ai:configure', 'ai:workspace:use', 'nodes:details'],
      groups: [
        {
          id: 'admin-group',
          name: 'admin',
          parentId: null,
          scopes: ['feat:ai:use', 'feat:ai:configure', 'ai:workspace:use', 'nodes:details'],
        },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual(['feat:ai:use', 'nodes:details']);
  });
});

describe('TokensService.updateToken', () => {
  it('stores canonical API token scopes', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      update: vi.fn().mockReturnValue({ set }),
      query: {
        apiTokens: {
          findFirst: vi.fn().mockResolvedValue({
            id: '22222222-2222-4222-8222-222222222222',
            userId: USER_ID,
            name: 'CI',
            scopes: ['nodes:details'],
          }),
        },
      },
    };

    await createService(db).updateToken(USER_ID, '22222222-2222-4222-8222-222222222222', {
      scopes: ['proxy:view:host-1', 'proxy:view'],
    });

    expect(set).toHaveBeenCalledWith({ scopes: ['proxy:view'] });
  });
});

describe('TokensService impersonation guard', () => {
  it('refuses to mint or widen API tokens inside an impersonated request', async () => {
    const db = { insert: vi.fn(), update: vi.fn(), query: { apiTokens: { findFirst: vi.fn() } } };
    const service = createService(db);
    const impersonation = {
      actorUserId: 'actor-1',
      subjectUserId: USER_ID,
      subjectEmail: 'subject@example.com',
      subjectName: 'Subject',
    };

    await runWithAuditRequestContext({ impersonation }, async () => {
      await expect(service.createToken(USER_ID, { name: 'CI', scopes: ['nodes:details'] })).rejects.toMatchObject({
        statusCode: 403,
        code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN',
      });
      await expect(
        service.updateToken(USER_ID, '22222222-2222-4222-8222-222222222222', { scopes: ['nodes:details'] })
      ).rejects.toMatchObject({ code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' });
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('resolveRequestedTokenScopes', () => {
  it('rejects a list that only held removed scopes', () => {
    expect(() => resolveRequestedTokenScopes(['ssl:cert:revoke'], ['ssl:cert:view'], 'create')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'INVALID_SCOPE' })
    );
  });

  it('adds the migration 0200 grants a new token owner can delegate, and only on creation', () => {
    const owner = [
      'integrations:github:manage',
      'integrations:github:repo:read',
      'integrations:github:repo:write',
      'docker:volumes:create',
      'pki:ca:create:root',
      'pki:ca:edit',
      'pki:ca:export',
    ];
    // Repository writes need manual approval, so they are never added implicitly.
    expect(resolveRequestedTokenScopes(['integrations:github:manage'], owner, 'create')).toEqual([
      'integrations:github:manage',
      'integrations:github:repo:read',
    ]);
    // Neither is CA key export.
    expect(resolveRequestedTokenScopes(['pki:ca:create:root'], owner, 'create')).toEqual([
      'pki:ca:create:root',
      'pki:ca:edit',
    ]);
    // docker:volumes:edit is not held by the owner, so it is not added.
    expect(resolveRequestedTokenScopes(['docker:volumes:create'], owner, 'create')).toEqual(['docker:volumes:create']);
    expect(resolveRequestedTokenScopes(['integrations:github:manage'], owner, 'update')).toEqual([
      'integrations:github:manage',
    ]);
  });
});
