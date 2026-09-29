import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { PageProfileService } from './page-profile.service.js';

// The Pages settings routes (under /api/pages/settings) are how Pages gets turned on. The project and management
// routers mounted at /api/pages apply this guard to every path below it, so without this exception Pages could only be
// enabled while it was already enabled.
const PAGES_SETTINGS_PATH = '/api/pages/settings';

export const requirePagesEnabledForMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  const settings = path === PAGES_SETTINGS_PATH || path.startsWith(`${PAGES_SETTINGS_PATH}/`);
  if (!settings && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    await container.resolve(PageProfileService).requireEnabled();
  }
  await next();
};
