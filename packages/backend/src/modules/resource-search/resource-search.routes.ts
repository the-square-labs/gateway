import { OpenAPIHono, z } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { appRoute, okJson, openApiValidationHook, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { authMiddleware, sessionOnly } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';

const ResourceSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  types: z.string().trim().max(500).optional(),
  nodeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

const searchResourcesRoute = appRoute({
  method: 'get',
  path: '/search',
  tags: ['Resources'],
  summary: 'Search readable Gateway resources',
  request: { query: ResourceSearchQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const resourceSearchRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: openApiValidationHook,
});

resourceSearchRoutes.use('*', authMiddleware);
resourceSearchRoutes.use('*', sessionOnly);

resourceSearchRoutes.openapi(searchResourcesRoute, async (c) => {
  const query = ResourceSearchQuerySchema.parse(c.req.query());
  const data = await container.resolve(AIService).searchResources(c.get('user')!, {
    query: query.q,
    types: query.types
      ?.split(',')
      .map((type) => type.trim())
      .filter(Boolean),
    nodeId: query.nodeId,
    limit: query.limit,
  });
  return c.json({ data });
});
