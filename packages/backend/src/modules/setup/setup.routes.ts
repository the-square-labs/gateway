import { createHmac, timingSafeEqual } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { getEnv } from '@/config/env.js';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import type { AppEnv } from '@/types.js';
import {
  setupCompleteRoute,
  setupEnrollNodeRoute,
  setupManagementSslRoute,
  setupManagementSslUploadRoute,
} from './setup.docs.js';
import { SetupService } from './setup.service.js';
import { SetupTokenPolicyService } from './setup-token-policy.js';

const logger = createChildLogger('SetupRoutes');

export const setupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

function verifySetupToken(authHeader: string | undefined): boolean {
  const env = getEnv();
  if (!env.SETUP_TOKEN) return false;
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  if (!token) return false;
  try {
    const a = createHmac('sha256', 'setup-token-verify').update(token).digest();
    const b = createHmac('sha256', 'setup-token-verify').update(env.SETUP_TOKEN).digest();
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function setupApiDisabledResponse(c: Context<AppEnv>): Promise<Response | null> {
  const policy = container.resolve(SetupTokenPolicyService);
  const enabled = await policy.isSetupApiEnabled();
  if (enabled) return null;

  const path = new URL(c.req.url).pathname;
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

/**
 * POST /api/setup/management-ssl
 *
 * Bootstrap the management domain with ACME SSL.
 * Protected by SETUP_TOKEN (not session auth).
 * Idempotent — safe to call multiple times.
 */
setupRoutes.openapi(setupManagementSslRoute, async (c) => {
  if (!verifySetupToken(c.req.header('Authorization'))) {
    throw new AppError(401, 'SETUP_TOKEN_INVALID', 'Invalid or missing setup token');
  }

  const body = await c.req.json<{ domain: string }>();
  if (!body.domain || typeof body.domain !== 'string') {
    throw new AppError(400, 'DOMAIN_REQUIRED', 'Missing domain');
  }

  const domain = body.domain.toLowerCase().trim();
  if (domain === 'localhost' || !domain.includes('.')) {
    throw new AppError(400, 'INVALID_DOMAIN', 'Must be a fully qualified domain name');
  }

  const env = getEnv();
  const provider = env.ACME_STAGING ? 'letsencrypt-staging' : 'letsencrypt';

  try {
    const setupService = container.resolve(SetupService);
    const result = await setupService.bootstrapManagementSSL(domain, provider);
    logger.info('Management SSL bootstrap successful', result);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Management SSL bootstrap failed', { domain, error: message });
    throw new AppError(500, 'SETUP_MANAGEMENT_SSL_FAILED', message);
  }
});

/**
 * POST /api/setup/enroll-node
 *
 * Create a node and return an enrollment token plus Gateway gRPC TLS fingerprint during initial setup.
 * Protected by SETUP_TOKEN (not session auth).
 * Used by install.sh to auto-enroll the local daemon.
 */
setupRoutes.openapi(setupEnrollNodeRoute, async (c) => {
  if (!verifySetupToken(c.req.header('Authorization'))) {
    throw new AppError(401, 'SETUP_TOKEN_INVALID', 'Invalid or missing setup token');
  }

  const body = await c.req.json<{ type?: string; hostname?: string }>();
  const validTypes = ['nginx', 'bastion', 'monitoring', 'docker', 'databases'] as const;
  const type = validTypes.includes(body.type as any) ? (body.type as (typeof validTypes)[number]) : 'nginx';
  const hostname = body.hostname || 'localhost';

  try {
    const nodesService = container.resolve(NodesService);
    const result = await nodesService.create({ type, hostname }, '00000000-0000-0000-0000-000000000000');
    return c.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Node enrollment via setup token failed', { error: message });
    throw new AppError(500, 'SETUP_ENROLL_NODE_FAILED', message);
  }
});

/**
 * POST /api/setup/management-ssl-upload
 *
 * Bootstrap with a BYO (bring-your-own) certificate.
 * Accepts PEM cert + key directly.
 */
setupRoutes.openapi(setupManagementSslUploadRoute, async (c) => {
  if (!verifySetupToken(c.req.header('Authorization'))) {
    throw new AppError(401, 'SETUP_TOKEN_INVALID', 'Invalid or missing setup token');
  }

  const body = await c.req.json<{
    domain: string;
    certificatePem: string;
    privateKeyPem: string;
    chainPem?: string;
  }>();

  if (!body.domain || !body.certificatePem || !body.privateKeyPem) {
    throw new AppError(400, 'SETUP_CERT_INPUT_REQUIRED', 'Missing domain, certificatePem, or privateKeyPem');
  }

  const domain = body.domain.toLowerCase().trim();
  if (domain === 'localhost' || !domain.includes('.')) {
    throw new AppError(400, 'INVALID_DOMAIN', 'Must be a fully qualified domain name');
  }

  try {
    const setupService = container.resolve(SetupService);
    const result = await setupService.bootstrapManagementSSLUpload(
      domain,
      body.certificatePem,
      body.privateKeyPem,
      body.chainPem
    );
    logger.info('Management SSL (BYO cert) bootstrap successful', result);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Management SSL (BYO cert) bootstrap failed', { domain, error: message });
    throw new AppError(500, 'SETUP_MANAGEMENT_SSL_UPLOAD_FAILED', message);
  }
});

/**
 * POST /api/setup/complete
 *
 * Mark setup complete once the installer finishes its bootstrap work.
 * Protected by SETUP_TOKEN (not session auth).
 */
setupRoutes.openapi(setupCompleteRoute, async (c) => {
  if (!verifySetupToken(c.req.header('Authorization'))) {
    throw new AppError(401, 'SETUP_TOKEN_INVALID', 'Invalid or missing setup token');
  }

  const policy = container.resolve(SetupTokenPolicyService);
  await policy.markSetupComplete();
  return c.json({ data: { status: 'completed' } });
});
