import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { authMiddleware, sessionOnly } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { UIBootstrapService } from './ui-bootstrap.service.js';

export const uiBootstrapRoutes = new OpenAPIHono<AppEnv>();

uiBootstrapRoutes.use('*', authMiddleware);
uiBootstrapRoutes.use('*', sessionOnly);

/** Safe GET avoids an initial CSRF round-trip before the application shell can render. */
uiBootstrapRoutes.get('/bootstrap', async (c) => {
  const user = c.get('user')!;
  const scopes = c.get('effectiveScopes') ?? user.scopes;
  return c.json({ data: await container.resolve(UIBootstrapService).getShell(user, scopes) });
});
