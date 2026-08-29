import { describe, expect, it } from 'vitest';
import {
  EmailCodeSchema,
  EmailSchema,
  ErrorSchema,
  LocalPasswordLoginSchema,
  MfaEnrollmentConfirmSchema,
  MfaEnrollmentPasskeyConfirmSchema,
  MfaEnrollmentTokenSchema,
  MfaPasskeyOptionsSchema,
  MfaPasskeyVerifySchema,
  MfaVerifySchema,
  PasskeyAuthenticationSchema,
  PasskeyRegistrationSchema,
  PasskeyResponseSchema,
  PasswordCompleteSchema,
  PasswordResetTokenSchema,
} from '@/modules/auth/auth-route-schemas.js';

describe('auth route schemas', () => {
  it('validates public errors, email addresses, and local passwords', () => {
    expect(ErrorSchema.parse({ code: 'AUTH_FAILED', message: 'Authentication failed' })).toEqual({
      code: 'AUTH_FAILED',
      message: 'Authentication failed',
    });
    expect(ErrorSchema.safeParse({ code: 'AUTH_FAILED' }).success).toBe(false);
    expect(EmailSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
    expect(EmailSchema.safeParse({ email: 'invalid' }).success).toBe(false);
    expect(LocalPasswordLoginSchema.safeParse({ email: 'user@example.com', password: 'x'.repeat(72) }).success).toBe(
      true
    );
    expect(LocalPasswordLoginSchema.safeParse({ email: 'user@example.com', password: 'x'.repeat(73) }).success).toBe(
      false
    );
  });

  it('validates email challenges and password reset payload limits', () => {
    expect(EmailCodeSchema.safeParse({ challengeId: 'challenge', code: '123456' }).success).toBe(true);
    expect(EmailCodeSchema.safeParse({ challengeId: 'challenge', code: '12345' }).success).toBe(false);
    expect(PasswordResetTokenSchema.safeParse({ token: 'token' }).success).toBe(true);
    expect(PasswordResetTokenSchema.safeParse({ token: '' }).success).toBe(false);
    expect(PasswordCompleteSchema.safeParse({ token: 'token', password: 'new-password' }).success).toBe(true);
    expect(PasswordCompleteSchema.safeParse({ token: 'token', password: '' }).success).toBe(false);
  });

  it('requires exactly one TOTP or recovery verification method', () => {
    expect(MfaVerifySchema.safeParse({ challengeId: 'challenge', totpCode: '123456' }).success).toBe(true);
    expect(MfaVerifySchema.safeParse({ challengeId: 'challenge', recoveryCode: 'recovery-code' }).success).toBe(true);
    expect(MfaVerifySchema.safeParse({ challengeId: 'challenge' }).success).toBe(false);
    expect(
      MfaVerifySchema.safeParse({ challengeId: 'challenge', totpCode: '123456', recoveryCode: 'recovery-code' }).success
    ).toBe(false);
  });

  it('validates MFA enrollment tokens and TOTP confirmation', () => {
    const token = 't'.repeat(16);
    expect(MfaEnrollmentTokenSchema.safeParse({ token }).success).toBe(true);
    expect(MfaEnrollmentTokenSchema.safeParse({ token: 'short' }).success).toBe(false);
    expect(MfaEnrollmentConfirmSchema.safeParse({ token, code: '123456' }).success).toBe(true);
    expect(MfaEnrollmentConfirmSchema.safeParse({ token, code: 'abcdef' }).success).toBe(false);
  });

  it('validates passkey registration and MFA enrollment payloads', () => {
    const response = { id: 'credential' };
    const token = 't'.repeat(16);
    expect(PasskeyResponseSchema.parse({ response })).toEqual({ response });
    expect(PasskeyRegistrationSchema.parse({ response, name: '  Laptop  ' })).toEqual({ response, name: 'Laptop' });
    expect(MfaEnrollmentPasskeyConfirmSchema.safeParse({ token, response, name: 'Laptop' }).success).toBe(true);
    expect(MfaEnrollmentPasskeyConfirmSchema.safeParse({ token: 'short', response }).success).toBe(false);
  });

  it('validates passkey authentication and verification challenge bounds', () => {
    const response = { id: 'credential' };
    const challenge = 'c'.repeat(16);
    expect(PasskeyAuthenticationSchema.safeParse({ challenge, response }).success).toBe(true);
    expect(PasskeyAuthenticationSchema.safeParse({ challenge: 'short', response }).success).toBe(false);
    expect(MfaPasskeyOptionsSchema.safeParse({ challengeId: challenge }).success).toBe(true);
    expect(
      MfaPasskeyVerifySchema.safeParse({ challengeId: challenge, passkeyChallenge: challenge, response }).success
    ).toBe(true);
    expect(
      MfaPasskeyVerifySchema.safeParse({ challengeId: 'short', passkeyChallenge: challenge, response }).success
    ).toBe(false);
  });
});
