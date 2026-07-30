import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { adminRoutes } from './admin.routes.js';

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
      mcpServerEnabled: true,
      mcpExtendedCompatibility: false,
      generalSettings: {
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
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
