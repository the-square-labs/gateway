import { createRoute, z } from '@hono/zod-openapi';
import { appRoute, commonErrorResponses, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';

const AIApprovalModeSchema = z.enum(['always-ask', 'normal', 'bypass-non-destructive', 'bypass-everything']);
const PreferredInterfaceSchema = z.enum(['ai_workspace', 'operations_console']);
const UserPreferencesSchema = z.object({
  aiApprovalMode: AIApprovalModeSchema,
  preferredInterface: PreferredInterfaceSchema.nullable(),
  preferredInterfaceSelectedAt: z.string().datetime().nullable(),
});
const PublicSessionSchema = z.object({
  id: z.string(),
  authMethod: z.enum(['oidc', 'password', 'email_otp']),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  expiresAt: z.number().int(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  mfaSatisfiedAt: z.number().int().nullable(),
  isCurrent: z.boolean(),
});
const MfaStatusSchema = z.object({
  totpConfigured: z.boolean(),
  passkeyCount: z.number().int(),
  recoveryCodeCount: z.number().int(),
  required: z.boolean(),
});

export const csrfTokenRoute = appRoute({
  method: 'get',
  path: '/csrf',
  tags: ['Authentication'],
  summary: 'Get CSRF token for the current session',
  responses: okJson(z.object({ csrfToken: z.string() })),
});

export const logoutRoute = appRoute({
  method: 'post',
  path: '/logout',
  tags: ['Authentication'],
  summary: 'Log out the current browser session',
  responses: okJson(z.object({ message: z.string(), logoutUrl: z.string().optional() })),
});

export const stopImpersonationRoute = appRoute({
  method: 'post',
  path: '/impersonation/stop',
  tags: ['Authentication'],
  summary: 'Stop impersonating and restore the original browser session',
  responses: { ...okJson(z.object({ message: z.string() })), ...commonErrorResponses },
});

export const currentUserRoute = appRoute({
  method: 'get',
  path: '/me',
  tags: ['Authentication'],
  summary: 'Get the current authenticated user',
  responses: okJson(UnknownDataResponseSchema),
});

export const currentUserPreferencesRoute = appRoute({
  method: 'get',
  path: '/me/preferences',
  tags: ['Authentication'],
  summary: 'Get current user preferences',
  responses: okJson(UserPreferencesSchema),
});

export const updateCurrentUserPreferencesRoute = createRoute({
  method: 'patch',
  path: '/me/preferences',
  tags: ['Authentication'],
  summary: 'Update current user preferences',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z
            .object({
              aiApprovalMode: AIApprovalModeSchema.optional(),
              preferredInterface: PreferredInterfaceSchema.optional(),
            })
            .refine((value) => value.aiApprovalMode !== undefined || value.preferredInterface !== undefined, {
              message: 'At least one preference must be provided',
            }),
        },
      },
    },
  },
  responses: { ...okJson(UserPreferencesSchema), ...commonErrorResponses },
});

export const listCurrentUserSessionsRoute = appRoute({
  method: 'get',
  path: '/me/sessions',
  tags: ['Authentication'],
  summary: 'List active browser sessions for the current user',
  responses: okJson(z.array(PublicSessionSchema)),
});

export const revokeCurrentUserSessionRoute = createRoute({
  method: 'delete',
  path: '/me/sessions/{id}',
  tags: ['Authentication'],
  summary: 'Revoke another active browser session',
  request: { params: z.object({ id: z.string().min(1).max(64) }) },
  responses: { ...okJson(z.object({ message: z.string() })), ...commonErrorResponses },
});

export const revokeOtherCurrentUserSessionsRoute = appRoute({
  method: 'post',
  path: '/me/sessions/revoke-others',
  tags: ['Authentication'],
  summary: 'Revoke every active browser session except the current one',
  responses: { ...okJson(z.object({ revoked: z.number().int() })), ...commonErrorResponses },
});

export const getCurrentUserMfaRoute = appRoute({
  method: 'get',
  path: '/me/mfa',
  tags: ['Authentication'],
  summary: 'Get the current local account MFA status',
  responses: okJson(MfaStatusSchema),
});

export const beginCurrentUserTotpSetupRoute = appRoute({
  method: 'post',
  path: '/me/mfa/totp/setup',
  tags: ['Authentication'],
  summary: 'Start TOTP enrollment for the current local account',
  responses: okJson(z.object({ secret: z.string(), uri: z.string() })),
});

export const resetCurrentUserTotpRoute = appRoute({
  method: 'post',
  path: '/me/mfa/totp/reset',
  tags: ['Authentication'],
  summary: 'Reset the current local account TOTP factor and recovery codes',
  responses: { ...okJson(z.object({ ok: z.literal(true) })), ...commonErrorResponses },
});

export const confirmCurrentUserTotpSetupRoute = createRoute({
  method: 'post',
  path: '/me/mfa/totp/confirm',
  tags: ['Authentication'],
  summary: 'Confirm TOTP enrollment and return one-time recovery codes',
  request: { body: { content: { 'application/json': { schema: z.object({ code: z.string().regex(/^\d{6}$/) }) } } } },
  responses: { ...okJson(z.object({ recoveryCodes: z.array(z.string()).length(10) })), ...commonErrorResponses },
});

export const regenerateCurrentUserRecoveryCodesRoute = createRoute({
  method: 'post',
  path: '/me/mfa/recovery-codes',
  tags: ['Authentication'],
  summary: 'Regenerate recovery codes after verifying the active TOTP factor',
  request: { body: { content: { 'application/json': { schema: z.object({ code: z.string().regex(/^\d{6}$/) }) } } } },
  responses: { ...okJson(z.object({ recoveryCodes: z.array(z.string()).length(10) })), ...commonErrorResponses },
});
