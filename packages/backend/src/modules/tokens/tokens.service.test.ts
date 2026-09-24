import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { TokensService } from './tokens.service.js';

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
