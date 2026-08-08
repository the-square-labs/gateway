import type { MiddlewareHandler } from 'hono';
import { logger } from '@/lib/logger.js';
import type { AppEnv } from '@/types.js';

const DOCKER_WEBHOOK_TOKEN_PATH = /^\/api\/webhooks\/docker\/[^/]+$/;

export function redactRequestPath(path: string): string {
  return DOCKER_WEBHOOK_TOKEN_PATH.test(path) ? '/api/webhooks/docker/[REDACTED]' : path;
}

export const loggerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  const requestId = c.get('requestId');
  const method = c.req.method;
  const path = redactRequestPath(c.req.path);

  logger.info('Incoming request', {
    requestId,
    method,
    path,
    userAgent: c.req.header('user-agent'),
  });

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  const logLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

  logger[logLevel]('Request completed', {
    requestId,
    method,
    path,
    status,
    duration: `${duration}ms`,
  });
};
