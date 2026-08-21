import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0'.repeat(64);

import Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import OpenAI from 'openai7';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { InferenceCoreProxyService } from './core/inference-core-proxy.service.js';
import { inferenceDataPlaneRoutes } from './inference-data-plane.routes.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  isBlocked: false,
};

const PUBLIC_MODEL = {
  id: 'model-1',
  publicId: 'gateway-model',
  enabled: true,
  subscriptionMultiplier: '1',
  reasoningEfforts: [],
  defaultReasoningEffort: null,
};

const MODEL_LIST_ROW = {
  id: 'gateway-model',
  object: 'model',
  created: 1,
  owned_by: 'gateway',
  display_name: 'Gateway Model',
  context_window: 100_000,
  max_input_tokens: 80_000,
  max_output_tokens: 20_000,
  auto_compact_token_limit: 90_000,
  input_modalities: ['text'],
  capabilities: {},
  supported_reasoning_efforts: [],
  default_reasoning_effort: null,
  supported_service_tiers: [],
};

const SOURCE = {
  id: 'source-1',
  connectionId: 'conn-1',
  enabled: true,
  sourceType: 'api',
  subscriptionMultiplierOverride: null,
  coreAccountId: 'core-conn-1',
  coreModelId: 'core-conn-1/gpt-5.5',
  upstreamModelId: 'gpt-5.5',
  reasoningEffortMap: {},
  priority: 0,
};

const CONNECTION = {
  id: 'conn-1',
  providerId: 'openai-apikey',
  enabled: true,
  deletedAt: null,
  routingOrder: 0,
  apiMonthlyLimitMicrodollars: null,
};

function selectChain(rows: unknown[]) {
  const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin', 'limit', 'groupBy']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

const RESPONSES_SSE = [
  'data: {"type":"response.created","response":{"id":"resp_1","model":"core-conn-1/gpt-5.5","status":"in_progress"}}',
  'data: {"type":"response.output_text.delta","item_id":"item_1","delta":"Hello"}',
  'data: {"type":"response.completed","response":{"id":"resp_1","model":"core-conn-1/gpt-5.5","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
  '',
].join('\n\n');

const CHAT_JSON = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'core-conn-1/gpt-5.5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const MESSAGES_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","model":"core-conn-1/claude","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

const COUNT_TOKENS_JSON = JSON.stringify({ input_tokens: 42 });

function coreResponseFor(path: string): Response {
  if (path.endsWith('/chat/completions')) {
    return new Response(CHAT_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path.endsWith('/messages/count_tokens')) {
    return new Response(COUNT_TOKENS_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path.endsWith('/messages')) {
    if (path.includes('stream')) {
      return new Response(MESSAGES_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'core-conn-1/claude',
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return new Response(RESPONSES_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function buildApp() {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_a' }),
  } as unknown as InferenceTokenService);
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
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
  } as never);
  container.registerInstance(InferenceModelService, {
    listForUser: vi.fn().mockResolvedValue({ object: 'list', data: [MODEL_LIST_ROW] }),
    resolveForUser: vi.fn().mockResolvedValue({ model: PUBLIC_MODEL, sources: [SOURCE] }),
  } as unknown as InferenceModelService);
  const db = {
    select: vi.fn().mockReturnValue(selectChain([{ source: SOURCE, connection: CONNECTION }])),
    query: { inferencePricingSnapshots: { findFirst: vi.fn().mockResolvedValue(null) } },
  };
  const routing = { select: vi.fn().mockResolvedValue({ connectionId: 'conn-1', providerId: 'openai-apikey' }) };
  const bridge = {
    dataPlaneTarget: vi.fn().mockResolvedValue({ baseUrl: 'http://inference-core:10100', credential: 'ocx_data' }),
  };
  const coreAccounting = {
    createCoreRequest: vi.fn().mockResolvedValue({ requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    finalizeCoreRequest: vi.fn().mockResolvedValue(undefined),
  };
  const proxy = new InferenceCoreProxyService(
    db as never,
    bridge as never,
    container.resolve(InferenceModelService),
    routing as never,
    coreAccounting as never,
    {} as never
  );
  container.registerInstance(InferenceCoreProxyService, proxy);
  const app = new Hono<AppEnv>();
  app.route('/api/inference/v1', inferenceDataPlaneRoutes);
  return app;
}

/** Route SDK HTTP calls into the Hono app without opening a socket. */
function appFetch(app: Hono<AppEnv>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return app.fetch(request);
  }) as typeof fetch;
}

afterEach(() => {
  container.reset();
  vi.unstubAllGlobals();
});

describe('official client adapters against the core proxy data plane', () => {
  it('serves models, chat completions, and streamed responses to the OpenAI SDK', async () => {
    const app = buildApp();
    const coreFetch = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(coreResponseFor(url));
    });
    vi.stubGlobal('fetch', coreFetch);
    const client = new OpenAI({
      apiKey: 'gwi_a.token',
      baseURL: 'http://gateway.test/api/inference/v1',
      fetch: appFetch(app),
    });

    const models = await client.models.list();
    expect(models.data.map((model) => model.id)).toEqual(['gateway-model']);

    const completion = await client.chat.completions.create({
      model: 'gateway-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(completion.choices[0]?.message.content).toBe('Hi');
    const chatCoreBody = JSON.parse(((coreFetch.mock.calls[0]?.[1] as RequestInit)?.body as string) ?? '{}');
    void chatCoreBody;

    const stream = await client.responses.create({ model: 'gateway-model', input: 'hi', stream: true });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta;
    }
    expect(text).toBe('Hello');
  });

  it('serves messages, streaming, and count_tokens to the Anthropic SDK', async () => {
    const app = buildApp();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        return Promise.resolve(coreResponseFor(url));
      })
    );
    // The Anthropic SDK appends its own /v1 segment.
    const client = new Anthropic({
      apiKey: 'gwi_a.token',
      baseURL: 'http://gateway.test/api/inference',
      fetch: appFetch(app),
    });

    const counted = await client.messages.countTokens({
      model: 'gateway-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(counted.input_tokens).toBe(42);

    const message = await client.messages.create({
      model: 'gateway-model',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'Hi' });
  });
});
