import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { SessionService } from '@/services/session.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { adminRoutes } from './admin.routes.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

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

const TARGET_USER: User = {
  ...USER,
  id: '22222222-2222-4222-8222-222222222222',
  oidcSubject: 'target-user',
  email: 'target@example.com',
  name: 'Target User',
  groupName: 'viewer',
  scopes: ['nodes:details:node-1'],
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/admin', adminRoutes);
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
          additionalScopes: [],
          isBlocked: USER.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes }]),
      },
    },
  } as unknown as DrizzleClient);
  container.registerInstance(AuthMailService, {
    getPublicConfig: vi.fn().mockResolvedValue({
      configured: false,
      host: null,
      port: null,
      tlsMode: null,
      username: null,
      passwordLast4: null,
      senderName: null,
      senderEmail: null,
      verifiedAt: null,
    }),
  } as unknown as AuthMailService);
  container.registerInstance(OidcSettingsService, {
    getPublicConfig: vi.fn().mockResolvedValue({
      configured: false,
      issuer: null,
      clientId: null,
      clientSecretLast4: null,
      redirectUri: null,
      scopes: 'openid email profile',
    }),
    saveConfig: vi.fn(),
  } as unknown as OidcSettingsService);
  container.registerInstance(LoggingSettingsService, {
    getPublicConfig: vi.fn().mockResolvedValue({
      mode: 'disabled',
      url: '',
      username: '',
      passwordLast4: null,
      database: 'gateway_logs',
      table: 'logs',
      requestTimeoutMs: 5000,
    }),
  } as unknown as LoggingSettingsService);
  container.registerInstance(WebTransportSettingsService, {
    getConfig: vi.fn().mockResolvedValue({ tlsEnabled: false }),
    updateConfig: vi.fn(),
  } as unknown as WebTransportSettingsService);
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

describe('admin user identity validation', () => {
  it('rejects creating a user with a blank name', async () => {
    registerSession(['admin:users']);

    const response = await createApp().request('/api/admin/users', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({
        email: 'new@example.com',
        name: '   ',
        groupId: '11111111-1111-4111-8111-111111111112',
        authMethod: 'email_otp',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('admin user impersonation', () => {
  function registerImpersonationDependencies(target: User) {
    registerSession(['admin:users:impersonate', 'nodes:details']);
    const createImpersonationSession = vi.fn().mockResolvedValue({
      sessionId: 'impersonation-session',
      expiresAt: Date.now() + 60_000,
    });
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue({ ...SESSION, purpose: 'user' }),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      createImpersonationSession,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(target),
    } as unknown as AuthService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(true),
    } as unknown as AuditService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://gateway.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'direct',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    return createImpersonationSession;
  }

  it('creates a separate impersonation session and replaces only the browser cookie', async () => {
    const createImpersonationSession = registerImpersonationDependencies(TARGET_USER);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('impersonation-session');
    expect(createImpersonationSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER.id }),
      TARGET_USER,
      'session-1',
      expect.objectContaining({ userAgent: undefined })
    );
  });

  it('rejects blocked targets before creating an impersonation session', async () => {
    const createImpersonationSession = registerImpersonationDependencies({
      ...TARGET_USER,
      isBlocked: true,
    });

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(409);
    expect(createImpersonationSession).not.toHaveBeenCalled();
  });

  it('rejects deleted targets before creating an impersonation session', async () => {
    const createImpersonationSession = registerImpersonationDependencies({
      ...TARGET_USER,
      isBlocked: true,
      isDeleted: true,
    });

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'USER_DELETED' });
    expect(createImpersonationSession).not.toHaveBeenCalled();
  });
});

describe('admin Gateway settings route permissions', () => {
  it('allows reading Gateway settings with settings:gateway:view without admin:users', async () => {
    registerSession(['settings:gateway:view']);
    container.registerInstance(AuthSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: false,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: true,
        oauthExtendedCallbackCompatibility: false,
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: ['10.0.0.0/8', '172.16.0.0/12'],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);

    const response = await createApp().request('/api/admin/auth-settings', { headers: sessionHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      oidcAutoCreateUsers: false,
      oidcDefaultGroupId: null,
      oidcRequireVerifiedEmail: true,
      oauthExtendedCallbackCompatibility: false,
      smtp: {
        configured: false,
        host: null,
        port: null,
        tlsMode: null,
        username: null,
        passwordLast4: null,
        senderName: null,
        senderEmail: null,
        verifiedAt: null,
      },
      oidc: {
        configured: false,
        issuer: null,
        clientId: null,
        clientSecretLast4: null,
        redirectUri: null,
        scopes: 'openid email profile',
      },
      logging: {
        mode: 'disabled',
        url: '',
        username: '',
        passwordLast4: null,
        database: 'gateway_logs',
        table: 'logs',
        requestTimeoutMs: 5000,
      },
      mcpServerEnabled: true,
      mcpExtendedCompatibility: false,
      generalSettings: {
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      },
      webTransport: {
        tlsEnabled: false,
        restartRequired: false,
        directAccess: false,
        targetUrl: null,
      },
      networkSecurity: {
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      },
      outboundWebhookPolicy: {
        allowPrivateNetworks: true,
        allowedPrivateCidrs: ['10.0.0.0/8', '172.16.0.0/12'],
      },
      currentRequestIp: {
        source: 'unknown',
      },
      availableGroups: [],
    });
  });

  it('does not allow editing Gateway settings with only settings:gateway:view', async () => {
    registerSession(['settings:gateway:view']);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ mcpServerEnabled: false }),
    });

    expect(response.status).toBe(403);
  });

  it('returns a human-readable conflict when OIDC is enabled before it is configured', async () => {
    registerSession(['settings:gateway:edit']);
    const updateConfig = vi.fn();
    container.registerInstance(AuthSettingsService, { updateConfig } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {} as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {} as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {} as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {} as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {} as GroupService);
    container.registerInstance(AuditService, {} as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ methods: { oidc: true } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'OIDC_NOT_CONFIGURED',
      message: 'Configure OIDC before enabling OIDC sign-in',
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('returns a human-readable conflict when email sign-in is enabled before SMTP is verified', async () => {
    registerSession(['settings:gateway:edit']);
    const updateConfig = vi.fn();
    container.registerInstance(AuthSettingsService, { updateConfig } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {} as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {} as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {} as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {} as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {} as GroupService);
    container.registerInstance(AuditService, {} as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ methods: { password: true } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'SMTP_NOT_VERIFIED',
      message: 'Configure and verify SMTP before enabling password or email-code sign-in',
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('allows editing verified OIDC email requirement with settings:gateway:edit', async () => {
    registerSession(['settings:gateway:edit']);
    const updateConfig = vi.fn().mockResolvedValue({
      oidcAutoCreateUsers: true,
      oidcDefaultGroupId: 'group-1',
      oidcRequireVerifiedEmail: true,
    });
    container.registerInstance(AuthSettingsService, {
      updateConfig,
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
      getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: [],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ oidcRequireVerifiedEmail: true }),
    });

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ oidcRequireVerifiedEmail: true }));
  });

  it('never writes an SMTP password into the auth-settings audit event', async () => {
    registerSession(['settings:gateway:edit']);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({}),
    } as unknown as AuthSettingsService);
    container.registerInstance(AuthMailService, {
      saveConfig: vi.fn().mockResolvedValue(undefined),
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-03T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const password = 'smtp-password-that-must-not-be-audited';
    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          tlsMode: 'starttls',
          username: 'gateway',
          password,
          senderName: 'Gateway',
          senderEmail: 'security@example.com',
        },
      }),
    });

    expect(response.status).toBe(200);
    const entry = auditLog.mock.calls[0]?.[0];
    expect(entry).toMatchObject({ details: { smtp: { passwordChanged: true } } });
    expect(JSON.stringify(entry)).not.toContain(password);
  });

  it('allows editing general file upload limit with settings:gateway:edit', async () => {
    registerSession(['settings:gateway:edit']);
    const updateGeneralConfig = vi.fn().mockResolvedValue({
      fileUploadMaxBytes: 50 * 1024 * 1024,
      fileOpenMaxBytes: 10 * 1024 * 1024,
      features: { pkiEnabled: true, domainsEnabled: true, inferenceEnabled: true },
    });
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: false,
        oauthExtendedCallbackCompatibility: false,
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      updateConfig: updateGeneralConfig,
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: [],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        generalSettings: {
          fileUploadMaxBytes: 50 * 1024 * 1024,
          features: { inferenceEnabled: true },
        },
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(updateGeneralConfig).toHaveBeenCalledWith({
      fileUploadMaxBytes: 50 * 1024 * 1024,
      features: { inferenceEnabled: true },
    });
    expect(body.generalSettings.fileUploadMaxBytes).toBe(50 * 1024 * 1024);
    expect(body.generalSettings.fileOpenMaxBytes).toBe(10 * 1024 * 1024);
    expect(body.generalSettings.features).toEqual({
      pkiEnabled: true,
      domainsEnabled: true,
      inferenceEnabled: true,
    });
  });

  it('allows editing OAuth extended callback compatibility with settings:gateway:edit', async () => {
    registerSession(['settings:gateway:view', 'settings:gateway:edit']);
    const updateConfig = vi.fn().mockResolvedValue({
      oidcAutoCreateUsers: true,
      oidcDefaultGroupId: null,
      oidcRequireVerifiedEmail: true,
      oauthExtendedCallbackCompatibility: true,
    });
    container.registerInstance(AuthSettingsService, {
      updateConfig,
    } as unknown as AuthSettingsService);
    const updateMcpConfig = vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: true });
    container.registerInstance(McpSettingsService, {
      updateConfig: updateMcpConfig,
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: [],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        oauthExtendedCallbackCompatibility: true,
        mcpExtendedCompatibility: true,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ oauthExtendedCallbackCompatibility: true }));
    expect(updateMcpConfig).toHaveBeenCalledWith({
      serverEnabled: undefined,
      extendedCompatibility: true,
    });
    expect(body.oauthExtendedCallbackCompatibility).toBe(true);
    expect(body.mcpExtendedCompatibility).toBe(true);
    expect(body.oidcRequireVerifiedEmail).toBe(true);
  });

  it('sends the selected SMTP test email template', async () => {
    registerSession(['settings:gateway:edit']);
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    const sendTestEmail = vi.fn().mockResolvedValue(undefined);
    const smtp = {
      configured: true,
      host: 'smtp.resend.com',
      port: 587,
      tlsMode: 'starttls' as const,
      username: 'resend',
      passwordLast4: '1234',
      senderName: 'Gateway',
      senderEmail: 'security@example.com',
      verifiedAt: '2026-08-02T00:00:00.000Z',
    };
    container.registerInstance(AuthMailService, {
      saveConfig,
      sendTestEmail,
      getPublicConfig: vi.fn().mockResolvedValue(smtp),
    } as unknown as AuthMailService);
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: true,
        oauthExtendedCallbackCompatibility: false,
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({ allowPrivateNetworks: false, allowedPrivateCidrs: [] }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, { listGroups: vi.fn().mockResolvedValue([]) } as unknown as GroupService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        smtp: {
          host: smtp.host,
          port: smtp.port,
          tlsMode: smtp.tlsMode,
          username: smtp.username,
          password: 'test-api-key',
          senderName: smtp.senderName,
          senderEmail: smtp.senderEmail,
          testRecipient: 'recipient@example.com',
          testEmailKind: 'email_otp',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(sendTestEmail).toHaveBeenCalledWith('recipient@example.com', 'email_otp');
  });
});

describe('admin user browser sessions', () => {
  it('lists only public session identifiers for a manageable user', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const listPublicUserSessions = vi.fn().mockResolvedValue([
      {
        id: 'public-session-id',
        authMethod: 'oidc',
        createdAt: 1,
        lastSeenAt: 2,
        expiresAt: 3,
        ipAddress: '203.0.113.1',
        userAgent: 'Browser',
        mfaSatisfiedAt: null,
        isCurrent: false,
      },
    ]);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      listPublicUserSessions,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions`, {
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ id: 'public-session-id', authMethod: 'oidc' })]);
    expect(listPublicUserSessions).toHaveBeenCalledWith(TARGET_USER.id, 'session-1');
  });

  it('revokes one public session and writes an audit record', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const revokeUserSessionByPublicId = vi.fn().mockResolvedValue(true);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      revokeUserSessionByPublicId,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions/public-session-id`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(revokeUserSessionByPublicId).toHaveBeenCalledWith(TARGET_USER.id, 'public-session-id');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.session_revoke',
        resourceType: 'session',
        resourceId: 'public-session-id',
        details: expect.objectContaining({ targetUserId: TARGET_USER.id }),
      })
    );
  });

  it('revokes all sessions and writes an audit record', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const destroyAllUserSessions = vi.fn().mockResolvedValue(undefined);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      destroyAllUserSessions,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(destroyAllUserSessions).toHaveBeenCalledWith(TARGET_USER.id);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.sessions_revoke_all',
        resourceType: 'user',
        resourceId: TARGET_USER.id,
        details: expect.objectContaining({ targetUserId: TARGET_USER.id }),
      })
    );
  });

  it('does not expose sessions or revoke them across the privilege boundary', async () => {
    registerSession(['admin:users']);
    const listPublicUserSessions = vi.fn();
    const revokeUserSessionByPublicId = vi.fn();
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      listPublicUserSessions,
      revokeUserSessionByPublicId,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);

    const [listResponse, revokeResponse] = await Promise.all([
      createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions`, { headers: sessionHeaders() }),
      createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions/public-session-id`, {
        method: 'DELETE',
        headers: sessionHeaders(),
      }),
    ]);

    expect(listResponse.status).toBe(403);
    expect(revokeResponse.status).toBe(403);
    expect(listPublicUserSessions).not.toHaveBeenCalled();
    expect(revokeUserSessionByPublicId).not.toHaveBeenCalled();
  });
});

describe('admin password link delivery', () => {
  it('sends a setup link before the first completed sign-in and records the action', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const requestPasswordLink = vi.fn().mockResolvedValue(undefined);
    const hasCompletedSignIn = vi.fn().mockResolvedValue(false);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue({ ...TARGET_USER, authMethod: 'password' }),
      hasCompletedSignIn,
    } as unknown as AuthService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-01T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(LocalAuthService, { requestPasswordLink } as unknown as LocalAuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/password-setup`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(requestPasswordLink).toHaveBeenCalledWith(TARGET_USER.email, 'password_setup');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password_link_sent',
        resourceId: TARGET_USER.id,
        details: expect.objectContaining({ purpose: 'password_setup' }),
      })
    );
  });

  it('sends a reset link after a completed sign-in', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const requestPasswordLink = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue({ ...TARGET_USER, authMethod: 'password' }),
      hasCompletedSignIn: vi.fn().mockResolvedValue(true),
    } as unknown as AuthService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-01T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(LocalAuthService, { requestPasswordLink } as unknown as LocalAuthService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/password-setup`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(requestPasswordLink).toHaveBeenCalledWith(TARGET_USER.email, 'password_reset');
    await expect(response.json()).resolves.toMatchObject({ purpose: 'password_reset' });
  });
});

describe('admin user additional permissions', () => {
  it('updates exact additional scopes and records the effective permission change', async () => {
    registerSession(['admin:users', 'nodes:details:node-1', 'nodes:console:node-1']);
    const targetUser: User = {
      ...USER,
      id: '22222222-2222-4222-8222-222222222222',
      oidcSubject: 'target-user',
      email: 'target@example.com',
      groupName: 'viewer',
      groupScopes: ['nodes:details:node-1'],
      additionalScopes: [],
      scopes: ['nodes:details:node-1'],
    };
    const updatedUser: User = {
      ...targetUser,
      additionalScopes: ['nodes:console:node-1'],
      scopes: ['nodes:console:node-1', 'nodes:details:node-1'],
    };
    const assertCanUpdateUserAdditionalScopes = vi.fn().mockResolvedValue({
      targetUser,
      additionalScopes: ['nodes:console:node-1'],
    });
    const updateUserAdditionalScopes = vi.fn().mockResolvedValue(updatedUser);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      assertCanUpdateUserAdditionalScopes,
      updateUserAdditionalScopes,
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(
      '/api/admin/users/22222222-2222-4222-8222-222222222222/additional-permissions',
      {
        method: 'PUT',
        headers: sessionHeaders(),
        body: JSON.stringify({ additionalScopes: ['nodes:console:node-1'] }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: targetUser.id,
      additionalScopes: ['nodes:console:node-1'],
    });
    expect(assertCanUpdateUserAdditionalScopes).toHaveBeenCalledWith(
      USER.id,
      ['admin:users', 'nodes:console:node-1', 'nodes:details:node-1'],
      targetUser.id,
      ['nodes:console:node-1']
    );
    expect(updateUserAdditionalScopes).toHaveBeenCalledWith(targetUser.id, ['nodes:console:node-1']);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.additional_permissions_change',
        resourceType: 'user',
        resourceId: targetUser.id,
        details: expect.objectContaining({
          addedScopes: ['nodes:console:node-1'],
          removedScopes: [],
        }),
      })
    );
  });
});

describe('deleted user administration', () => {
  it('does not expose deleted users to a regular user administrator', async () => {
    registerSession(['admin:users']);

    const response = await createApp().request('/api/admin/users/deleted', { headers: sessionHeaders() });

    expect(response.status).toBe(403);
  });

  it('allows only a system administrator to list and restore deleted users', async () => {
    registerSession(['admin:system']);
    const deletedUser = {
      id: '22222222-2222-4222-8222-222222222222',
      email: 'deleted@example.com',
      name: 'Deleted User',
      avatarUrl: null,
      deletedAt: '2026-08-01T10:00:00.000Z',
      deletedByUserId: USER.id,
      deletedFromGroupId: '33333333-3333-4333-8333-333333333333',
      originalGroupExists: false,
    };
    const restoredUser: User = {
      ...USER,
      id: deletedUser.id,
      email: deletedUser.email,
      name: deletedUser.name,
      groupId: '44444444-4444-4444-8444-444444444444',
      groupName: 'viewer',
      isBlocked: true,
    };
    const listDeletedUsers = vi.fn().mockResolvedValue([deletedUser]);
    const restoreUser = vi.fn().mockResolvedValue(restoredUser);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, { listDeletedUsers, restoreUser } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const listResponse = await createApp().request('/api/admin/users/deleted', { headers: sessionHeaders() });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([deletedUser]);

    const restoreResponse = await createApp().request(`/api/admin/users/${deletedUser.id}/restore`, {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({ groupId: restoredUser.groupId }),
    });
    expect(restoreResponse.status).toBe(200);
    expect(restoreUser).toHaveBeenCalledWith(deletedUser.id, restoredUser.groupId);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.restore', details: expect.objectContaining({ remainsBlocked: true }) })
    );
  });
});
