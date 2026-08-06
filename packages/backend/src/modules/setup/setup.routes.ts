import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import {
  GeneralSettingsService,
  isValidGatewayHostPortTarget,
  isValidGatewayIp,
  isValidGatewayIpPortTarget,
} from '@/modules/settings/general-settings.service.js';
import { RuntimeRestartService } from '@/services/runtime-restart.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import type { AppEnv } from '@/types.js';
import { SetupAccessService, SetupAlreadyInProgressError, SetupApplyInProgressError } from './setup-access.service.js';
import { getSetupNetworkSuggestions } from './setup-network-suggestions.js';
import { SetupTokenPolicyService } from './setup-token-policy.js';
import { SetupWizardService } from './setup-wizard.service.js';

const logger = createChildLogger('SetupRoutes');

export const setupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
export const SETUP_SESSION_COOKIE = 'setup_session';
export const SETUP_CSRF_HEADER = 'X-CSRF-Token';

async function setupApiDisabledResponse(c: Context<AppEnv>): Promise<Response | null> {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/setup/status') return null;

  const policy = container.resolve(SetupTokenPolicyService);
  const enabled = await policy.isSetupApiEnabled();
  if (enabled) return null;

  logger.warn('Disabled setup API endpoint requested after setup lockout', {
    path,
    method: c.req.method,
  });
  return c.notFound();
}

export const setupApiDisabledMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const disabled = await setupApiDisabledResponse(c);
  if (disabled) return disabled;
  await next();
};

setupRoutes.use('*', setupApiDisabledMiddleware);

setupRoutes.get('/status', async (c) => {
  const policy = container.resolve(SetupTokenPolicyService);
  const access = container.resolve(SetupAccessService);
  const [complete, code, publicUrl, transport, progress] = await Promise.all([
    policy.isSetupComplete(),
    access.getCodeMetadata(),
    container.resolve(GeneralSettingsService).getPublicUrl(),
    container.resolve(WebTransportSettingsService).getConfig(),
    access.getProgress(getCookie(c, SETUP_SESSION_COOKIE)),
  ]);
  return c.json({
    data: {
      state: complete ? 'complete' : 'pending',
      code,
      publicUrl,
      tlsEnabled: transport.tlsEnabled,
      setupInProgress: progress.inProgress,
      currentSession: progress.currentSession,
    },
  });
});

setupRoutes.post('/unlock', async (c) => {
  const body = await c.req.json<{ code?: string }>();
  let session: { sessionId: string; codeId: string; csrfToken: string; expiresAt: string };
  try {
    session = await container.resolve(SetupAccessService).createSession(body.code?.trim() ?? '');
  } catch (error) {
    if (error instanceof SetupAlreadyInProgressError) {
      throw new AppError(409, 'SETUP_IN_PROGRESS', 'Gateway setup is already in progress');
    }
    throw new AppError(401, 'SETUP_CODE_INVALID', 'Invalid or expired setup code');
  }
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = forwardedProto ? forwardedProto === 'https' : new URL(c.req.url).protocol === 'https:';
  setCookie(c, SETUP_SESSION_COOKIE, session.sessionId, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge: Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000)),
    path: '/api/setup',
  });
  return c.json({
    data: {
      unlocked: true,
      codeId: session.codeId,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    },
  });
});

export const requireSetupSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const valid = await container.resolve(SetupAccessService).validateSession(getCookie(c, SETUP_SESSION_COOKIE));
  if (!valid) throw new AppError(401, 'SETUP_SESSION_REQUIRED', 'A valid setup session is required');
  await next();
};

const SetupAuthSchema = z.object({
  methods: z.object({ oidc: z.boolean(), password: z.boolean(), emailOtp: z.boolean() }),
  oidc: z
    .object({
      issuer: z.string().url(),
      clientId: z.string().trim().min(1),
      clientSecret: z.string().min(1).optional(),
      redirectUri: z.string().url(),
      scopes: z.string().trim().min(1).optional(),
    })
    .optional(),
  smtp: z
    .object({
      host: z.string().trim().min(1),
      port: z.number().int().min(1).max(65535),
      tlsMode: z.enum(['starttls', 'tls']),
      username: z.string().trim(),
      password: z.string().min(1).optional(),
      senderName: z.string().trim(),
      senderEmail: z.string().email(),
    })
    .optional(),
  passwordPolicy: z
    .object({
      minLength: z.number().int().min(8).max(72).optional(),
      maxLength: z.number().int().min(8).max(72).optional(),
      requireUppercase: z.boolean().optional(),
      requireLowercase: z.boolean().optional(),
      requireDigit: z.boolean().optional(),
      requireSymbol: z.boolean().optional(),
    })
    .optional(),
});

const SetupAdminSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.string().email().max(255),
  authMethod: z.enum(['oidc', 'password', 'email_otp']),
  password: z.string().min(1).max(72).optional(),
});

const SetupLoggingSchema = z.object({
  mode: z.enum(['disabled', 'local', 'external']),
  url: z.string().url().optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
  database: z.string().trim().min(1).optional(),
  table: z.string().trim().min(1).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
});

const SetupApplySchema = z.object({
  publicUrl: z.string().trim().min(1).max(2048),
  network: z.object({
    publicIps: z
      .array(z.string().trim().min(1).max(64).refine(isValidGatewayIp, 'Must be an IPv4 or IPv6 address'))
      .length(1, 'Select exactly one public IP address'),
    grpcPublicTarget: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(isValidGatewayHostPortTarget, 'Must be a hostname or IP address, optionally with a port'),
    grpcLocalIp: z
      .string()
      .trim()
      .max(255)
      .refine((value) => value === '' || isValidGatewayIpPortTarget(value), {
        message: 'Must be an IPv4 or IPv6 address, optionally with a port',
      }),
  }),
  auth: SetupAuthSchema,
  administrator: SetupAdminSchema.optional(),
  logging: SetupLoggingSchema,
});

setupRoutes.use('/wizard/*', requireSetupSession);

setupRoutes.get('/wizard/csrf', async (c) => {
  const csrfToken = await container.resolve(SetupAccessService).getCsrfToken(getCookie(c, SETUP_SESSION_COOKIE));
  if (!csrfToken) throw new AppError(401, 'SETUP_SESSION_REQUIRED', 'A valid setup session is required');
  return c.json({ data: { csrfToken } });
});

setupRoutes.use('/wizard/apply', async (c, next) => {
  const valid = await container
    .resolve(SetupAccessService)
    .validateCsrfToken(getCookie(c, SETUP_SESSION_COOKIE), c.req.header(SETUP_CSRF_HEADER));
  if (!valid) throw new AppError(403, 'SETUP_CSRF_INVALID', 'Invalid setup CSRF token');
  await next();
});

setupRoutes.get('/wizard/config', async (c) => {
  const [general, auth, smtp, oidc, logging, transport, administratorCreated] = await Promise.all([
    container.resolve(GeneralSettingsService).getConfig(),
    container.resolve(AuthSettingsService).getConfig(),
    container.resolve(AuthMailService).getPublicConfig(),
    container.resolve(OidcSettingsService).getPublicConfig(),
    container.resolve(LoggingSettingsService).getPublicConfig(),
    container.resolve(WebTransportSettingsService).getConfig(),
    container.resolve(SetupTokenPolicyService).isGatewayConfigured(),
  ]);
  return c.json({
    data: {
      general,
      auth,
      smtp,
      oidc,
      logging,
      transport,
      administratorCreated,
      networkSuggestions: getSetupNetworkSuggestions(),
    },
  });
});

setupRoutes.post('/wizard/apply', async (c) => {
  const access = container.resolve(SetupAccessService);
  const input = SetupApplySchema.parse(await c.req.json());
  let result: { status: 'completed' };
  try {
    result = await access.withApplyLock(getCookie(c, SETUP_SESSION_COOKIE), () =>
      container.resolve(SetupWizardService).apply(input, container.resolve(LoggingRuntimeService))
    );
  } catch (error) {
    if (error instanceof SetupApplyInProgressError) {
      throw new AppError(409, 'SETUP_APPLY_IN_PROGRESS', 'Gateway setup is already being applied');
    }
    throw error;
  }
  const transport = await container.resolve(WebTransportSettingsService).getConfig();
  if (transport.tlsEnabled) container.resolve(RuntimeRestartService).request('first-run web identity updated', 1_000);
  return c.json({ data: { ...result, restartRequired: transport.tlsEnabled } });
});
