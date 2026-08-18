import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { PageProfileService } from './page-profile.service.js';

export const requirePagesEnabledForMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    await container.resolve(PageProfileService).requireEnabled();
  }
  await next();
};
