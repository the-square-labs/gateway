import { describe, expect, it } from 'vitest';
import { computeEffectiveUserAccess, type GroupScopeRecord, resolveLiveUser } from '@/modules/auth/live-session-user.js';

function groupMap(...groups: GroupScopeRecord[]) {
  return new Map(groups.map((group) => [group.id, group]));
}

describe('computeEffectiveUserAccess', () => {
  it('keeps group, additional, and effective scopes distinct', () => {
    const access = computeEffectiveUserAccess(
      'operators',
      groupMap(
        { id: 'base', parentId: null, name: 'base', scopes: ['nodes:details:node-1'] },
        { id: 'operators', parentId: 'base', name: 'operators', scopes: ['nodes:logs:node-1'] }
      ),
      ['nodes:console:node-1']
    );

    expect(access.groupScopes).toEqual(['nodes:details:node-1', 'nodes:logs:node-1']);
    expect(access.additionalScopes).toEqual(['nodes:console:node-1']);
    expect(access.scopes).toEqual(['nodes:console:node-1', 'nodes:details:node-1', 'nodes:logs:node-1']);
  });

  it('preserves an additional resource grant even when a broad group scope currently covers it', () => {
    const access = computeEffectiveUserAccess(
      'operators',
      groupMap({ id: 'operators', parentId: null, name: 'operators', scopes: ['nodes:console'] }),
      ['nodes:console:node-1']
    );

    expect(access.additionalScopes).toEqual(['nodes:console:node-1']);
    expect(access.scopes).toEqual(['nodes:console']);
  });
});

describe('resolveLiveUser', () => {
  it('treats a soft-deleted account as blocked with no effective scopes', async () => {
    const user = await resolveLiveUser(
      {
        query: {
          users: {
            findFirst: async () => ({
              id: 'user-1',
              oidcSubject: 'subject',
              email: 'user@example.com',
              name: 'User',
              avatarUrl: null,
              groupId: 'group-1',
              additionalScopes: ['nodes:console'],
              isBlocked: false,
              deletedAt: new Date(),
            }),
          },
          permissionGroups: {
            findMany: async () => [{ id: 'group-1', parentId: null, name: 'viewer', scopes: ['nodes:details'] }],
          },
        },
      } as any,
      'user-1'
    );

    expect(user).toMatchObject({ isBlocked: true, isDeleted: true, scopes: [] });
  });
});
