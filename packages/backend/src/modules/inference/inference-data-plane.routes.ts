import { createHash } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { inferenceAuthMiddleware } from './inference-auth.middleware.js';
import { claudeCodeModelAlias } from './inference-claude-code-models.js';
import { codexModelsResponse } from './inference-codex-models.js';
import { inferenceErrorResponse } from './inference-error.js';
import { InferenceExtendedService } from './inference-extended.service.js';
import { inferenceConcurrencyMiddleware, inferenceRateLimitMiddleware } from './inference-limit.middleware.js';
import { InferenceProtocolService, inferenceProtocolError } from './inference-protocol.service.js';
import { InferenceModelService } from './models/inference-model.service.js';

type Adapter = 'anthropic' | 'codex' | 'openai';
const MINIMUM_CODEX_CLIENT_VERSION = '0.145.0';

const KNOWN_PATHS: Record<Adapter, ReadonlySet<string>> = {
  openai: new Set([
    '/models',
    '/responses',
    '/chat/completions',
    '/images/generations',
    '/images/edits',
    '/alpha/search',
    '/live',
    '/realtime/calls',
  ]),
  codex: new Set(['/models', '/responses', '/responses/compact']),
  anthropic: new Set(['/models', '/messages', '/messages/count_tokens']),
};

function createAdapterRouter(adapter: Adapter) {
  const routes = new OpenAPIHono<AppEnv>();
  routes.onError((error, c) => {
    const protocolError = inferenceProtocolError(error);
    return inferenceErrorResponse(
      c,
      protocolError.status,
      protocolError.code,
      protocolError.message,
      protocolError.details
    );
  });
  routes.use('*', inferenceAuthMiddleware);
  routes.use('*', inferenceRateLimitMiddleware);
  routes.use('*', inferenceConcurrencyMiddleware);
  routes.use('*', async (c, next) => {
    c.header('X-Accel-Buffering', 'no');
    c.header(
      'Cache-Control',
      c.req.method === 'GET' && c.req.path.endsWith('/models') ? 'private, no-cache' : 'no-store'
    );
    c.set('inferenceAdapter', adapter);
    await next();
  });
  return routes;
}

export const openAiInferenceDataPlaneRoutes = createAdapterRouter('openai');
export const codexInferenceDataPlaneRoutes = createAdapterRouter('codex');
export const anthropicInferenceDataPlaneRoutes = createAdapterRouter('anthropic');

export async function codexCatalogForUser(user: NonNullable<AppEnv['Variables']['user']>) {
  const body = codexModelsResponse((await container.resolve(InferenceModelService).listForUser(user)).data);
  const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
  return { body, etag, version: etag.slice(1, -1) };
}

openAiInferenceDataPlaneRoutes.get('/models', async (c) => {
  const user = c.get('user');
  if (!user) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');
  return c.json(await container.resolve(InferenceModelService).listForUser(user));
});
openAiInferenceDataPlaneRoutes.post('/responses', (c) => container.resolve(InferenceProtocolService).responses(c));
openAiInferenceDataPlaneRoutes.post('/chat/completions', (c) =>
  container.resolve(InferenceProtocolService).chatCompletions(c)
);
openAiInferenceDataPlaneRoutes.post('/alpha/search', (c) => container.resolve(InferenceProtocolService).search(c));
openAiInferenceDataPlaneRoutes.post('/images/generations', (c) =>
  container.resolve(InferenceExtendedService).imageGenerations(c)
);
openAiInferenceDataPlaneRoutes.post('/images/edits', (c) => container.resolve(InferenceExtendedService).imageEdits(c));
openAiInferenceDataPlaneRoutes.post('/realtime/calls', (c) =>
  container.resolve(InferenceExtendedService).realtimeCall(c)
);
openAiInferenceDataPlaneRoutes.post('/live', (c) => container.resolve(InferenceExtendedService).realtimeCall(c));

codexInferenceDataPlaneRoutes.get('/models', async (c) => {
  const user = c.get('user');
  if (!user) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');
  const clientVersion = c.req.query('client_version');
  if (clientVersion && !isSupportedCodexClientVersion(clientVersion)) {
    return inferenceErrorResponse(
      c,
      400,
      'unsupported_client_version',
      `Codex ${clientVersion} is not supported; update to ${MINIMUM_CODEX_CLIENT_VERSION} or newer`,
      { minimumClientVersion: MINIMUM_CODEX_CLIENT_VERSION }
    );
  }
  const { body, etag } = await codexCatalogForUser(user);
  c.header('ETag', etag);
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
  return c.json(body);
});

function isSupportedCodexClientVersion(value: string): boolean {
  const parsed = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  const minimum = MINIMUM_CODEX_CLIENT_VERSION.split('.').map(Number);
  if (!parsed) return false;
  const current = parsed.slice(1, 4).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}
codexInferenceDataPlaneRoutes.use('/responses/*', async (c, next) => {
  const user = c.get('user');
  const etag = user ? (await codexCatalogForUser(user)).etag : null;
  await next();
  if (etag) c.res.headers.set('X-Models-Etag', etag);
});
codexInferenceDataPlaneRoutes.use('/responses', async (c, next) => {
  const user = c.get('user');
  const etag = user ? (await codexCatalogForUser(user)).etag : null;
  await next();
  if (etag) c.res.headers.set('X-Models-Etag', etag);
});
codexInferenceDataPlaneRoutes.post('/responses', (c) => container.resolve(InferenceProtocolService).responses(c));
codexInferenceDataPlaneRoutes.post('/responses/compact', (c) => container.resolve(InferenceProtocolService).compact(c));

anthropicInferenceDataPlaneRoutes.get('/models', async (c) => {
  const user = c.get('user');
  if (!user) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');
  const models = (await container.resolve(InferenceModelService).listForUser(user)).data;
  const data = models.map((model) => ({
    id: claudeCodeModelAlias(model.id),
    type: 'model' as const,
    display_name: model.display_name,
    created_at: new Date(model.created * 1000).toISOString(),
    max_input_tokens: model.max_input_tokens,
    max_tokens: model.max_output_tokens ?? null,
    capabilities: {
      image_input: model.input_modalities.includes('image'),
      thinking: model.capabilities.reasoning === true,
    },
  }));
  return c.json({ data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null });
});
anthropicInferenceDataPlaneRoutes.post('/messages', (c) => container.resolve(InferenceProtocolService).messages(c));
anthropicInferenceDataPlaneRoutes.post('/messages/count_tokens', (c) =>
  container.resolve(InferenceProtocolService).countMessageTokens(c)
);

for (const [adapter, routes] of [
  ['openai', openAiInferenceDataPlaneRoutes],
  ['codex', codexInferenceDataPlaneRoutes],
  ['anthropic', anthropicInferenceDataPlaneRoutes],
] as const) {
  routes.all('*', (c) => {
    const localPath = c.req.path.replace(`/api/inference/${adapter}/v1`, '') || '/';
    if (KNOWN_PATHS[adapter].has(localPath)) {
      return inferenceErrorResponse(
        c,
        503,
        'service_unavailable',
        'Inference is not configured yet; connect and publish a model first'
      );
    }
    return inferenceErrorResponse(c, 404, 'not_found', 'Inference endpoint not found');
  });
}
