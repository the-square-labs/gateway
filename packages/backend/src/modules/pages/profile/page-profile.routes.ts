import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { UpdatePageProfileSchema } from './page-profile.schemas.js';
import { PageProfileService } from './page-profile.service.js';

const tags = ['Pages'];
export const pageProfileRoutes = new OpenAPIHono<AppEnv>();
pageProfileRoutes.use('*', authMiddleware);

pageProfileRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/profile',
      tags,
      summary: 'Get the global Pages wildcard profile',
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScope('pages:settings:view'),
  },
  async (c) => c.json({ data: await container.resolve(PageProfileService).get() })
);

pageProfileRoutes.openapi(
  {
    ...appRoute({
      method: 'get',
      path: '/options',
      tags,
      summary: 'List safe Pages wildcard profile options',
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScope('pages:settings:view'),
  },
  async (c) => c.json({ data: await container.resolve(PageProfileService).getOptions() })
);

pageProfileRoutes.openapi(
  {
    ...appRoute({
      method: 'put',
      path: '/profile',
      tags,
      summary: 'Configure or disable the global Pages wildcard profile',
      request: jsonBody(UpdatePageProfileSchema),
      responses: okJson(UnknownDataResponseSchema),
    }),
    middleware: requireScope('pages:settings:edit'),
  },
  async (c) => {
    const data = await container
      .resolve(PageProfileService)
      .configure(UpdatePageProfileSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  }
);
