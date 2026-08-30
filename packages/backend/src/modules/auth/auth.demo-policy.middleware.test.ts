import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';

vi.mock('@/config/env.js', () => ({
  getDeploymentMode: () => 'demo',
  getEnv: () => ({
    GATEWAY_DEPLOYMENT_MODE: 'demo',
    PKI_MASTER_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
  }),
}));

import { authMiddleware } from './auth.middleware.js';

const DEMO_USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: null,
  authMethod: 'demo_email_otp',
  email: 'visitor@example.test',
  name: 'Visitor',
  avatarUrl: null,
  groupId: 'demo-admin-id',
  groupName: 'demo-admin',
  groupScopes: ['docker:containers:create'],
  additionalScopes: [],
  scopes: ['docker:containers:create'],
  isBlocked: false,
  isDeleted: false,
};

afterEach(() => {
  container.reset();
});

describe('demo policy middleware boundary', () => {
  it('rejects before route, daemon dispatch, or session refresh side effects', async () => {
    const session: SessionData = {
      userId: DEMO_USER.id,
      user: DEMO_USER,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      csrfToken: 'csrf-token',
    };
    const updateSession = vi.fn();
    const touchSession = vi.fn();
    const refreshSession = vi.fn();
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(session),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession,
      touchSession,
      refreshSession,
    } as never);
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(DEMO_USER) },
        permissionGroups: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: DEMO_USER.groupId,
              parentId: null,
              name: DEMO_USER.groupName,
              scopes: DEMO_USER.scopes,
              requireGateway2fa: false,
            },
          ]),
        },
      },
    } as unknown as DrizzleClient);
    const dispatch = vi.fn();
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', authMiddleware);
    app.post('/api/docker/containers', async (c) => {
      await dispatch();
      return c.json({ ok: true });
    });

    const response = await app.request('/api/docker/containers', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=demo-session',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DEMO_MODE_RESTRICTED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(touchSession).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
