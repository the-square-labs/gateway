import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { uiBootstrapRoutes } from './ui-bootstrap.routes.js';
import { UIBootstrapService } from './ui-bootstrap.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
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
  app.route('/api/ui', uiBootstrapRoutes);
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

afterEach(() => {
  container.reset();
});

describe('UI bootstrap route', () => {
  it('uses the server-resolved session scopes and never trusts a client-provided shell', async () => {
    const scopes = ['nodes:details:node-1', 'status-page:view'];
    registerSession(scopes);
    const getShell = vi.fn().mockResolvedValue({
      access: { fingerprint: 'server-fingerprint', scopes },
      systemConfig: {},
      navigation: { hasNginxNodes: true, statusPageEnabled: true, dockerNodes: [], nodes: {} },
      update: null,
      aiStatus: null,
    });
    container.registerInstance(UIBootstrapService, { getShell } as unknown as UIBootstrapService);

    const response = await createApp().request('/api/ui/bootstrap?scopes=admin:system', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(getShell).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), scopes);
    await expect(response.json()).resolves.toMatchObject({
      data: { access: { fingerprint: 'server-fingerprint', scopes } },
    });
  });
});
