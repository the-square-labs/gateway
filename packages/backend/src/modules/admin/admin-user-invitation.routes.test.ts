import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { adminRoutes } from './admin.routes.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

const ADMIN: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-admin',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [],
  isBlocked: false,
};

const TARGET: User = {
  ...ADMIN,
  id: '22222222-2222-4222-8222-222222222222',
  oidcSubject: null,
  authMethod: 'email_otp',
  email: 'new.user@example.com',
  name: 'New User',
  groupName: 'viewer',
  scopes: ['nodes:details:node-1'],
};

const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const PUBLIC_URL = 'https://gateway.example.com';

interface InvitationState {
  lastLoginAt: Date | null;
  invitationSentAt: Date | null;
}

/** A users table with one invitable row; updates follow the conditional claim the action issues. */
function registerDatabase(state: InvitationState, scopes: string[]) {
  const update = vi.fn(() => ({
    set: (values: { invitationSentAt: Date | null }) => ({
      where: () => {
        const invitationSentAt = values.invitationSentAt;
        // Releasing a failed claim is awaited directly; claiming reads the claimed row back.
        if (invitationSentAt === null) {
          state.invitationSentAt = null;
          return Promise.resolve([]);
        }
        return {
          returning: async () => {
            if (state.invitationSentAt || state.lastLoginAt) return [];
            state.invitationSentAt = invitationSentAt;
            return [{ id: TARGET.id }];
          },
        };
      },
    }),
  }));
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn(async (args?: { columns?: Record<string, boolean> }) =>
          args?.columns?.invitationSentAt
            ? { ...state }
            : {
                id: ADMIN.id,
                oidcSubject: ADMIN.oidcSubject,
                email: ADMIN.email,
                name: ADMIN.name,
                avatarUrl: null,
                groupId: ADMIN.groupId,
                additionalScopes: [],
                isBlocked: false,
              }
        ),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([{ id: ADMIN.groupId, parentId: null, name: ADMIN.groupName, scopes }]),
      },
    },
    update,
  } as unknown as DrizzleClient);
  return update;
}

function registerInvitationDependencies({
  state = { lastLoginAt: null, invitationSentAt: null },
  smtpVerified = true,
  sendInvitationOnUserCreate = false,
  sendSecurityEmail = vi.fn().mockResolvedValue(undefined),
}: {
  state?: InvitationState;
  smtpVerified?: boolean;
  sendInvitationOnUserCreate?: boolean;
  sendSecurityEmail?: ReturnType<typeof vi.fn>;
} = {}) {
  const scopes = ['admin:users', 'nodes:details:node-1'];
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue({
      userId: ADMIN.id,
      user: ADMIN,
      accessToken: 'oidc-access-token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      csrfToken: 'csrf-token',
    } satisfies SessionData),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  const update = registerDatabase(state, scopes);
  container.registerInstance(AuthMailService, {
    getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: smtpVerified ? '2026-09-01T00:00:00.000Z' : null }),
    sendSecurityEmail,
  } as unknown as AuthMailService);
  container.registerInstance(GeneralSettingsService, {
    getPublicUrl: vi.fn().mockResolvedValue(PUBLIC_URL),
    getConfig: vi.fn().mockResolvedValue({ sendInvitationOnUserCreate }),
  } as unknown as GeneralSettingsService);
  const auditLog = vi.fn().mockResolvedValue(undefined);
  container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);
  container.registerInstance(AuthService, {
    getUserById: vi.fn(async (id: string) => (id === TARGET.id ? TARGET : null)),
    createUser: vi.fn().mockResolvedValue({ ...TARGET, groupId: GROUP_ID }),
    grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthService);
  return { state, sendSecurityEmail, auditLog, update };
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/admin', adminRoutes);
  return app;
}

const headers = {
  Cookie: 'session_id=session-1',
  'X-CSRF-Token': 'csrf-token',
  'Content-Type': 'application/json',
};

function invite(userId = TARGET.id) {
  return createApp().request(`/api/admin/users/${userId}/invitation`, { method: 'POST', headers });
}

afterEach(() => {
  container.reset();
});

describe('POST /api/admin/users/{id}/invitation', () => {
  it('sends the invitation once, marks the user as invited, and audits it', async () => {
    const { sendSecurityEmail, auditLog, state } = registerInvitationDependencies();

    const response = await invite();

    expect(response.status).toBe(200);
    const body = (await response.json()) as User;
    expect(body).toMatchObject({ id: TARGET.id, lastLoginAt: null });
    expect(body.invitationSentAt).toBe(state.invitationSentAt?.toISOString());
    expect(sendSecurityEmail).toHaveBeenCalledWith(TARGET.email, {
      kind: 'account_invitation',
      actionUrl: `${PUBLIC_URL}/login`,
      email: TARGET.email,
      signIn: 'email_otp',
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.invitation_sent',
        resourceId: TARGET.id,
        userId: ADMIN.id,
        details: expect.objectContaining({ targetUserId: TARGET.id, automatic: false }),
      })
    );

    const second = await invite();
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ code: 'INVITATION_ALREADY_SENT' });
    expect(sendSecurityEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a user who has already signed in', async () => {
    const { sendSecurityEmail, update } = registerInvitationDependencies({
      state: { lastLoginAt: new Date('2026-09-20T10:00:00Z'), invitationSentAt: null },
    });

    const response = await invite();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'USER_ALREADY_SIGNED_IN' });
    expect(update).not.toHaveBeenCalled();
    expect(sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('requires verified SMTP like the other admin user emails', async () => {
    const { sendSecurityEmail, update } = registerInvitationDependencies({ smtpVerified: false });

    const response = await invite();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SMTP_NOT_VERIFIED',
      message: 'SMTP must be verified before sending an invitation email',
    });
    expect(update).not.toHaveBeenCalled();
    expect(sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown user', async () => {
    registerInvitationDependencies();

    const response = await invite('44444444-4444-4444-8444-444444444444');

    expect(response.status).toBe(404);
  });

  it('keeps the invitation available when the email cannot be queued', async () => {
    const { state } = registerInvitationDependencies({
      sendSecurityEmail: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    });

    const response = await invite();

    expect(response.status).toBe(500);
    expect(state.invitationSentAt).toBeNull();
  });
});

describe('invitation email on user creation', () => {
  function createUser(authMethod: 'oidc' | 'email_otp' = 'oidc') {
    return createApp().request('/api/admin/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: TARGET.email, name: TARGET.name, groupId: GROUP_ID, authMethod }),
    });
  }

  function registerCreateDependencies(options: Parameters<typeof registerInvitationDependencies>[0]) {
    const deps = registerInvitationDependencies(options);
    container.registerInstance(GroupService, {
      getGroup: vi.fn().mockResolvedValue({ id: GROUP_ID, name: 'viewer', scopes: [], inheritedScopes: [] }),
    } as unknown as GroupService);
    const sendEmailOtpOnboarding = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(LocalAuthService, {
      requestPasswordLink: vi.fn().mockResolvedValue(undefined),
      sendEmailOtpOnboarding,
    } as unknown as LocalAuthService);
    return { ...deps, sendEmailOtpOnboarding };
  }

  it('sends the invitation right after creation when the setting is on', async () => {
    const { sendSecurityEmail, auditLog, sendEmailOtpOnboarding } = registerCreateDependencies({
      sendInvitationOnUserCreate: true,
    });

    const response = await createUser('email_otp');

    expect(response.status).toBe(201);
    const body = (await response.json()) as User;
    expect(body.invitationSentAt).toEqual(expect.any(String));
    expect(sendSecurityEmail).toHaveBeenCalledWith(
      TARGET.email,
      expect.objectContaining({ kind: 'account_invitation', signIn: 'email_otp' })
    );
    // The invitation already explains email-code sign-in.
    expect(sendEmailOtpOnboarding).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.invitation_sent', details: expect.objectContaining({ automatic: true }) })
    );
  });

  it('does not send the invitation when the setting is off', async () => {
    const { sendSecurityEmail, sendEmailOtpOnboarding } = registerCreateDependencies({
      sendInvitationOnUserCreate: false,
    });

    const response = await createUser('email_otp');

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ invitationSentAt: null });
    expect(sendSecurityEmail).not.toHaveBeenCalled();
    expect(sendEmailOtpOnboarding).toHaveBeenCalledWith(TARGET.email);
  });

  it('keeps the created user when the invitation cannot be sent', async () => {
    const { state } = registerCreateDependencies({
      sendInvitationOnUserCreate: true,
      sendSecurityEmail: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    });

    const response = await createUser();

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ id: TARGET.id, invitationSentAt: null });
    expect(state.invitationSentAt).toBeNull();
  });
});
