import { describe, expect, it } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { pageManagementRouteRuntime } from './page-management-route-runtime.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

describe('Pages management route runtime', () => {
  it('answers a reserved Tag on a commercial router with the standard VALIDATION_ERROR', async () => {
    const { OpenAPIHono, appRoute, okJson, UnknownDataResponseSchema, PageTagParamSchema } = pageManagementRouteRuntime;
    // As the commercial edition creates its Pages router: from the runtime, without options.
    const routes = new OpenAPIHono<AppEnv>();
    routes.openapi(
      appRoute({
        method: 'delete',
        path: '/{projectId}/tags/{tag}',
        tags: ['Pages'],
        summary: 'Delete a Page Project Tag',
        request: { params: PageTagParamSchema },
        responses: okJson(UnknownDataResponseSchema),
      }),
      (c) => c.json({ success: true }, 200)
    );
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.route('/api/pages', routes);

    const response = await app.request(`/api/pages/${PROJECT_ID}/tags/latest`, { method: 'DELETE' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ path: 'tag', message: '`latest` is reserved' }],
    });
  });
});
