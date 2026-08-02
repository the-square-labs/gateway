import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['nodes:details'],
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

function createDb({ isBlocked = false }: { isBlocked?: boolean } = {}): DrizzleClient {
  return {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: USER.groupId,
            parentId: null,
            name: USER.groupName,
            scopes: USER.scopes,
          },
        ]),
      },
    },
  } as unknown as DrizzleClient;
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ message: error.message }, error.status);
    }
    throw error;
  });
  app.use('*', authMiddleware);
  app.get('/auth/csrf', (c) => c.json({ userId: c.get('user')?.id, isBlocked: c.get('user')?.isBlocked }));
  app.get('/auth/me', (c) => c.json({ userId: c.get('user')?.id, isBlocked: c.get('user')?.isBlocked }));
  app.post('/auth/logout', (c) => c.json({ userId: c.get('user')?.id, isBlocked: c.get('user')?.isBlocked }));
  app.get('/read', (c) => c.json({ userId: c.get('user')?.id }));
  app.post('/mutate', (c) => c.json({ userId: c.get('user')?.id }));
  return app;
}

function registerSession({ csrfValid = true, isBlocked = false }: { csrfValid?: boolean; isBlocked?: boolean } = {}) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(csrfValid),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, createDb({ isBlocked }));
}

afterEach(() => {
  container.reset();
});

describe('authMiddleware browser session credentials', () => {
  it('accepts a cookie session with a valid CSRF token for mutations', async () => {
    registerSession({ csrfValid: true });

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('rejects a cookie session mutation without a valid CSRF token', async () => {
    registerSession({ csrfValid: false });

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: 'Invalid CSRF token' });
  });

  it('uses userId from a legacy session that does not contain a cached user object', async () => {
    const legacySession = { ...SESSION, user: undefined } as unknown as SessionData;
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(legacySession),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      destroySession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionService);
    container.registerInstance(TOKENS.DrizzleClient, createDb());

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=legacy-session',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('rejects long-lived session ids sent as bearer or query credentials', async () => {
    registerSession();

    const bearerResponse = await createApp().request('/read', {
      headers: { Authorization: 'Bearer session-1' },
    });
    const queryResponse = await createApp().request('/read?token=session-1');

    expect(bearerResponse.status).toBe(401);
    expect(queryResponse.status).toBe(401);
  });

  it('keeps API-token mutations independent of CSRF', async () => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({ user: USER, scopes: USER.scopes }),
    } as unknown as TokensService);

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_test_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('rejects blocked session users on protected routes but leaves auth status and logout routes reachable', async () => {
    registerSession({ isBlocked: true });

    const protectedResponse = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const csrfResponse = await createApp().request('/auth/csrf', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const meResponse = await createApp().request('/auth/me', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const logoutResponse = await createApp().request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'X-CSRF-Token': 'csrf-token' },
    });

    expect(protectedResponse.status).toBe(403);
    expect(await protectedResponse.json()).toEqual({ message: 'Account is blocked' });
    expect(csrfResponse.status).toBe(200);
    expect(await csrfResponse.json()).toEqual({ userId: USER.id, isBlocked: true });
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toEqual({ userId: USER.id, isBlocked: true });
    expect(logoutResponse.status).toBe(200);
    expect(await logoutResponse.json()).toEqual({ userId: USER.id, isBlocked: true });
  });
});
