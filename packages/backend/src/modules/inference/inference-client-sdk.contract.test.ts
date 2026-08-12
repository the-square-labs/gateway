import 'reflect-metadata';
import Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import OpenAI from 'openai7';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { AppEnv, User } from '@/types.js';
import { anthropicInferenceDataPlaneRoutes, openAiInferenceDataPlaneRoutes } from './inference-data-plane.routes.js';
import { InferenceProtocolService } from './inference-protocol.service.js';
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
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

const MODEL = {
  id: 'gateway-model',
  object: 'model',
  created: 1,
  owned_by: 'gateway',
  display_name: 'Gateway Model',
  context_window: 128_000,
  max_input_tokens: 120_000,
  max_output_tokens: 8_000,
  auto_compact_token_limit: 100_000,
  input_modalities: ['text'],
  capabilities: { tools: true, reasoning: true },
  supported_reasoning_efforts: ['medium', 'high'],
  default_reasoning_effort: 'medium',
};
const CLAUDE_MODEL_ALIAS = 'claude-gateway-Z2F0ZXdheS1tb2RlbA';

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

function createSdkApp() {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_contract' }),
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
  container.registerInstance(InferenceModelService, {
    listForUser: vi.fn().mockResolvedValue({ object: 'list', data: [MODEL] }),
  } as unknown as InferenceModelService);
  container.registerInstance(InferenceProtocolService, {
    responses: async (c: any) => {
      const input = await c.req.json();
      const response = openAiResponse();
      if (!input.stream) return c.json(response);
      return sse(c, [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress' } }],
        [
          'response.output_text.delta',
          { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
        ],
        ['response.completed', { type: 'response.completed', response }],
      ]);
    },
    chatCompletions: (c: any) =>
      c.json({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: 1,
        model: MODEL.id,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    messages: async (c: any) => {
      const input = await c.req.json();
      const message = anthropicMessage();
      if (!input.stream) return c.json(message);
      return sse(c, [
        [
          'message_start',
          {
            type: 'message_start',
            message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        ],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ]);
    },
    countMessageTokens: (c: any) => c.json({ input_tokens: 3 }),
  } as unknown as InferenceProtocolService);

  const app = new Hono<AppEnv>();
  app.route('/api/inference/v1', openAiInferenceDataPlaneRoutes);
  app.route('/api/inference/anthropic/v1', anthropicInferenceDataPlaneRoutes);
  const fetch = (input: string | URL | Request, init?: RequestInit) => app.fetch(new Request(input, init));
  return { app, fetch: fetch as typeof globalThis.fetch };
}

describe('official client adapter contracts', () => {
  it('deserializes models, Chat Completions, and streamed Responses with OpenAI 7', async () => {
    const { fetch } = createSdkApp();
    const rawModels = await fetch('http://gateway.test/api/inference/v1/models', {
      headers: { Authorization: 'Bearer gwi_contract-test' },
    });
    expect(await rawModels.json()).toMatchObject({ data: [{ id: MODEL.id }] });
    const client = new OpenAI({
      apiKey: 'gwi_contract-test',
      baseURL: 'http://gateway.test/api/inference/v1',
      fetch,
    });

    const models = await client.models.list();
    const chat = await client.chat.completions.create({
      model: MODEL.id,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const stream = await client.responses.create({ model: MODEL.id, input: 'hello', stream: true });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(models.data.map((model) => model.id)).toEqual([MODEL.id]);
    expect(chat.choices[0]?.message.content).toBe('ok');
    expect(events).toContain('response.output_text.delta');
    expect(events.at(-1)).toBe('response.completed');
  });

  it('deserializes models, Messages, Count Tokens, and streaming with the Anthropic SDK', async () => {
    const { fetch } = createSdkApp();
    const rawModels = await fetch('http://gateway.test/api/inference/anthropic/v1/models', {
      headers: { 'x-api-key': 'gwi_contract-test' },
    });
    expect(await rawModels.json()).toMatchObject({ data: [{ id: CLAUDE_MODEL_ALIAS }] });
    const client = new Anthropic({
      apiKey: 'gwi_contract-test',
      baseURL: 'http://gateway.test/api/inference/anthropic',
      fetch,
    });

    const models = await client.models.list();
    const message = await client.messages.create({
      model: CLAUDE_MODEL_ALIAS,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const count = await client.messages.countTokens({
      model: CLAUDE_MODEL_ALIAS,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const stream = await client.messages.create({
      model: CLAUDE_MODEL_ALIAS,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(models.data.map((model) => model.id)).toEqual([CLAUDE_MODEL_ALIAS]);
    expect(message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(count.input_tokens).toBe(3);
    expect(events).toContain('content_block_delta');
    expect(events.at(-1)).toBe('message_stop');
  });
});

function openAiResponse() {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: MODEL.id,
    output: [
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: 'medium', summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    user: null,
    metadata: {},
  };
}

function anthropicMessage() {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: MODEL.id,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function sse(c: any, events: Array<[string, unknown]>) {
  c.header('Content-Type', 'text/event-stream');
  return c.body(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}
