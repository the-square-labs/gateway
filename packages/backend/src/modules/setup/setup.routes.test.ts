import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { SetupAlreadyInProgressError } from './setup-access.service.js';

const mocks = vi.hoisted(() => ({
  policy: {
    isSetupApiEnabled: vi.fn(),
    isSetupComplete: vi.fn(),
  },
  access: {
    getCodeMetadata: vi.fn(),
    getProgress: vi.fn(),
    createSession: vi.fn(),
    validateSession: vi.fn(),
    getCsrfToken: vi.fn(),
    validateCsrfToken: vi.fn(),
    getSessionExpiresAt: vi.fn(),
    withApplyLock: vi.fn(async (_sessionId: string, task: () => Promise<unknown>) => task()),
  },
  auth: { getUserById: vi.fn() },
  sessions: { destroySetupSessions: vi.fn(), createSession: vi.fn() },
  general: { getPublicUrl: vi.fn() },
  transport: { getConfig: vi.fn(), updateConfig: vi.fn() },
  restart: { request: vi.fn() },
  wizard: { apply: vi.fn(), completeAIWorkspace: vi.fn(), getPhase: vi.fn() },
  license: {
    getOnboardingState: vi.fn(),
    continueWithCommunity: vi.fn(),
    activateKey: vi.fn(),
  },
  logging: {},
}));

vi.mock('@/container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/container.js')>();
  return {
    ...actual,
    container: {
      resolve: vi.fn((token: unknown) => {
        const name = typeof token === 'function' ? token.name : String(token);
        if (name === 'SetupTokenPolicyService') return mocks.policy;
        if (name === 'SetupAccessService') return mocks.access;
        if (name === 'GeneralSettingsService') return mocks.general;
        if (name === 'WebTransportSettingsService') return mocks.transport;
        if (name === 'SetupWizardService') return mocks.wizard;
        if (name === 'AuthService') return mocks.auth;
        if (name === 'SessionService') return mocks.sessions;
        if (name === 'LoggingRuntimeService') return mocks.logging;
        if (name === 'RuntimeRestartService') return mocks.restart;
        if (name === 'LicenseService') return mocks.license;
        throw new Error(`Unexpected resolve: ${name}`);
      }),
    },
  };
});

vi.mock('@/modules/auth/session-cookie.js', () => ({
  getSessionCookieName: () => 'gw_session',
  getAcceptedSessionCookieNames: () => ['gw_session'],
}));

vi.mock('@/lib/request-ip.js', () => ({
  getClientIpForContext: vi.fn().mockResolvedValue('203.0.113.25'),
}));

import { setupRoutes } from './setup.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/setup', setupRoutes);
  return app;
}

describe('setup wizard routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.policy.isSetupApiEnabled.mockResolvedValue(true);
    mocks.policy.isSetupComplete.mockResolvedValue(false);
    mocks.access.getCodeMetadata.mockResolvedValue({
      id: 'code-id',
      expiresAt: '2030-01-01T00:00:00.000Z',
      available: true,
    });
    mocks.access.getProgress.mockResolvedValue({ inProgress: false, currentSession: false });
    mocks.general.getPublicUrl.mockResolvedValue(null);
    mocks.transport.getConfig.mockResolvedValue({ tlsEnabled: true });
    mocks.transport.updateConfig.mockImplementation(async ({ tlsEnabled }) => ({ tlsEnabled }));
    mocks.access.createSession.mockResolvedValue({
      sessionId: 'setup-session',
      codeId: 'code-id',
      csrfToken: 'setup-csrf',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    mocks.access.validateSession.mockResolvedValue(false);
    mocks.access.getCsrfToken.mockResolvedValue('setup-csrf');
    mocks.access.validateCsrfToken.mockResolvedValue(false);
    mocks.access.getSessionExpiresAt.mockResolvedValue(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    mocks.auth.getUserById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' });
    mocks.sessions.createSession.mockResolvedValue({
      sessionId: 'purpose-session',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    mocks.wizard.getPhase.mockResolvedValue('ai_workspace');
    mocks.wizard.apply.mockResolvedValue({ status: 'ready_for_ai' });
    mocks.wizard.completeAIWorkspace.mockResolvedValue(undefined);
    mocks.license.getOnboardingState.mockResolvedValue({
      completed: false,
      status: { status: 'community', plan: 'community', registrationStatus: 'pending' },
    });
    mocks.license.continueWithCommunity.mockResolvedValue({
      status: 'community',
      plan: 'community',
      registrationStatus: 'registered',
    });
    mocks.license.activateKey.mockResolvedValue({
      status: 'valid',
      plan: 'personal',
      registrationStatus: 'registered',
    });
  });

  it('exposes setup status without a setup session', async () => {
    const response = await createApp().request('/api/setup/status');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        state: 'pending',
        code: {
          id: 'code-id',
          expiresAt: '2030-01-01T00:00:00.000Z',
          available: true,
        },
        publicUrl: null,
        tlsEnabled: true,
        setupInProgress: false,
        currentSession: false,
      },
    });
  });

  it('exchanges a valid setup code for an http-only setup cookie', async () => {
    const response = await createApp().request('/api/setup/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'gws_valid' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.access.createSession).toHaveBeenCalledWith('gws_valid');
    expect(response.headers.get('set-cookie')).toContain('setup_session=setup-session');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await response.json()).toMatchObject({ data: { csrfToken: 'setup-csrf' } });
  });

  it('rejects another setup unlock while a setup session is active', async () => {
    mocks.access.createSession.mockRejectedValue(new SetupAlreadyInProgressError());

    const response = await createApp().request('/api/setup/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'gws_valid' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'SETUP_IN_PROGRESS',
      message: 'Gateway setup is already in progress',
    });
  });

  it('requires a setup session for wizard configuration', async () => {
    const response = await createApp().request('/api/setup/wizard/config');
    expect(response.status).toBe(401);
  });

  it('does not expose removed installer endpoints', async () => {
    for (const path of ['/api/setup/management-ssl', '/api/setup/management-ssl-upload', '/api/setup/enroll-node']) {
      const response = await createApp().request(path, { method: 'POST' });
      expect(response.status).toBe(404);
    }
  });

  it('applies the core setup through the single configuration endpoint', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);
    const payload = {
      publicUrl: 'https://gateway.example.com',
      network: {
        grpcPublicTarget: 'gateway.example.com:9443',
        grpcLocalIp: '192.168.1.10',
      },
      auth: { methods: { oidc: true, password: false, emailOtp: false } },
      administrator: {
        name: 'Admin',
        email: 'admin@example.com',
        authMethod: 'oidc',
      },
      logging: { mode: 'disabled' },
    };

    const response = await createApp().request('/api/setup/wizard/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'setup_session=valid',
        'X-CSRF-Token': 'setup-csrf',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mocks.wizard.apply).toHaveBeenCalledWith(payload, mocks.logging);
    for (const [path, method] of [
      ['/api/setup/wizard/public-url', 'PUT'],
      ['/api/setup/wizard/auth', 'PUT'],
      ['/api/setup/wizard/admin', 'POST'],
      ['/api/setup/wizard/logging', 'PUT'],
      ['/api/setup/wizard/transport', 'PUT'],
    ]) {
      expect(await createApp().request(path, { method })).toHaveProperty('status', 404);
    }
  });

  it('returns an actionable error when Docker is unavailable during setup apply', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);
    mocks.wizard.apply.mockRejectedValue(
      Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' })
    );

    const response = await createApp().request('/api/setup/wizard/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'setup_session=valid',
        'X-CSRF-Token': 'setup-csrf',
      },
      body: JSON.stringify({
        publicUrl: 'https://gateway.example.com',
        network: {
          grpcPublicTarget: 'gateway.example.com:9443',
          grpcLocalIp: '',
        },
        auth: { methods: { oidc: true, password: false, emailOtp: false } },
        administrator: {
          name: 'Admin',
          email: 'admin@example.com',
          authMethod: 'oidc',
        },
        logging: { mode: 'disabled' },
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'SETUP_DOCKER_UNAVAILABLE',
      message: 'Gateway cannot access Docker. Verify that /var/run/docker.sock is mounted and accessible, then retry.',
    });
  });

  it('exchanges the setup session for a bounded system-user session during AI configuration', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/session', {
      method: 'POST',
      headers: { Cookie: 'setup_session=valid', 'X-CSRF-Token': 'setup-csrf' },
    });

    expect(response.status).toBe(200);
    expect(mocks.sessions.destroySetupSessions).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000000', 'valid');
    expect(mocks.sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: '00000000-0000-0000-0000-000000000000' }),
      undefined,
      undefined,
      expect.objectContaining({
        purpose: 'setup',
        setupSessionId: 'valid',
        ipAddress: '203.0.113.25',
      })
    );
    expect(response.headers.get('set-cookie')).toContain('purpose-session');
  });

  it('records the AI Workspace outcome and closes setup', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'setup_session=valid',
        'X-CSRF-Token': 'setup-csrf',
      },
      body: JSON.stringify({ status: 'configured', configuredVia: 'gateway_inference' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.wizard.completeAIWorkspace).toHaveBeenCalledWith({
      status: 'configured',
      configuredVia: 'gateway_inference',
    });
    expect(mocks.sessions.destroySetupSessions).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000000', 'valid');
  });

  it('allows an explicit Community choice only after core setup is applied', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/license/community', {
      method: 'POST',
      headers: { Cookie: 'setup_session=valid', 'X-CSRF-Token': 'setup-csrf' },
    });

    expect(response.status).toBe(200);
    expect(mocks.license.continueWithCommunity).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      data: { plan: 'community', registrationStatus: 'registered' },
    });
  });

  it('activates a paid key through the setup session without exposing installation credentials', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/license/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'setup_session=valid',
        'X-CSRF-Token': 'setup-csrf',
      },
      body: JSON.stringify({ licenseKey: 'WLT-GW-PAID' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.license.activateKey).toHaveBeenCalledWith('WLT-GW-PAID');
    expect(JSON.stringify(await response.json())).not.toContain('installationToken');
  });

  it('rejects license choices before core setup is applied', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);
    mocks.wizard.getPhase.mockResolvedValue('configuration');

    const response = await createApp().request('/api/setup/wizard/license/community', {
      method: 'POST',
      headers: { Cookie: 'setup_session=valid', 'X-CSRF-Token': 'setup-csrf' },
    });

    expect(response.status).toBe(409);
    expect(mocks.license.continueWithCommunity).not.toHaveBeenCalled();
  });

  it('keeps setup license mutations behind CSRF validation', async () => {
    mocks.access.validateSession.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/license/community', {
      method: 'POST',
      headers: { Cookie: 'setup_session=valid' },
    });

    expect(response.status).toBe(403);
    expect(mocks.license.continueWithCommunity).not.toHaveBeenCalled();
  });

  it('rejects invalid network settings before invoking the final apply operation', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'setup_session=valid',
        'X-CSRF-Token': 'setup-csrf',
      },
      body: JSON.stringify({
        publicUrl: 'https://gateway.example.com',
        network: {
          grpcPublicTarget: 'https://gateway.example.com/path',
          grpcLocalIp: 'gateway.local',
        },
        auth: { methods: { oidc: true, password: false, emailOtp: false } },
        administrator: {
          name: 'Admin',
          email: 'admin@example.com',
          authMethod: 'oidc',
        },
        logging: { mode: 'disabled' },
      }),
    });

    expect(response.status).toBe(400);
    expect(mocks.wizard.apply).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin form-style apply without the setup CSRF token', async () => {
    mocks.access.validateSession.mockResolvedValue(true);

    const response = await createApp().request('/api/setup/wizard/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Cookie: 'setup_session=valid',
        Origin: 'https://attacker.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'SETUP_CSRF_INVALID' });
    expect(mocks.wizard.apply).not.toHaveBeenCalled();
  });

  it('locks every setup mutation after completion while status remains visible', async () => {
    mocks.policy.isSetupApiEnabled.mockResolvedValue(false);

    const unlock = await createApp().request('/api/setup/unlock', { method: 'POST' });
    const status = await createApp().request('/api/setup/status');

    expect(unlock.status).toBe(404);
    expect(status.status).toBe(200);
  });
});
