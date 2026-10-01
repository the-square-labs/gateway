import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { openApiValidationHook, optionalJsonBody } from '@/lib/openapi.js';
import type { AppEnv } from '@/types.js';
import { emptyJsonBodyMiddleware } from './empty-json-body.js';
import { errorHandler } from './error-handler.js';

function appWithOptionalBody() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.onError(errorHandler);
  app.use('*', emptyJsonBodyMiddleware);
  const route = createRoute({
    method: 'post',
    path: '/stop',
    request: optionalJsonBody(z.object({ timeout: z.number().int().optional() })),
    responses: { 200: { description: 'ok' } },
  });
  app.openapi(route, (c) => c.json({ body: c.req.valid('json') }, 200));
  return app;
}

const json = { 'Content-Type': 'application/json' };

describe('emptyJsonBodyMiddleware', () => {
  it('treats an empty JSON body as no body', async () => {
    const app = appWithOptionalBody();
    for (const headers of [json, { ...json, 'Content-Length': '0' }]) {
      const res = await app.request('/stop', { method: 'POST', headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: {} });
    }
  });

  it('still parses and validates a JSON body that is present', async () => {
    const app = appWithOptionalBody();
    const ok = await app.request('/stop', { method: 'POST', headers: json, body: '{"timeout":5}' });
    expect(await ok.json()).toEqual({ body: { timeout: 5 } });
    const malformed = await app.request('/stop', { method: 'POST', headers: json, body: '{' });
    expect(malformed.status).toBe(400);
    const invalid = await app.request('/stop', { method: 'POST', headers: json, body: '{"timeout":"x"}' });
    expect(invalid.status).toBe(400);
  });
});
