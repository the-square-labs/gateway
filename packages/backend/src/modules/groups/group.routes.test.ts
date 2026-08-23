import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { groupRoutes } from './group.routes.js';
import { GroupService } from './group.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: '22222222-2222-4222-8222-222222222222',
  groupName: 'custom-admin',
  scopes: [],
  isBlocked: false,
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  csrfToken: 'csrf-token',
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/admin/groups', groupRoutes);
  return app;
}

function registerSession(scopes: string[]) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked: USER.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes }]),
      },
    },
  } as unknown as DrizzleClient);
}

function sessionHeaders() {
  return {
    Cookie: 'session_id=session-1',
    'X-CSRF-Token': 'csrf-token',
    'Content-Type': 'application/json',
  };
}

afterEach(() => {
  container.reset();
});

describe('group route permissions', () => {
  it('accepts a custom group without direct scopes', async () => {
    registerSession(['admin:groups']);
    const assertCanCreateGroup = vi.fn().mockResolvedValue(undefined);
    const createGroup = vi.fn().mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'empty-group',
      scopes: [],
    });
    container.registerInstance(GroupService, {
      assertCanCreateGroup,
      createGroup,
    } as unknown as GroupService);
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);

    const response = await createApp().request('/api/admin/groups', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({ name: 'empty-group', scopes: [] }),
    });

    expect(response.status).toBe(201);
    expect(assertCanCreateGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'empty-group', scopes: [] }), [
      'admin:groups',
    ]);
    expect(createGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'empty-group', scopes: [] }));
  });

  it('does not delete groups when delete authorization rejects affected scopes', async () => {
    registerSession(['admin:groups', 'nodes:details']);
    const assertCanDeleteGroup = vi
      .fn()
      .mockRejectedValue(
        new AppError(403, 'SCOPE_NOT_ALLOWED', 'Cannot delete a group that affects scopes you do not possess')
      );
    const deleteGroup = vi.fn();
    const getGroup = vi.fn();
    container.registerInstance(GroupService, {
      assertCanDeleteGroup,
      getGroup,
      deleteGroup,
    } as unknown as GroupService);
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);

    const response = await createApp().request('/api/admin/groups/33333333-3333-4333-8333-333333333333', {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(403);
    expect(assertCanDeleteGroup).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', [
      'admin:groups',
      'nodes:details',
    ]);
    expect(getGroup).not.toHaveBeenCalled();
    expect(deleteGroup).not.toHaveBeenCalled();
  });
});
