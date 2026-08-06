import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { authRoutes } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

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

function registerDependencies() {
  const revokeUserSessionByPublicId = vi.fn().mockResolvedValue(true);
  const auditLog = vi.fn().mockResolvedValue(true);

  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
    revokeUserSessionByPublicId,
  } as unknown as SessionService);
  container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: { findFirst: vi.fn().mockResolvedValue(USER) },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes: USER.scopes }]),
      },
    },
  } as unknown as DrizzleClient);

  return { revokeUserSessionByPublicId, auditLog };
}

afterEach(() => {
  container.reset();
});

describe('browser-session routes', () => {
  it('authenticates DELETE /me/sessions/:id before accessing the current user', async () => {
    const { revokeUserSessionByPublicId, auditLog } = registerDependencies();
    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/me/sessions/session-public-id', {
      method: 'DELETE',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Session revoked' });
    expect(revokeUserSessionByPublicId).toHaveBeenCalledWith(USER.id, 'session-public-id', {
      excludeSessionId: 'current-session-id',
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id, resourceId: 'session-public-id', action: 'auth.session_revoke' })
    );
  });
});

describe('OIDC callback route', () => {
  it('passes the resolved client metadata to the OIDC session', async () => {
    const { auditLog } = registerDependencies();
    const handleCallback = vi.fn().mockResolvedValue({ sessionId: 'new-session-id', user: USER });
    container.registerInstance(AuthService, { handleCallback } as unknown as AuthService);
    container.registerInstance(OidcSettingsService, {
      getRuntimeConfig: vi.fn().mockResolvedValue({ redirectUri: 'https://gateway.example.com/auth/callback' }),
    } as unknown as OidcSettingsService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://gateway.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'reverse_proxy',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);

    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/callback?code=code&state=state', {
      headers: {
        'User-Agent': 'Mozilla/5.0 Gateway browser',
        'X-Forwarded-For': '203.0.113.10',
      },
    });

    expect(response.status).toBe(302);
    expect(handleCallback).toHaveBeenCalledWith(
      'https://gateway.example.com/auth/callback?code=code&state=state',
      'state',
      {
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0 Gateway browser',
      }
    );
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login', userId: USER.id }));
  });
});
