import { z } from '@hono/zod-openapi';

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const LocalPasswordLoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(72),
});
export const EmailSchema = z.object({ email: z.string().email().max(255) });
export const EmailCodeSchema = z.object({ challengeId: z.string().min(1).max(64), code: z.string().regex(/^\d{6}$/) });
export const PasswordResetTokenSchema = z.object({ token: z.string().min(1).max(256) });
export const PasswordCompleteSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(1).max(72),
});
export const MfaVerifySchema = z
  .object({
    challengeId: z.string().min(1).max(64),
    totpCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z.string().min(6).max(64).optional(),
  })
  .refine((value) => Number(Boolean(value.totpCode)) + Number(Boolean(value.recoveryCode)) === 1, {
    message: 'Provide exactly one verification method',
  });
export const MfaEnrollmentTokenSchema = z.object({ token: z.string().min(16).max(128) });
export const MfaEnrollmentConfirmSchema = MfaEnrollmentTokenSchema.extend({ code: z.string().regex(/^\d{6}$/) });
export const PasskeyResponseSchema = z.object({ response: z.any() });
export const PasskeyRegistrationSchema = PasskeyResponseSchema.extend({ name: z.string().trim().max(100).optional() });
export const MfaEnrollmentPasskeyConfirmSchema = MfaEnrollmentTokenSchema.merge(PasskeyRegistrationSchema);
export const PasskeyAuthenticationSchema = PasskeyResponseSchema.extend({ challenge: z.string().min(16).max(256) });
export const MfaPasskeyOptionsSchema = z.object({ challengeId: z.string().min(16).max(64) });
export const MfaPasskeyVerifySchema = PasskeyResponseSchema.extend({
  challengeId: z.string().min(16).max(64),
  passkeyChallenge: z.string().min(16).max(256),
});
