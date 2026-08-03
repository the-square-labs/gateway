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
    withApplyLock: vi.fn(async (_sessionId: string, task: () => Promise<unknown>) => task()),
  },
  general: { getPublicUrl: vi.fn() },
  transport: { getConfig: vi.fn(), updateConfig: vi.fn() },
  restart: { request: vi.fn() },
  wizard: { apply: vi.fn() },
  logging: {},
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token: unknown) => {
      const name = typeof token === 'function' ? token.name : String(token);
      if (name === 'SetupTokenPolicyService') return mocks.policy;
      if (name === 'SetupAccessService') return mocks.access;
      if (name === 'GeneralSettingsService') return mocks.general;
      if (name === 'WebTransportSettingsService') return mocks.transport;
      if (name === 'SetupWizardService') return mocks.wizard;
      if (name === 'LoggingRuntimeService') return mocks.logging;
      if (name === 'RuntimeRestartService') return mocks.restart;
      throw new Error(`Unexpected resolve: ${name}`);
    }),
  },
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
    mocks.wizard.apply.mockResolvedValue({ status: 'completed' });
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

  it('exposes only one final mutation endpoint for wizard configuration', async () => {
    mocks.access.validateSession.mockResolvedValue(true);
    mocks.access.validateCsrfToken.mockResolvedValue(true);
    const payload = {
      publicUrl: 'https://gateway.example.com',
      network: {
        publicIps: ['203.0.113.10'],
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
      ['/api/setup/wizard/complete', 'POST'],
    ]) {
      expect(await createApp().request(path, { method })).toHaveProperty('status', 404);
    }
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
          publicIps: [],
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
