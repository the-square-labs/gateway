import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { AppEnv, User } from '@/types.js';
import {
  anthropicInferenceDataPlaneRoutes,
  codexInferenceDataPlaneRoutes,
  openAiInferenceDataPlaneRoutes,
} from './inference-data-plane.routes.js';
import { InferenceProtocolService } from './inference-protocol.service.js';
import { InferenceRuntimeService } from './inference-runtime.service.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-users',
  scopes: ['inference:use'],
  isBlocked: false,
};

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
  process.env.OIDC_CLIENT_ID ||= 'test';
  process.env.OIDC_CLIENT_SECRET ||= 'test';
  process.env.OIDC_REDIRECT_URI ||= 'http://localhost/auth/callback';
  process.env.PKI_MASTER_KEY ||= '00'.repeat(32);
});

afterEach(() => container.reset());

function appWithCredential(result: unknown) {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue(result),
  } as unknown as InferenceTokenService);
  const pipeline = {
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    zadd: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn().mockResolvedValue([
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 1],
    ]),
  };
  container.registerInstance(TOKENS.RedisClient, {
    pipeline: vi.fn().mockReturnValue(pipeline),
    eval: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    decr: vi.fn().mockResolvedValue(0),
    del: vi.fn().mockResolvedValue(1),
  } as never);
  container.registerInstance(
    InferenceProtocolService,
    new InferenceProtocolService(new InferenceRuntimeService(), {
      load: vi.fn().mockResolvedValue({ status: 'missing' }),
      remember: vi.fn().mockResolvedValue(undefined),
    } as never)
  );
  container.registerInstance(InferenceModelService, {
    listForUser: vi.fn().mockResolvedValue({ object: 'list', data: [] }),
  } as unknown as InferenceModelService);
  const app = new Hono<AppEnv>();
  app.route('/api/inference/v1', openAiInferenceDataPlaneRoutes);
  app.route('/api/inference/codex/v1', codexInferenceDataPlaneRoutes);
  app.route('/api/inference/anthropic/v1', anthropicInferenceDataPlaneRoutes);
  return app;
}

describe('inference data-plane boundary', () => {
  it('accepts dedicated Bearer and Anthropic x-api-key credentials', async () => {
    const app = appWithCredential({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_12345678' });

    const openAi = await app.request('/api/inference/v1/models', {
      headers: { Authorization: 'Bearer gwi_test' },
    });
    const anthropic = await app.request('/api/inference/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'gwi_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude', max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] }),
    });

    expect(openAi.status).toBe(200);
    expect(await openAi.json()).toEqual({ object: 'list', data: [] });
    expect(anthropic.status).toBe(503);
    expect(await anthropic.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
  });

  it('rejects cookies, ordinary API tokens, and conflicting auth headers before Redis admission', async () => {
    const app = appWithCredential(null);

    const headerCases: Array<Record<string, string>> = [
      { Cookie: 'session_id=session-1' },
      { Authorization: 'Bearer gw_existing' },
      { Authorization: 'Bearer gwi_one', 'x-api-key': 'gwi_two' },
    ];
    for (const headers of headerCases) {
      const response = await app.request('/api/inference/v1/models', { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_api_key' } });
    }
  });

  it('returns a protocol-shaped 404 for unknown inference paths', async () => {
    const app = appWithCredential({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_12345678' });
    const response = await app.request('/api/inference/v1/unknown', {
      headers: { Authorization: 'Bearer gwi_test' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns only public technical model metadata', async () => {
    const app = appWithCredential({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_12345678' });
    container.registerInstance(InferenceModelService, {
      listForUser: vi.fn().mockResolvedValue({
        object: 'list',
        data: [
          {
            id: 'kimi-k3',
            object: 'model',
            created: 1,
            owned_by: 'gateway',
            display_name: 'Kimi K3',
            context_window: 256_000,
            max_input_tokens: 240_000,
            max_output_tokens: 16_000,
            auto_compact_token_limit: 220_000,
            input_modalities: ['text'],
            capabilities: { tools: true, reasoning: true },
            supported_reasoning_efforts: ['high', 'ultra'],
            default_reasoning_effort: 'high',
          },
        ],
      }),
    } as unknown as InferenceModelService);

    const response = await app.request('/api/inference/v1/models', {
      headers: { Authorization: 'Bearer gwi_test' },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('auto_compact_token_limit');
    expect(text).not.toMatch(/pricing|quota|multiplier|connection|account/i);
  });

  it('projects separate Codex and Anthropic model catalog contracts', async () => {
    const app = appWithCredential({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_12345678' });
    container.registerInstance(InferenceModelService, {
      listForUser: vi.fn().mockResolvedValue({
        object: 'list',
        data: [
          {
            id: 'kimi-k3',
            object: 'model',
            created: 1,
            owned_by: 'gateway',
            display_name: 'Kimi K3',
            context_window: 256_000,
            max_input_tokens: 240_000,
            max_output_tokens: 16_000,
            auto_compact_token_limit: 220_000,
            input_modalities: ['text', 'image'],
            capabilities: { tools: true, reasoning: true },
            supported_reasoning_efforts: ['high', 'ultra'],
            default_reasoning_effort: 'high',
          },
        ],
      }),
    } as unknown as InferenceModelService);

    const codex = await app.request('/api/inference/codex/v1/models?client_version=0.145.0', {
      headers: { Authorization: 'Bearer gwi_test' },
    });
    const codexBody = (await codex.json()) as any;
    expect(codex.status).toBe(200);
    expect(codex.headers.get('etag')).toMatch(/^".+"$/);
    expect(codexBody).not.toHaveProperty('data');
    expect(codexBody.models[0]).toMatchObject({
      slug: 'kimi-k3',
      display_name: 'Kimi K3',
      visibility: 'list',
      context_window: 256_000,
      auto_compact_token_limit: 220_000,
      default_reasoning_level: 'high',
    });

    for (const clientVersion of ['0.144.9', 'not-a-version']) {
      const unsupported = await app.request(
        `/api/inference/codex/v1/models?client_version=${encodeURIComponent(clientVersion)}`,
        { headers: { Authorization: 'Bearer gwi_test' } }
      );
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({
        error: { code: 'unsupported_client_version' },
      });
    }

    const notModified = await app.request('/api/inference/codex/v1/models', {
      headers: { Authorization: 'Bearer gwi_test', 'If-None-Match': codex.headers.get('etag')! },
    });
    expect(notModified.status).toBe(304);

    const anthropic = await app.request('/api/inference/anthropic/v1/models', {
      headers: { 'x-api-key': 'gwi_test' },
    });
    expect(await anthropic.json()).toMatchObject({
      data: [
        {
          id: 'kimi-k3',
          type: 'model',
          max_input_tokens: 240_000,
          max_tokens: 16_000,
          capabilities: { image_input: true, thinking: true },
        },
      ],
      first_id: 'kimi-k3',
      last_id: 'kimi-k3',
      has_more: false,
    });
  });
});
