import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { AppEnv, User } from '@/types.js';
import type { InferenceContinuationService } from './inference-continuation.service.js';
import {
  anthropicInferenceDataPlaneRoutes,
  codexInferenceDataPlaneRoutes,
  openAiInferenceDataPlaneRoutes,
} from './inference-data-plane.routes.js';
import { InferenceProtocolService } from './inference-protocol.service.js';
import { InferenceRuntimeService } from './inference-runtime.service.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';
import { COMPACT_PROMPT, GATEWAY_COMPACTION_PREFIX, SUMMARY_PREFIX } from './protocol/inference-compaction.js';
import type {
  InferenceExecutionContext,
  InferenceExecutor,
  InferenceRequest,
  InferenceStreamEvent,
} from './protocol/inference-protocol.types.js';

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

async function* richEvents(): AsyncGenerator<InferenceStreamEvent> {
  yield { type: 'reasoning.delta', itemId: 'rs_1', delta: 'Think', signature: 'sig' };
  yield { type: 'item.done', item: { type: 'reasoning', id: 'rs_1', text: 'Think', signature: 'sig' } };
  yield { type: 'output_text.delta', itemId: 'msg_1', delta: 'Hello', phase: 'commentary' };
  yield {
    type: 'item.done',
    item: { type: 'message', id: 'msg_1', role: 'assistant', text: 'Hello', phase: 'commentary' },
  };
  yield { type: 'tool_call.delta', itemId: 'fc_1', callId: 'call_1', name: 'lookup', delta: '{"q":"x"}' };
  yield {
    type: 'item.done',
    item: { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
  };
  yield {
    type: 'completed',
    finishReason: 'tool_calls',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, reasoningTokens: 1 },
  };
}

function registerRuntime(
  executor: InferenceExecutor,
  continuations: Pick<InferenceContinuationService, 'load' | 'remember'> = {
    load: vi.fn().mockResolvedValue({ status: 'missing' }),
    remember: vi.fn().mockResolvedValue(undefined),
  } as never
) {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_12345678' }),
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
  const runtime = new InferenceRuntimeService();
  runtime.setExecutor(executor);
  container.registerInstance(InferenceProtocolService, new InferenceProtocolService(runtime, continuations as never));
  container.registerInstance(InferenceModelService, {
    listForUser: vi.fn().mockResolvedValue({ object: 'list', data: [] }),
  } as unknown as InferenceModelService);
  const app = new Hono<AppEnv>();
  app.route('/api/inference/v1', openAiInferenceDataPlaneRoutes);
  app.route('/api/inference/codex/v1', codexInferenceDataPlaneRoutes);
  app.route('/api/inference/anthropic/v1', anthropicInferenceDataPlaneRoutes);
  return app;
}

function jsonRequest(body: unknown) {
  return {
    method: 'POST',
    headers: { Authorization: 'Bearer gwi_test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('inference protocol routes', () => {
  it('returns a complete Responses object with reasoning, tools, and terminal usage', async () => {
    const remember = vi.fn().mockResolvedValue(undefined);
    const executor: InferenceExecutor = {
      execute: vi.fn().mockResolvedValue({
        responseId: 'resp_1',
        resolvedModel: 'wire-model',
        events: richEvents(),
        affinityKey: 'account-1',
      }),
    };
    const app = registerRuntime(executor, { load: vi.fn(), remember } as never);
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({ model: 'logical-model', input: 'Hello', stream: false })
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-models-etag')).toMatch(/^".+"$/);
    expect(body).toMatchObject({ id: 'resp_1', object: 'response', model: 'wire-model', status: 'completed' });
    expect(body.output.map((item: any) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(body.output[1]).toMatchObject({ phase: 'commentary' });
    expect(body.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 16,
    });
    expect(remember).toHaveBeenCalledWith(
      'resp_1',
      expect.objectContaining({ userId: USER.id, affinityKey: 'account-1' })
    );
  });

  it('streams the complete Codex reasoning-summary lifecycle', async () => {
    const app = registerRuntime({
      execute: vi
        .fn()
        .mockResolvedValue({ responseId: 'resp_reasoning', resolvedModel: 'wire-model', events: richEvents() }),
    });
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({
        model: 'logical-model',
        input: 'Hello',
        stream: true,
        reasoning: { effort: 'high', summary: 'auto' },
      })
    );
    const text = await response.text();

    expect(response.headers.get('x-reasoning-included')).toBe('true');
    expect(text).toContain('"type":"response.reasoning_summary_part.added"');
    expect(text).toContain('"type":"response.reasoning_summary_text.delta"');
    expect(text).toContain('"type":"response.reasoning_summary_text.done"');
    expect(text).toContain('"type":"response.reasoning_summary_part.done"');
    expect(text).toContain('"type":"response.in_progress"');
    expect(text).toContain('"phase":"commentary"');
    expect(text.indexOf('"type":"response.output_item.added"')).toBeLessThan(
      text.indexOf('"type":"response.reasoning_summary_part.added"')
    );
    expect(text.indexOf('"type":"response.reasoning_summary_part.added"')).toBeLessThan(
      text.indexOf('"type":"response.reasoning_summary_text.delta"')
    );
    expect(text.indexOf('"type":"response.reasoning_summary_text.done"')).toBeLessThan(
      text.indexOf('"type":"response.reasoning_summary_part.done"')
    );
    expect(text.indexOf('"type":"response.reasoning_summary_part.done"')).toBeLessThan(
      text.indexOf('"type":"response.output_item.done"')
    );
  });

  it('streams Codex custom tools with the custom input contract', async () => {
    async function* events(): AsyncGenerator<InferenceStreamEvent> {
      yield {
        type: 'tool_call.delta',
        itemId: 'ctc_1',
        callId: 'call_1',
        name: 'exec',
        delta: 'pwd',
        custom: true,
      };
      yield {
        type: 'item.done',
        item: {
          type: 'function_call',
          id: 'ctc_1',
          callId: 'call_1',
          name: 'exec',
          arguments: 'pwd',
          custom: true,
        },
      };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
    const app = registerRuntime({
      execute: vi.fn().mockResolvedValue({ responseId: 'resp_custom', resolvedModel: 'wire-model', events: events() }),
    });
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({
        model: 'logical-model',
        input: 'Run pwd',
        stream: true,
        tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }],
      })
    );
    const frames = (await response.text())
      .split('\n\n')
      .map((frame) =>
        frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6)
      )
      .filter((data): data is string => Boolean(data) && data !== '[DONE]')
      .map((data) => JSON.parse(data));
    const added = frames.find((frame) => frame.type === 'response.output_item.added');
    const done = frames.find((frame) => frame.type === 'response.output_item.done');

    expect(added.item).toMatchObject({
      type: 'custom_tool_call',
      id: 'ctc_1',
      call_id: 'call_1',
      name: 'exec',
      input: '',
      status: 'in_progress',
    });
    expect(added.item).not.toHaveProperty('arguments');
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'response.custom_tool_call_input.delta', delta: 'pwd' }),
        expect.objectContaining({ type: 'response.custom_tool_call_input.done', input: 'pwd' }),
      ])
    );
    expect(done.item).toMatchObject({ type: 'custom_tool_call', input: 'pwd', status: 'completed' });
  });

  it('emits conservative terminal usage when an upstream omits usage', async () => {
    async function* events(): AsyncGenerator<InferenceStreamEvent> {
      yield { type: 'output_text.delta', itemId: 'msg_1', delta: 'Estimated output' };
      yield {
        type: 'item.done',
        item: { type: 'message', id: 'msg_1', role: 'assistant', text: 'Estimated output' },
      };
    }
    const app = registerRuntime({
      execute: vi
        .fn()
        .mockResolvedValue({ responseId: 'resp_estimated', resolvedModel: 'wire-model', events: events() }),
    });
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({ model: 'logical-model', input: 'Input requiring estimation' })
    );
    const body = (await response.json()) as any;

    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  it('streams Chat Completions deltas and a terminal DONE marker', async () => {
    const app = registerRuntime({
      execute: vi.fn().mockResolvedValue({ responseId: 'resp_2', resolvedModel: 'wire-model', events: richEvents() }),
    });
    const response = await app.request(
      '/api/inference/v1/chat/completions',
      jsonRequest({ model: 'logical-model', stream: true, messages: [{ role: 'user', content: 'Hello' }] })
    );
    const text = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"reasoning_content":"Think"');
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('data: [DONE]');
  });

  it('supports Anthropic unary output and local count_tokens', async () => {
    const app = registerRuntime({
      execute: vi.fn().mockResolvedValue({ responseId: 'resp_3', resolvedModel: 'claude-wire', events: richEvents() }),
    });
    const message = await app.request(
      '/api/inference/anthropic/v1/messages',
      jsonRequest({ model: 'claude', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] })
    );
    const count = await app.request(
      '/api/inference/anthropic/v1/messages/count_tokens',
      jsonRequest({ model: 'claude', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] })
    );
    const messageBody = (await message.json()) as any;

    expect(messageBody.type).toBe('message');
    expect(messageBody.content.map((item: any) => item.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(await count.json()).toMatchObject({ input_tokens: expect.any(Number) });
  });

  it('resolves Claude Code aliases and carries supported gateway headers into execution', async () => {
    let executed: InferenceRequest | undefined;
    const app = registerRuntime({
      execute: vi.fn(async (request: InferenceRequest) => {
        executed = request;
        return { responseId: 'resp_alias', resolvedModel: request.model, events: richEvents() };
      }),
    });
    const response = await app.request('/api/inference/anthropic/v1/messages?beta=true', {
      ...jsonRequest({
        model: 'claude-gateway-a2ltaS1rMw',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: {
        ...jsonRequest({}).headers,
        'X-Claude-Code-Session-Id': 'session-1',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'context-management-2025-06-27',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.clone().json()).toMatchObject({ model: 'claude-gateway-a2ltaS1rMw' });
    expect(executed).toMatchObject({
      model: 'kimi-k3',
      promptCacheKey: 'session-1',
      providerHeaders: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'context-management-2025-06-27',
      },
    });
  });

  it('emits exactly one v2 compaction output item and builds v1 replacement history', async () => {
    let compactRequest: InferenceRequest | undefined;
    const executor: InferenceExecutor = {
      async execute(request) {
        compactRequest = request;
        async function* events(): AsyncGenerator<InferenceStreamEvent> {
          yield { type: 'output_text.delta', itemId: 'summary', delta: 'Checkpoint summary' };
          yield {
            type: 'item.done',
            item: { type: 'message', id: 'summary', role: 'assistant', text: 'Checkpoint summary' },
          };
          yield { type: 'completed', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } };
        }
        return { responseId: 'resp_compact', resolvedModel: 'wire-model', events: events(), affinityKey: 'account-1' };
      },
    };
    const app = registerRuntime(executor);
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Recent user turn' }] }];
    const v2 = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({ model: 'logical-model', stream: false, input: [...input, { type: 'compaction_trigger' }] })
    );
    const v1 = await app.request(
      '/api/inference/codex/v1/responses/compact',
      jsonRequest({ model: 'logical-model', input })
    );
    const v2Body = (await v2.json()) as any;
    const v1Body = (await v1.json()) as any;

    expect(v2Body.output).toHaveLength(1);
    expect(v2Body.output[0]).toMatchObject({ type: 'compaction' });
    expect(v2Body.output[0].encrypted_content.startsWith(GATEWAY_COMPACTION_PREFIX)).toBe(true);
    expect(compactRequest?.isCompaction).toBe(true);
    expect(compactRequest?.tools).toEqual([]);
    expect(compactRequest?.messages.at(-1)).toMatchObject({ content: [{ text: COMPACT_PROMPT }] });
    expect(v1Body.output.at(-1).content[0].text).toBe(`${SUMMARY_PREFIX}\nCheckpoint summary`);
  });

  it('streams v2 compaction with one terminal compaction output item', async () => {
    const executor: InferenceExecutor = {
      async execute(request) {
        async function* events(): AsyncGenerator<InferenceStreamEvent> {
          yield { type: 'output_text.delta', itemId: 'summary', delta: 'Streamed checkpoint' };
          yield {
            type: 'item.done',
            item: { type: 'message', id: 'summary', role: 'assistant', text: 'Streamed checkpoint' },
          };
          yield { type: 'completed', usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } };
        }
        return { responseId: 'resp_compact_stream', resolvedModel: request.model, events: events() };
      },
    };
    const app = registerRuntime(executor);
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({
        model: 'logical-model',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'History' }, { type: 'compaction_trigger' }],
      })
    );
    const text = await response.text();
    const completedLine = text
      .split('\n')
      .find((line) => line.startsWith('data: ') && line.includes('"type":"response.completed"'));
    const completed = JSON.parse(completedLine!.slice('data: '.length));

    expect(completed.response.output).toHaveLength(1);
    expect(completed.response.output[0].type).toBe('compaction');
  });

  it('expands previous_response_id with user isolation and preserved affinity', async () => {
    let executedRequest: InferenceRequest | undefined;
    let executedContext: InferenceExecutionContext | undefined;
    const executor: InferenceExecutor = {
      async execute(request, context) {
        executedRequest = request;
        executedContext = context;
        return {
          responseId: 'resp_next',
          resolvedModel: request.model,
          events: richEvents(),
          affinityKey: context.affinityKey,
        };
      },
    };
    const load = vi.fn().mockResolvedValue({
      status: 'found',
      payload: {
        userId: USER.id,
        model: 'logical-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Earlier' }] }],
        output: [{ type: 'message', id: 'old', role: 'assistant', text: 'Earlier answer' }],
        affinityKey: 'account-7',
      },
    });
    const app = registerRuntime(executor, { load, remember: vi.fn().mockResolvedValue(undefined) } as never);
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({ model: 'logical-model', previous_response_id: 'resp_old', input: 'Continue' })
    );

    expect(response.status).toBe(200);
    expect(executedRequest?.messages.map((message) => message.content[0])).toMatchObject([
      { text: 'Earlier' },
      { text: 'Earlier answer' },
      { text: 'Continue' },
    ]);
    expect(executedContext?.affinityKey).toBe('account-7');
  });

  it('returns a protocol 404 when continuation state is missing', async () => {
    const execute = vi.fn();
    const app = registerRuntime({ execute }, {
      load: vi.fn().mockResolvedValue({ status: 'missing' }),
      remember: vi.fn(),
    } as never);
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({ model: 'logical-model', previous_response_id: 'missing', input: 'Continue' })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'previous_response_not_found' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates downstream stream cancellation to the upstream execution signal', async () => {
    let signal: AbortSignal | undefined;
    let abortedResolve: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    const executor: InferenceExecutor = {
      async execute(_request, context) {
        signal = context.signal;
        async function* events(): AsyncGenerator<InferenceStreamEvent> {
          yield { type: 'output_text.delta', itemId: 'msg_1', delta: 'first' };
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          abortedResolve?.();
        }
        return { responseId: 'resp_cancel', resolvedModel: 'wire-model', events: events() };
      },
    };
    const app = registerRuntime(executor);
    const response = await app.request(
      '/api/inference/codex/v1/responses',
      jsonRequest({ model: 'logical-model', stream: true, input: 'Cancel me' })
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('client cancelled');
    await aborted;

    expect(signal?.aborted).toBe(true);
  });
});
