import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  env: {
    SETUP_TOKEN: 'setup-secret',
    ACME_STAGING: false,
  },
  policy: {
    isSetupApiEnabled: vi.fn(),
    markSetupComplete: vi.fn(),
  },
  setupService: {
    bootstrapManagementSSL: vi.fn(),
    bootstrapManagementSSLUpload: vi.fn(),
  },
  nodesService: {
    create: vi.fn(),
  },
  authSettings: { updateConfig: vi.fn() },
  authMail: { saveConfig: vi.fn(), sendTestEmail: vi.fn() },
  authService: { createUser: vi.fn() },
  localAuth: { setInitialPassword: vi.fn() },
  groupService: { getGroupByName: vi.fn() },
  auditService: { log: vi.fn() },
}));

vi.mock('@/config/env.js', () => ({
  getEnv: () => mocks.env,
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token: unknown) => {
      const name = typeof token === 'function' ? token.name : String(token);
      if (name === 'SetupTokenPolicyService') return mocks.policy;
      if (name === 'SetupService') return mocks.setupService;
      if (name === 'NodesService') return mocks.nodesService;
      if (name === 'AuthSettingsService') return mocks.authSettings;
      if (name === 'AuthMailService') return mocks.authMail;
      if (name === 'AuthService') return mocks.authService;
      if (name === 'LocalAuthService') return mocks.localAuth;
      if (name === 'GroupService') return mocks.groupService;
      if (name === 'AuditService') return mocks.auditService;
      throw new Error(`Unexpected resolve: ${name}`);
    }),
  },
}));

vi.mock('./setup.service.js', () => ({
  SetupService: class SetupService {},
}));

vi.mock('./setup-token-policy.js', () => ({
  SetupTokenPolicyService: class SetupTokenPolicyService {},
}));

vi.mock('@/modules/nodes/nodes.service.js', () => ({
  NodesService: class NodesService {},
}));
vi.mock('@/modules/auth/auth.settings.service.js', () => ({ AuthSettingsService: class AuthSettingsService {} }));
vi.mock('@/modules/auth/auth-mail.service.js', () => ({ AuthMailService: class AuthMailService {} }));
vi.mock('@/modules/auth/auth.service.js', () => ({ AuthService: class AuthService {} }));
vi.mock('@/modules/auth/local-auth.service.js', () => ({ LocalAuthService: class LocalAuthService {} }));
vi.mock('@/modules/groups/group.service.js', () => ({ GroupService: class GroupService {} }));
vi.mock('@/modules/audit/audit.service.js', () => ({ AuditService: class AuditService {} }));

import { setupRoutes } from './setup.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/setup', setupRoutes);
  return app;
}

function authHeaders(token = 'setup-secret') {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

describe('setup routes bootstrap-only policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.SETUP_TOKEN = 'setup-secret';
    mocks.env.ACME_STAGING = false;
    mocks.policy.isSetupApiEnabled.mockResolvedValue(true);
    mocks.policy.markSetupComplete.mockResolvedValue(undefined);
    mocks.setupService.bootstrapManagementSSL.mockResolvedValue({ status: 'configured' });
    mocks.setupService.bootstrapManagementSSLUpload.mockResolvedValue({ status: 'configured' });
    mocks.nodesService.create.mockResolvedValue({
      node: { id: 'node-1', type: 'nginx', hostname: 'node.local', status: 'pending' },
      enrollmentToken: 'gw_node_token',
      gatewayCertSha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    mocks.authSettings.updateConfig.mockResolvedValue(undefined);
    mocks.authMail.saveConfig.mockResolvedValue(undefined);
    mocks.authMail.sendTestEmail.mockResolvedValue(undefined);
    mocks.authService.createUser.mockResolvedValue({ id: 'user-1' });
    mocks.localAuth.setInitialPassword.mockResolvedValue(undefined);
    mocks.groupService.getGroupByName.mockResolvedValue({ id: 'system-admin-group', name: 'system-admin' });
    mocks.auditService.log.mockResolvedValue(undefined);
  });

  it('returns 404 after Gateway is configured before validating token', async () => {
    mocks.policy.isSetupApiEnabled.mockResolvedValue(false);

    const response = await createApp().request('/api/setup/enroll-node', {
      method: 'POST',
      headers: authHeaders('wrong-token'),
      body: JSON.stringify({ type: 'nginx', hostname: 'node.local' }),
    });

    expect(response.status).toBe(404);
    expect(mocks.nodesService.create).not.toHaveBeenCalled();
  });

  it('returns 404 after Gateway is configured before request validation', async () => {
    mocks.policy.isSetupApiEnabled.mockResolvedValue(false);

    const response = await createApp().request('/api/setup/management-ssl-upload', {
      method: 'POST',
      headers: authHeaders('wrong-token'),
      body: JSON.stringify({ malformed: true }),
    });

    expect(response.status).toBe(404);
    expect(mocks.setupService.bootstrapManagementSSLUpload).not.toHaveBeenCalled();
  });

  it('returns 404 for management SSL setup after Gateway is configured', async () => {
    mocks.policy.isSetupApiEnabled.mockResolvedValue(false);

    const response = await createApp().request('/api/setup/management-ssl', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ domain: 'gateway.example.com' }),
    });

    expect(response.status).toBe(404);
    expect(mocks.setupService.bootstrapManagementSSL).not.toHaveBeenCalled();
  });

  it('configures selected authentication and creates one explicit system administrator', async () => {
    const response = await createApp().request('/api/setup/auth-bootstrap', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        methods: { oidc: true, password: true, emailOtp: false },
        oidc: {
          issuer: 'https://id.example.com',
          clientId: 'gateway',
          clientSecret: 'secret',
          redirectUri: 'https://gateway.example.com/auth/callback',
        },
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          tlsMode: 'starttls',
          username: 'gateway',
          password: 'smtp-secret',
          senderName: 'Gateway',
          senderEmail: 'gateway@example.com',
          testRecipient: 'admin@example.com',
        },
        initialAdmin: {
          email: 'admin@example.com',
          name: 'Gateway Admin',
          authMethod: 'password',
          password: 'long-enough-password',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.authSettings.updateConfig).toHaveBeenNthCalledWith(1, {
      oidc: expect.objectContaining({ issuer: 'https://id.example.com', clientSecret: 'secret' }),
    });
    expect(mocks.authMail.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.com' }));
    expect(mocks.authMail.sendTestEmail).toHaveBeenCalledWith('admin@example.com', 'smtp_configuration');
    expect(mocks.authSettings.updateConfig).toHaveBeenNthCalledWith(2, {
      methods: { oidc: true, password: true, emailOtp: false },
    });
    expect(mocks.authService.createUser).toHaveBeenCalledWith({
      email: 'admin@example.com',
      name: 'Gateway Admin',
      groupId: 'system-admin-group',
      authMethod: 'password',
    });
    expect(mocks.localAuth.setInitialPassword).toHaveBeenCalledWith('user-1', 'long-enough-password');
    expect(mocks.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'setup.auth_bootstrap',
        details: expect.not.objectContaining({ password: expect.anything(), clientSecret: expect.anything() }),
      })
    );
  });

  it('returns 404 for uploaded management SSL setup after Gateway is configured', async () => {
    mocks.policy.isSetupApiEnabled.mockResolvedValue(false);

    const response = await createApp().request('/api/setup/management-ssl-upload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        domain: 'gateway.example.com',
        certificatePem: '-----BEGIN CERTIFICATE-----',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----',
      }),
    });

    expect(response.status).toBe(404);
    expect(mocks.setupService.bootstrapManagementSSLUpload).not.toHaveBeenCalled();
  });

  it('accepts a valid setup token before Gateway is configured', async () => {
    const response = await createApp().request('/api/setup/enroll-node', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type: 'nginx', hostname: 'node.local' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.nodesService.create).toHaveBeenCalledWith(
      { type: 'nginx', hostname: 'node.local' },
      '00000000-0000-0000-0000-000000000000'
    );
  });

  it('rejects invalid setup token before Gateway is configured', async () => {
    const response = await createApp().request('/api/setup/enroll-node', {
      method: 'POST',
      headers: authHeaders('wrong-token'),
      body: JSON.stringify({ type: 'nginx', hostname: 'node.local' }),
    });

    expect(response.status).toBe(401);
    expect(mocks.nodesService.create).not.toHaveBeenCalled();
  });

  it('rejects missing SETUP_TOKEN before Gateway is configured', async () => {
    mocks.env.SETUP_TOKEN = undefined as any;

    const response = await createApp().request('/api/setup/enroll-node', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type: 'nginx', hostname: 'node.local' }),
    });

    expect(response.status).toBe(401);
    expect(mocks.nodesService.create).not.toHaveBeenCalled();
  });

  it('marks setup complete with a valid setup token', async () => {
    const response = await createApp().request('/api/setup/complete', {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: 'completed' } });
    expect(mocks.policy.markSetupComplete).toHaveBeenCalledOnce();
  });

  it('rejects setup completion with an invalid setup token', async () => {
    const response = await createApp().request('/api/setup/complete', {
      method: 'POST',
      headers: authHeaders('wrong-token'),
    });

    expect(response.status).toBe(401);
    expect(mocks.policy.markSetupComplete).not.toHaveBeenCalled();
  });

  it('returns 404 for setup completion after setup is locked', async () => {
    mocks.policy.isSetupApiEnabled.mockResolvedValue(false);

    const response = await createApp().request('/api/setup/complete', {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(response.status).toBe(404);
    expect(mocks.policy.markSetupComplete).not.toHaveBeenCalled();
  });
});
