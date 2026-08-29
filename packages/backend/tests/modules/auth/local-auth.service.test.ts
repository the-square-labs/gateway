import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({ APP_URL: 'https://gateway.example.test' }),
}));

import { LocalAuthService } from '@/modules/auth/local-auth.service.js';

function createService(options: {
  methods: { password: boolean; emailOtp: boolean };
  user?: unknown;
  passwordResetReservations?: Array<0 | 1>;
}) {
  const findFirst = vi.fn().mockResolvedValue(options.user ?? null);
  const evalPasswordReset = vi.fn().mockImplementation(async () => options.passwordResetReservations?.shift() ?? 1);
  const cacheService = {
    set: vi.fn().mockResolvedValue(undefined),
    getClient: () => ({ eval: evalPasswordReset }),
  };
  const authMailService = { sendSecurityEmail: vi.fn().mockResolvedValue(undefined) };
  const service = new LocalAuthService(
    { query: { users: { findFirst } } } as any,
    cacheService as any,
    {} as any,
    { getConfig: vi.fn().mockResolvedValue({ methods: options.methods }) } as any,
    authMailService as any,
    {} as any
  );
  return { service, authMailService, cacheService, evalPasswordReset };
}

describe('LocalAuthService.beginEmailSignIn', () => {
  it('uses password as the generic fallback when both local methods are enabled', async () => {
    const { service } = createService({ methods: { password: true, emailOtp: true } });

    await expect(service.beginEmailSignIn('unknown@example.com')).resolves.toEqual({ method: 'password' });
  });

  it('sends a code and returns an OTP challenge for an active email-OTP account', async () => {
    const { service, authMailService, cacheService } = createService({
      methods: { password: true, emailOtp: true },
      user: { id: 'user-1', email: 'otp@example.com', isBlocked: false },
    });

    const result = await service.beginEmailSignIn('otp@example.com');

    expect(result.method).toBe('email_otp');
    expect('challengeId' in result && result.challengeId).toEqual(expect.any(String));
    expect(cacheService.set).toHaveBeenCalledOnce();
    expect(authMailService.sendSecurityEmail).toHaveBeenCalledWith(
      'otp@example.com',
      expect.objectContaining({ kind: 'email_otp' })
    );
  });
});

describe('LocalAuthService.requestPasswordLink', () => {
  it('sends at most three password-reset emails per account in an hour', async () => {
    const { service, authMailService, cacheService, evalPasswordReset } = createService({
      methods: { password: true, emailOtp: false },
      user: { id: 'user-1', email: 'user@example.com', isBlocked: false },
      passwordResetReservations: [1, 1, 1, 0],
    });

    await service.requestPasswordLink('user@example.com', 'password_reset');
    await service.requestPasswordLink('user@example.com', 'password_reset');
    await service.requestPasswordLink('user@example.com', 'password_reset');
    await service.requestPasswordLink('user@example.com', 'password_reset');

    expect(evalPasswordReset).toHaveBeenCalledTimes(4);
    expect(cacheService.set).toHaveBeenCalledTimes(3);
    expect(authMailService.sendSecurityEmail).toHaveBeenCalledTimes(3);
  });
});

describe('LocalAuthService.sendEmailOtpOnboarding', () => {
  it('sends the account onboarding message with the Gateway login URL', async () => {
    const { service, authMailService } = createService({
      methods: { password: false, emailOtp: true },
    });

    await service.sendEmailOtpOnboarding(' USER@EXAMPLE.COM ');

    expect(authMailService.sendSecurityEmail).toHaveBeenCalledWith('user@example.com', {
      kind: 'email_otp_enabled',
      actionUrl: 'https://gateway.example.test/login',
    });
  });
});
