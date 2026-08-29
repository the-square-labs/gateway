import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getEnv } from '@/config/env.js';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv } from '@/types.js';
import {
  beginCurrentUserTotpSetupRoute,
  confirmCurrentUserTotpSetupRoute,
  csrfTokenRoute,
  currentUserPreferencesRoute,
  currentUserRoute,
  getCurrentUserMfaRoute,
  listCurrentUserSessionsRoute,
  logoutRoute,
  regenerateCurrentUserRecoveryCodesRoute,
  removeCurrentUserAvatarRoute,
  resetCurrentUserTotpRoute,
  revokeCurrentUserSessionRoute,
  revokeOtherCurrentUserSessionsRoute,
  stopImpersonationRoute,
  updateCurrentUserAvatarRoute,
  updateCurrentUserPreferencesRoute,
} from './auth.docs.js';
import { authMiddleware, CSRF_HEADER_NAME, sessionOnly } from './auth.middleware.js';
import { AuthService } from './auth.service.js';
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
  PasswordCompleteSchema,
  PasswordResetTokenSchema,
} from './auth-route-schemas.js';
import { AvatarStorageService } from './avatar-storage.service.js';
import { requiresSessionMfaReauthentication } from './live-session-user.js';
import { LocalAuthService } from './local-auth.service.js';
import { MfaService } from './mfa.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';
import { PasskeyService } from './passkey.service.js';
import { getPublicAuthMethods } from './public-auth-methods.js';
import {
  getAcceptedSessionCookieNames,
  getSessionCookieNameForUrl,
  LEGACY_SESSION_COOKIE_NAME,
} from './session-cookie.js';

export const authRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

async function setLocalSession(
  c: any,
  user: import('@/types.js').User,
  authMethod: 'password' | 'email_otp',
  mfaSatisfied = false
) {
  const sessionService = container.resolve(SessionService);
  const { sessionId } = await sessionService.createSession(user, undefined, undefined, {
    authMethod,
    ipAddress: await getClientIpForContext(c),
    userAgent: c.req.header('user-agent'),
    ...(mfaSatisfied ? { mfaSatisfiedAt: Date.now() } : {}),
  });
  await container.resolve(AuthService).recordSuccessfulSignIn(user.id);
  const publicUrl = await getPublicUrl();
  const publicUrlObject = new URL(publicUrl);
  const cookieOptions = {
    httpOnly: true,
    secure: publicUrlObject.protocol === 'https:',
    sameSite: 'Lax' as const,
    maxAge: getEnvironmentSettingsSnapshot().sessions.expirySeconds,
    path: '/',
  };
  setCookie(c, getSessionCookieNameForUrl(publicUrl), sessionId, cookieOptions);

  if (['localhost', '127.0.0.1', '::1'].includes(publicUrlObject.hostname)) {
    setCookie(c, LEGACY_SESSION_COOKIE_NAME, sessionId, cookieOptions);
  }
}

async function getPublicUrl(): Promise<string> {
  try {
    return await container.resolve(GeneralSettingsService).requirePublicUrl();
  } catch {
    // Isolated tests and pre-migration fixtures still provide APP_URL.
    return getEnv().APP_URL;
  }
}

function getRequestSessionId(c: any): string | null {
  for (const cookieName of getAcceptedSessionCookieNames()) {
    const sessionId = getCookie(c, cookieName);
    if (sessionId) return sessionId;
  }
  return null;
}

function clearSessionCookies(c: any): void {
  for (const cookieName of getAcceptedSessionCookieNames()) {
    deleteCookie(c, cookieName, { path: '/' });
  }
}

async function finishLocalPrimaryAuth(c: any, user: import('@/types.js').User, authMethod: 'password' | 'email_otp') {
  const mfa = container.resolve(MfaService);
  const [mfaStatus, gatewayMfaRequired] = await Promise.all([
    mfa.getStatus(user.id),
    mfa.isGatewayMfaRequired(user.id),
  ]);

  if (mfaStatus.totpConfigured || mfaStatus.passkeyCount > 0) {
    return c.json({
      ok: true,
      mfaRequired: true,
      mfaPasskeyAvailable: mfaStatus.passkeyCount > 0,
      challengeId: await mfa.beginLoginChallenge(user.id, authMethod),
    });
  }

  if (gatewayMfaRequired) {
    return c.json({
      ok: true,
      mfaEnrollmentRequired: true,
      enrollmentToken: await mfa.beginEnrollmentChallenge(user.id, authMethod),
    });
  }

  await setLocalSession(c, user, authMethod);
  return c.json({ ok: true });
}

function assertLocalMfaAccount(user: import('@/types.js').User) {
  if (user.authMethod === 'oidc') {
    throw new AppError(409, 'MFA_MANAGED_BY_IDP', 'MFA for OIDC accounts is managed by the identity provider');
  }
}

// Login route
const loginRoute = createRoute({
  method: 'get',
  path: '/login',
  tags: ['Authentication'],
  summary: 'Initiate OIDC login',
  request: {
    query: z.object({
      return_to: z.string().url().optional(),
    }),
  },
  responses: {
    302: { description: 'Redirect to OIDC provider' },
    500: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Failed to initiate login' },
  },
});

authRoutes.openapi(loginRoute, async (c) => {
  const authService = container.resolve(AuthService);
  const { return_to } = c.req.valid('query');
  const authUrl = await authService.getAuthorizationUrl(return_to);
  return c.redirect(authUrl, 302);
});

// Callback route
const callbackRoute = createRoute({
  method: 'get',
  path: '/callback',
  tags: ['Authentication'],
  summary: 'OIDC callback',
  request: {
    query: z.object({
      code: z.string(),
      state: z.string(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
  },
  responses: {
    302: { description: 'Redirect to application' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Authentication failed' },
  },
});

authRoutes.openapi(callbackRoute, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const { state, error, error_description } = c.req.valid('query');

  if (error) {
    await auditService.log({
      userId: null,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { error, errorDescription: error_description || null },
    });
    return c.json({ code: 'AUTH_ERROR', message: error_description || error }, 400);
  }

  try {
    const requestUrl = new URL(c.req.url);
    const oidc = await container.resolve(OidcSettingsService).getRuntimeConfig();
    if (!oidc) {
      return c.json({ code: 'OIDC_NOT_CONFIGURED', message: 'OIDC is not configured' }, 503);
    }
    const callbackUrl = new URL(oidc.redirectUri);
    callbackUrl.search = requestUrl.search;

    const result = await authService.handleCallback(callbackUrl.toString(), state, {
      ipAddress: await getClientIpForContext(c),
      userAgent: c.req.header('user-agent'),
    });
    await auditService.log({
      userId: result.user.id,
      action: 'auth.login',
      resourceType: 'session',
      details: { returnTo: result.returnTo ?? null },
    });

    const publicUrl = await getPublicUrl();
    setCookie(c, getSessionCookieNameForUrl(publicUrl), result.sessionId, {
      httpOnly: true,
      secure: new URL(publicUrl).protocol === 'https:',
      sameSite: 'Lax',
      maxAge: getEnvironmentSettingsSnapshot().sessions.expirySeconds,
      path: '/',
    });

    let safeReturnTo: string | null = null;
    let directReturnTo: string | null = null;
    if (result.returnTo) {
      try {
        if (new URL(result.returnTo).origin === new URL(publicUrl).origin) {
          safeReturnTo = result.returnTo;
          const returnPath = new URL(result.returnTo).pathname;
          if (returnPath.startsWith('/api/oauth/authorize') || returnPath === '/oauth/consent') {
            directReturnTo = result.returnTo;
          }
        }
      } catch {
        // Invalid URL, use default
      }
    }
    if (directReturnTo) {
      return c.redirect(directReturnTo, 302);
    }
    const redirectUrl = new URL('/callback', publicUrl);
    if (safeReturnTo) redirectUrl.searchParams.set('return_to', safeReturnTo);
    return c.redirect(redirectUrl.toString(), 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    await auditService.log({
      userId: null,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { error: message },
    });
    return c.json({ code: 'AUTH_ERROR', message }, 400);
  }
});

authRoutes.get('/methods', async (c) => {
  return c.json(await getPublicAuthMethods());
});

authRoutes.post('/password/login', async (c) => {
  const input = LocalPasswordLoginSchema.parse(await c.req.json());
  const localAuth = container.resolve(LocalAuthService);
  const user = await localAuth.authenticatePassword(input.email, input.password);
  if (!user) return c.json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }, 401);
  return finishLocalPrimaryAuth(c, user, 'password');
});

authRoutes.post('/email/continue', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  return c.json(await container.resolve(LocalAuthService).beginEmailSignIn(input.email));
});

authRoutes.post('/email-otp/request', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  const localAuth = container.resolve(LocalAuthService);
  const challengeId = await localAuth.requestEmailOtp(input.email).catch(() => null);
  return c.json({ ok: true, challengeId: challengeId ?? crypto.randomUUID() });
});

authRoutes.post('/email-otp/verify', async (c) => {
  const input = EmailCodeSchema.parse(await c.req.json());
  const localAuth = container.resolve(LocalAuthService);
  const user = await localAuth.verifyEmailOtp(input.challengeId, input.code);
  if (!user) return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired sign-in code' }, 401);
  return finishLocalPrimaryAuth(c, user, 'email_otp');
});

authRoutes.post('/mfa/verify', async (c) => {
  const input = MfaVerifySchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const completed = await mfa.verifyLoginChallenge(input.challengeId, input);
  if (!completed) return c.json({ code: 'INVALID_MFA_CODE', message: 'Invalid or expired authentication code' }, 401);
  const user = await container.resolve(AuthService).getUserById(completed.userId);
  if (!user || user.isBlocked)
    return c.json({ code: 'INVALID_MFA_CODE', message: 'Invalid or expired authentication code' }, 401);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true });
});

authRoutes.post('/mfa/enrollment/totp/setup', async (c) => {
  const { token } = MfaEnrollmentTokenSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked)
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  return c.json(await mfa.beginTotpSetup(user.id, user.email));
});

authRoutes.post('/mfa/enrollment/totp/confirm', async (c) => {
  const { token, code } = MfaEnrollmentConfirmSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const recoveryCodes = await mfa.confirmTotpSetup(pending.userId, code);
  const completed = await mfa.completeEnrollmentChallenge(token);
  const user = completed ? await container.resolve(AuthService).getUserById(completed.userId) : null;
  if (!completed || !user || user.isBlocked)
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true, recoveryCodes });
});

authRoutes.post('/mfa/enrollment/passkey/options', async (c) => {
  const { token } = MfaEnrollmentTokenSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked)
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  return c.json(await container.resolve(PasskeyService).beginRegistration(user));
});

authRoutes.post('/mfa/enrollment/passkey/confirm', async (c) => {
  const { token, response, name } = MfaEnrollmentPasskeyConfirmSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked)
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  await container.resolve(PasskeyService).finishRegistration(user, response, name ?? 'Passkey');
  const completed = await mfa.completeEnrollmentChallenge(token);
  if (!completed) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true });
});

authRoutes.post('/passkeys/options', async (c) => {
  const options = await container.resolve(PasskeyService).beginDiscoverableAuthentication();
  return c.json(options);
});

authRoutes.post('/passkeys/verify', async (c) => {
  const { challenge, response } = PasskeyAuthenticationSchema.parse(await c.req.json());
  const user = await container.resolve(PasskeyService).verifyAuthentication(challenge, response);
  if (!user) return c.json({ code: 'INVALID_PASSKEY', message: 'Passkey sign-in could not be verified' }, 401);
  await setLocalSession(c, user, user.authMethod as 'password' | 'email_otp', true);
  return c.json({ ok: true });
});

authRoutes.post('/mfa/passkey/options', async (c) => {
  const { challengeId } = MfaPasskeyOptionsSchema.parse(await c.req.json());
  const pending = await container.resolve(MfaService).getLoginChallenge(challengeId);
  if (!pending) return c.json({ code: 'MFA_CHALLENGE_EXPIRED', message: 'MFA sign-in has expired' }, 400);
  return c.json(await container.resolve(PasskeyService).beginAuthenticationForUser(pending.userId));
});

authRoutes.post('/mfa/passkey/verify', async (c) => {
  const { challengeId, passkeyChallenge, response } = MfaPasskeyVerifySchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getLoginChallenge(challengeId);
  if (!pending) return c.json({ code: 'INVALID_MFA_PASSKEY', message: 'Passkey sign-in could not be verified' }, 401);
  const user = await container
    .resolve(PasskeyService)
    .verifyAuthentication(passkeyChallenge, response, pending.userId, false);
  const completed = user ? await mfa.completeVerifiedLoginChallenge(challengeId) : null;
  if (!user || !completed)
    return c.json({ code: 'INVALID_MFA_PASSKEY', message: 'Passkey sign-in could not be verified' }, 401);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true });
});

authRoutes.post('/password/reset/request', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  await container
    .resolve(LocalAuthService)
    .requestPasswordLink(input.email, 'password_reset')
    .catch(() => {});
  return c.json({ ok: true });
});

authRoutes.post('/password/reset/profile', async (c) => {
  const { token } = PasswordResetTokenSchema.parse(await c.req.json());
  const profile = await container.resolve(LocalAuthService).getPasswordLinkProfile(token);
  if (!profile) return c.json({ code: 'INVALID_RESET_TOKEN', message: 'Invalid or expired password link' }, 400);
  return c.json(profile);
});

authRoutes.post('/password/reset/complete', async (c) => {
  const input = PasswordCompleteSchema.parse(await c.req.json());
  await container.resolve(LocalAuthService).completePasswordLink(input.token, input.password);
  return c.json({ ok: true });
});

// CSRF token for cookie-authenticated browser mutations
authRoutes.use('/csrf', async (c, next) => {
  const sessionId = getRequestSessionId(c);
  const session = sessionId ? await container.resolve(SessionService).getSession(sessionId) : null;
  if (sessionId && session?.purpose === 'impersonation') {
    c.set('sessionId', sessionId);
    c.set('authType', 'session');
    await next();
    return;
  }
  await authMiddleware(c, next);
});
authRoutes.use('/csrf', sessionOnly);
authRoutes.openapi(csrfTokenRoute, async (c) => {
  const sessionId = c.get('sessionId');
  if (!sessionId) {
    return c.json({ code: 'AUTH_ERROR', message: 'Not a session-based login' }, 400);
  }
  const sessionService = container.resolve(SessionService);
  const csrfToken = await sessionService.ensureCsrfToken(sessionId);
  if (!csrfToken) {
    return c.json({ code: 'AUTH_ERROR', message: 'Invalid or expired session' }, 401);
  }
  return c.json({ csrfToken });
});

authRoutes.openapi(stopImpersonationRoute, async (c) => {
  const sessionService = container.resolve(SessionService);
  const impersonationSessionId = getRequestSessionId(c);
  const impersonationSession = impersonationSessionId ? await sessionService.getSession(impersonationSessionId) : null;

  if (!impersonationSessionId || impersonationSession?.purpose !== 'impersonation') {
    throw new AppError(409, 'IMPERSONATION_NOT_ACTIVE', 'No impersonation session is active');
  }
  if (
    !(await sessionService.validateCsrfToken(
      impersonationSessionId,
      c.req.header(CSRF_HEADER_NAME),
      impersonationSession
    ))
  ) {
    throw new AppError(403, 'INVALID_CSRF', 'Invalid CSRF token');
  }

  const original = await sessionService.getOriginalSessionForImpersonation(impersonationSession);
  const actorUserId = impersonationSession.impersonation?.actorUserId;
  const actor = actorUserId ? await container.resolve(AuthService).getUserById(actorUserId) : null;
  if (
    !original ||
    !actor ||
    actor.isBlocked ||
    actor.isDeleted ||
    requiresSessionMfaReauthentication(actor, original.session)
  ) {
    await sessionService.destroySession(impersonationSessionId);
    clearSessionCookies(c);
    throw new AppError(401, 'ORIGINAL_SESSION_INVALID', 'The original administrator session is no longer valid');
  }

  const publicUrl = await getPublicUrl();
  setCookie(c, getSessionCookieNameForUrl(publicUrl), original.sessionId, {
    httpOnly: true,
    secure: new URL(publicUrl).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: Math.max(1, Math.floor((original.session.expiresAt - Date.now()) / 1000)),
    path: '/',
  });
  await sessionService.destroySession(impersonationSessionId);

  const subject = impersonationSession.user;
  await container.resolve(AuditService).log({
    userId: actor.id,
    action: 'auth.impersonation.stop',
    resourceType: 'session',
    resourceId: subject.id,
    details: {
      impersonatedUserId: subject.id,
      impersonatedUserEmail: subject.email,
      impersonatedUserName: subject.name,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: 'Impersonation stopped' });
});

// Logout
authRoutes.use('/logout', authMiddleware);
authRoutes.use('/logout', sessionOnly);
authRoutes.openapi(logoutRoute, async (c) => {
  const sessionId = c.get('sessionId');
  if (!sessionId) {
    return c.json({ message: 'Not a session-based login' }, 400);
  }
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const user = c.get('user');
  await auditService.log({
    userId: user?.id ?? null,
    action: 'auth.logout',
    resourceType: 'session',
    details: { hasSession: true },
  });
  const logoutUrl = await authService.logout(sessionId);
  const cookieHeader = c.req.header('Cookie') ?? '';
  if (cookieHeader.includes('gateway_session_')) {
    for (const cookieName of getAcceptedSessionCookieNames()) {
      deleteCookie(c, cookieName, { path: '/' });
    }
  } else {
    deleteCookie(c, 'session_id', { path: '/' });
  }
  return c.json({ message: 'Logged out successfully', logoutUrl });
});

// Get current user
authRoutes.use('/me', authMiddleware);
authRoutes.use('/me', sessionOnly);
authRoutes.openapi(currentUserRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const impersonation = c.get('impersonation');
  const authService = container.resolve(AuthService);
  const user = await authService.getUserById(sessionUser.id);
  const effectiveScopes = c.get('effectiveScopes') || user?.scopes || [];

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }

  return c.json({
    id: user.id,
    email: user.email,
    authMethod: user.authMethod,
    name: user.name,
    avatarUrl: user.avatarUrl,
    groupId: user.groupId,
    groupName: user.groupName,
    groupScopes: user.groupScopes ?? [],
    additionalScopes: user.additionalScopes ?? [],
    scopes: effectiveScopes,
    isBlocked: user.isBlocked,
    aiApprovalMode: user.aiApprovalMode ?? 'normal',
    ...(impersonation
      ? {
          impersonation: {
            active: true as const,
            actor: {
              id: impersonation.actor.id,
              email: impersonation.actor.email,
              name: impersonation.actor.name,
            },
          },
        }
      : {}),
  });
});

authRoutes.use('/me/preferences', authMiddleware);
authRoutes.use('/me/preferences', sessionOnly);
authRoutes.openapi(currentUserPreferencesRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const authService = container.resolve(AuthService);
  const preferences = await authService.getUserPreferences(sessionUser.id);
  if (!preferences) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }
  return c.json(preferences);
});

authRoutes.openapi(updateCurrentUserPreferencesRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const authService = container.resolve(AuthService);
  const preferences = await authService.updateUserPreferences(sessionUser.id, c.req.valid('json'));
  return c.json(preferences);
});

authRoutes.use('/me/avatar', authMiddleware);
authRoutes.use('/me/avatar', sessionOnly);
authRoutes.openapi(updateCurrentUserAvatarRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const { avatar } = c.req.valid('form');
  if (!(avatar instanceof File)) {
    throw new AppError(400, 'AVATAR_REQUIRED', 'Avatar image is required');
  }
  const updated = await container.resolve(AuthService).uploadUserAvatar(sessionUser.id, avatar);
  await container.resolve(AuditService).log({
    userId: sessionUser.id,
    action: 'user.avatar_update',
    resourceType: 'user',
    resourceId: sessionUser.id,
    details: { customAvatar: true, sizeBytes: avatar.size, mediaType: avatar.type },
  });
  return c.json(updated);
});

authRoutes.openapi(removeCurrentUserAvatarRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const updated = await container.resolve(AuthService).updateUserAvatar(sessionUser.id, null);
  await container.resolve(AuditService).log({
    userId: sessionUser.id,
    action: 'user.avatar_remove',
    resourceType: 'user',
    resourceId: sessionUser.id,
    details: { customAvatar: false },
  });
  return c.json(updated);
});

authRoutes.get('/avatars/:filename', async (c) => {
  const asset = await container.resolve(AvatarStorageService).read(c.req.param('filename'));
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  c.header('Content-Type', asset.mediaType);
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(Uint8Array.from(asset.bytes).buffer);
});

authRoutes.use('/me/mfa', authMiddleware);
authRoutes.use('/me/mfa', sessionOnly);
authRoutes.openapi(getCurrentUserMfaRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const mfa = container.resolve(MfaService);
  const [status, required] = await Promise.all([mfa.getStatus(user.id), mfa.isGatewayMfaRequired(user.id)]);
  return c.json({ ...status, required });
});

authRoutes.use('/me/mfa/totp/setup', authMiddleware);
authRoutes.use('/me/mfa/totp/setup', sessionOnly);
authRoutes.openapi(beginCurrentUserTotpSetupRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  return c.json(await container.resolve(MfaService).beginTotpSetup(user.id, user.email));
});

authRoutes.use('/me/mfa/totp/reset', authMiddleware);
authRoutes.use('/me/mfa/totp/reset', sessionOnly);
authRoutes.openapi(resetCurrentUserTotpRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  await container.resolve(MfaService).resetTotp(user.id);
  return c.json({ ok: true });
});

authRoutes.use('/me/mfa/totp/confirm', authMiddleware);
authRoutes.use('/me/mfa/totp/confirm', sessionOnly);
authRoutes.openapi(confirmCurrentUserTotpSetupRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const { code } = c.req.valid('json');
  return c.json({ recoveryCodes: await container.resolve(MfaService).confirmTotpSetup(user.id, code) });
});

authRoutes.use('/me/mfa/recovery-codes', authMiddleware);
authRoutes.use('/me/mfa/recovery-codes', sessionOnly);
authRoutes.openapi(regenerateCurrentUserRecoveryCodesRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const { code } = c.req.valid('json');
  const mfa = container.resolve(MfaService);
  if (!(await mfa.verifyTotp(user.id, code)))
    throw new AppError(401, 'INVALID_TOTP_CODE', 'Invalid authentication code');
  return c.json({ recoveryCodes: await mfa.regenerateRecoveryCodes(user.id) });
});

authRoutes.use('/me/mfa/recovery-codes/passkey/*', authMiddleware);
authRoutes.use('/me/mfa/recovery-codes/passkey/*', sessionOnly);
authRoutes.post('/me/mfa/recovery-codes/passkey/options', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  return c.json(await container.resolve(PasskeyService).beginAuthenticationForUser(user.id));
});

authRoutes.post('/me/mfa/recovery-codes/passkey/verify', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const { challenge, response } = PasskeyAuthenticationSchema.parse(await c.req.json());
  const verifiedUser = await container
    .resolve(PasskeyService)
    .verifyAuthentication(challenge, response, user.id, false);
  if (!verifiedUser) throw new AppError(401, 'INVALID_PASSKEY', 'Passkey verification failed');
  return c.json({ recoveryCodes: await container.resolve(MfaService).regenerateRecoveryCodes(user.id) });
});

authRoutes.use('/me/passkeys', authMiddleware);
authRoutes.use('/me/passkeys', sessionOnly);
authRoutes.use('/me/passkeys/*', authMiddleware);
authRoutes.use('/me/passkeys/*', sessionOnly);
authRoutes.get('/me/passkeys', async (c) => {
  const user = c.get('user')!;
  return c.json(await container.resolve(PasskeyService).listPasskeys(user.id));
});

authRoutes.post('/me/passkeys/options', async (c) => {
  const user = c.get('user')!;
  return c.json(await container.resolve(PasskeyService).beginRegistration(user));
});

authRoutes.post('/me/passkeys', async (c) => {
  const user = c.get('user')!;
  const { response, name } = PasskeyRegistrationSchema.parse(await c.req.json());
  await container.resolve(PasskeyService).finishRegistration(user, response, name ?? 'Passkey');
  return c.json({ ok: true });
});

authRoutes.delete('/me/passkeys/:id', async (c) => {
  const user = c.get('user')!;
  if (!(await container.resolve(PasskeyService).removePasskey(user.id, c.req.param('id')!))) {
    throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
  }
  return c.json({ ok: true });
});

authRoutes.use('/me/sessions', authMiddleware);
authRoutes.use('/me/sessions', sessionOnly);
authRoutes.openapi(listCurrentUserSessionsRoute, async (c) => {
  const sessionId = c.get('sessionId')!;
  const user = c.get('user')!;
  const sessionService = container.resolve(SessionService);
  return c.json(await sessionService.listPublicUserSessions(user.id, sessionId));
});

// OpenAPI routes use `{id}`, while Hono middleware matchers require `:id`.
// Keeping these syntaxes separate ensures revoke requests receive the session
// authentication context before the route handler accesses `user.id`.
authRoutes.use('/me/sessions/:id', authMiddleware);
authRoutes.use('/me/sessions/:id', sessionOnly);
authRoutes.openapi(revokeCurrentUserSessionRoute, async (c) => {
  const sessionId = c.get('sessionId')!;
  const user = c.get('user')!;
  const sessionService = container.resolve(SessionService);
  const revoked = await sessionService.revokeUserSessionByPublicId(user.id, c.req.param('id')!, {
    excludeSessionId: sessionId,
  });
  if (!revoked) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'auth.session_revoke',
    resourceType: 'session',
    resourceId: c.req.param('id')!,
    details: { selfService: true },
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ message: 'Session revoked' });
});

authRoutes.use('/me/sessions/revoke-others', authMiddleware);
authRoutes.use('/me/sessions/revoke-others', sessionOnly);
authRoutes.openapi(revokeOtherCurrentUserSessionsRoute, async (c) => {
  const sessionId = c.get('sessionId')!;
  const user = c.get('user')!;
  const sessionService = container.resolve(SessionService);
  const revoked = await sessionService.revokeOtherUserSessions(user.id, sessionId);
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'auth.session_revoke_others',
    resourceType: 'session',
    details: { selfService: true, revoked },
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ revoked });
});
