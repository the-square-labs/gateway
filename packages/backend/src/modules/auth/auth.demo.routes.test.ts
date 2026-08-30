import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { DemoAuthService } from '@/modules/demo/demo-auth.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, User } from '@/types.js';
import { AuthService } from './auth.service.js';
import { LocalAuthService } from './local-auth.service.js';
import { MfaService } from './mfa.service.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

vi.mock('@/modules/demo/demo-mode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/demo/demo-mode.js')>();
  return { ...actual, isDemoMode: () => true };
});

import { authRoutes } from './auth.routes.js';

const DEMO_USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: null,
  authMethod: 'demo_email_otp',
  email: 'visitor@example.test',
  name: 'visitor@example.test',
  avatarUrl: null,
  groupId: 'demo-admin-id',
  groupName: 'demo-admin',
  scopes: ['docker:containers:view'],
  isBlocked: false,
};

const SYSTEM_ADMIN: User = {
  ...DEMO_USER,
  id: '22222222-2222-4222-8222-222222222222',
  authMethod: 'email_otp',
  email: 'owner@example.test',
  groupId: 'system-admin-id',
  groupName: 'system-admin',
  scopes: ['admin:system'],
};

function makeApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/auth', authRoutes);
  return app;
}

afterEach(() => {
  container.reset();
});

describe('demo-only authentication routes', () => {
  it('requests and verifies a dedicated demo OTP session', async () => {
    const requestCode = vi.fn().mockResolvedValue('demo-challenge');
    const verifyCode = vi.fn().mockResolvedValue(DEMO_USER);
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'demo-session' });
    const recordSuccessfulSignIn = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(DemoAuthService, { requestCode, verifyCode } as never);
    container.registerInstance(SessionService, { createSession } as never);
    container.registerInstance(AuthService, { recordSuccessfulSignIn } as never);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://gateway.example.test'),
    } as never);
    const app = makeApp();

    const requestResponse = await app.request('/auth/demo/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Visitor@Example.Test' }),
    });
    expect(requestResponse.status).toBe(200);
    expect(await requestResponse.json()).toEqual({ ok: true, challengeId: 'demo-challenge' });
    expect(requestCode).toHaveBeenCalledWith('Visitor@Example.Test');

    const verifyResponse = await app.request('/auth/demo/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'demo-browser' },
      body: JSON.stringify({ challengeId: 'demo-challenge', code: '123456' }),
    });
    expect(verifyResponse.status).toBe(200);
    expect(verifyCode).toHaveBeenCalledWith('demo-challenge', '123456');
    expect(createSession).toHaveBeenCalledWith(
      DEMO_USER,
      undefined,
      undefined,
      expect.objectContaining({ authMethod: 'demo_email_otp', mfaSatisfiedAt: expect.any(Number) })
    );
    expect(recordSuccessfulSignIn).toHaveBeenCalledWith(DEMO_USER.id);
    expect(verifyResponse.headers.get('set-cookie')).toContain('demo-session');
  });

  it('keeps ordinary email OTP unreachable before parsing or service work', async () => {
    const requestCode = vi.fn();
    container.registerInstance(LocalAuthService, { requestEmailOtp: requestCode } as never);
    const response = await makeApp().request('/auth/email-otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(response.status).toBe(404);
    expect(requestCode).not.toHaveBeenCalled();
  });

  it('preserves canonical system-admin MFA after the dedicated demo mailbox proof', async () => {
    const verifyCode = vi.fn().mockResolvedValue(SYSTEM_ADMIN);
    const beginLoginChallenge = vi.fn().mockResolvedValue('mfa-challenge');
    const createSession = vi.fn();
    container.registerInstance(DemoAuthService, { verifyCode } as never);
    container.registerInstance(MfaService, {
      getStatus: vi.fn().mockResolvedValue({ totpConfigured: true, passkeyCount: 1 }),
      isGatewayMfaRequired: vi.fn().mockResolvedValue(true),
      beginLoginChallenge,
    } as never);
    container.registerInstance(SessionService, { createSession } as never);

    const response = await makeApp().request('/auth/demo/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'demo-challenge', code: '123456' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mfaRequired: true,
      mfaPasskeyAvailable: true,
      challengeId: 'mfa-challenge',
    });
    expect(beginLoginChallenge).toHaveBeenCalledWith(SYSTEM_ADMIN.id, 'email_otp');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not let a non-system-admin complete a stale MFA challenge after demo mode starts', async () => {
    const createSession = vi.fn();
    container.registerInstance(MfaService, {
      verifyLoginChallenge: vi.fn().mockResolvedValue({ userId: DEMO_USER.id, authMethod: 'email_otp' }),
    } as never);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(DEMO_USER),
    } as never);
    container.registerInstance(SessionService, { createSession } as never);

    const response = await makeApp().request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'stale-standard-challenge', totpCode: '123456' }),
    });

    expect(response.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
  });
});
