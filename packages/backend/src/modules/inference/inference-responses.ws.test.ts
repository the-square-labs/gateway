import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { consumeInferenceRateLimit } from './inference-limit.middleware.js';
import { InferenceProtocolService } from './inference-protocol.service.js';
import { createInferenceResponsesWSHandlers } from './inference-responses.ws.js';
import { InferenceRuntimeService } from './inference-runtime.service.js';
import { InferenceTokenService } from './inference-token.service.js';

vi.mock('./inference-limit.middleware.js', () => ({
  consumeInferenceRateLimit: vi.fn().mockResolvedValue({ limit: 100, remaining: 99 }),
  acquireInferenceConcurrency: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
}));

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'subject',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group',
  groupName: 'group',
  scopes: ['feat:ai:use'],
  isBlocked: false,
} satisfies User;

beforeEach(() => {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_12345678' }),
  } as unknown as InferenceTokenService);
});

afterEach(() => container.reset());

function websocket() {
  return { send: vi.fn(), close: vi.fn() };
}

describe('Responses WebSocket', () => {
  it('does not send a realtime session event when a Responses socket opens', async () => {
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });

    await handlers.onOpen?.({} as never, ws as never);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('closes an unauthenticated socket before accepting events', async () => {
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers(null);

    await handlers.onOpen?.({} as never, ws as never);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(JSON.parse(String(ws.send.mock.calls[0]?.[0]))).toMatchObject({
      type: 'error',
      error: { code: 'invalid_api_key' },
    });
  });

  it('streams Responses events through the configured runtime', async () => {
    const runtime = new InferenceRuntimeService();
    runtime.setExecutor({
      execute: vi.fn().mockResolvedValue({
        responseId: 'resp_1',
        resolvedModel: 'gateway-model',
        events: (async function* () {
          yield { type: 'reasoning.delta' as const, itemId: 'rs_1', delta: 'Think' };
          yield { type: 'item.done' as const, item: { type: 'reasoning' as const, id: 'rs_1', text: 'Think' } };
          yield { type: 'output_text.delta' as const, itemId: 'msg_1', delta: 'hello' };
          yield {
            type: 'item.done' as const,
            item: { type: 'message' as const, id: 'msg_1', role: 'assistant' as const, text: 'hello' },
          };
          yield {
            type: 'completed' as const,
            usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 1, totalTokens: 3 },
            finishReason: 'stop',
          };
        })(),
      }),
    });
    container.registerInstance(InferenceRuntimeService, runtime);
    const rememberWebSocket = vi.fn();
    container.registerInstance(InferenceProtocolService, {
      prepareWebSocket: vi.fn().mockImplementation(async (request, auth, signal, requestId) => ({
        request,
        userId: auth.user.id,
        affinityKey: request.promptCacheKey,
        context: {
          requestId,
          userId: auth.user.id,
          tokenId: auth.tokenId,
          affinityKey: request.promptCacheKey,
          signal,
        },
      })),
      rememberWebSocket,
    } as unknown as InferenceProtocolService);
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });
    await handlers.onOpen?.({} as never, ws as never);
    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gateway-model', input: 'Hi' } }) } as never,
      ws as never
    );

    const messages = ws.send.mock.calls.map(
      ([payload]) => JSON.parse(String(payload)) as { type: string; sequence_number?: number; response?: unknown }
    );
    expect(messages.map((message) => message.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(messages.map((message) => message.sequence_number)).toEqual(messages.map((_, index) => index));
    expect(messages.at(-1)).toMatchObject({
      response: {
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 1 },
          total_tokens: 3,
        },
      },
    });
    expect(rememberWebSocket).toHaveBeenCalledOnce();
  });

  it('adds a reasoning summary part before done when the upstream emits item.done only', async () => {
    const runtime = new InferenceRuntimeService();
    runtime.setExecutor({
      execute: vi.fn().mockResolvedValue({
        responseId: 'resp_reasoning_done',
        resolvedModel: 'gateway-model',
        events: (async function* () {
          yield { type: 'item.done' as const, item: { type: 'reasoning' as const, id: 'rs_done', text: 'Done' } };
          yield { type: 'completed' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
      }),
    });
    container.registerInstance(InferenceRuntimeService, runtime);
    container.registerInstance(InferenceProtocolService, protocolServiceStub());
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });

    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gateway-model', input: 'Hi' } }) } as never,
      ws as never
    );

    const types = ws.send.mock.calls.map(([payload]) => (JSON.parse(String(payload)) as { type: string }).type);
    expect(types.indexOf('response.reasoning_summary_part.added')).toBeGreaterThan(-1);
    expect(types.indexOf('response.reasoning_summary_part.added')).toBeLessThan(
      types.indexOf('response.reasoning_summary_part.done')
    );
  });

  it('emits one sequenced response.cancelled terminal event for client cancellation', async () => {
    const runtime = new InferenceRuntimeService();
    runtime.setExecutor({
      execute: vi.fn().mockImplementation(async (_request, context) => ({
        responseId: 'resp_cancel',
        resolvedModel: 'gateway-model',
        events: (async function* () {
          await new Promise<never>((_resolve, reject) => {
            if (context.signal.aborted) reject(context.signal.reason);
            else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          });
        })(),
      })),
    });
    container.registerInstance(InferenceRuntimeService, runtime);
    container.registerInstance(InferenceProtocolService, protocolServiceStub());
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });

    const creating = handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gateway-model', input: 'Hi' } }) } as never,
      ws as never
    );
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    await handlers.onMessage?.({ data: JSON.stringify({ type: 'response.cancel' }) } as never, ws as never);
    await creating;

    const messages = ws.send.mock.calls.map(
      ([payload]) =>
        JSON.parse(String(payload)) as { type: string; sequence_number?: number; response?: { status?: string } }
    );
    const cancelled = messages.filter((message) => message.type === 'response.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ sequence_number: 2, response: { status: 'cancelled' } });
    expect(messages.some((message) => message.type === 'error')).toBe(false);
  });

  it('completes generate=false prewarm without invoking an upstream model', async () => {
    const runtime = new InferenceRuntimeService();
    const execute = vi.fn().mockResolvedValue({
      responseId: 'resp_real',
      resolvedModel: 'gateway-model',
      events: (async function* () {
        yield { type: 'completed' as const, usage: { totalTokens: 2 }, finishReason: 'stop' };
      })(),
    });
    runtime.setExecutor({ execute });
    container.registerInstance(InferenceRuntimeService, runtime);
    const prepareWebSocket = vi.fn().mockImplementation(async (request, auth, signal, requestId) => ({
      request,
      userId: auth.user.id,
      affinityKey: request.promptCacheKey,
      context: {
        requestId,
        userId: auth.user.id,
        tokenId: auth.tokenId,
        affinityKey: request.promptCacheKey,
        signal,
      },
    }));
    const rememberWebSocket = vi.fn();
    container.registerInstance(InferenceProtocolService, {
      prepareWebSocket,
      rememberWebSocket,
    } as unknown as InferenceProtocolService);
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });

    await handlers.onMessage?.(
      {
        data: JSON.stringify({
          type: 'response.create',
          model: 'gateway-model',
          input: 'Hi',
          stream: true,
          generate: false,
        }),
      } as never,
      ws as never
    );

    const messages = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>);
    expect(messages.map((message) => message.type)).toEqual(['response.created', 'response.completed']);
    expect(prepareWebSocket).toHaveBeenCalledOnce();
    expect(prepareWebSocket.mock.calls[0]?.[0]).not.toHaveProperty('extensions.type');
    expect(prepareWebSocket.mock.calls[0]?.[0]).not.toHaveProperty('extensions.generate');
    expect(rememberWebSocket).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();

    const warmupResponse = messages[0]?.response as { id: string };
    expect(warmupResponse.id).toMatch(/^resp_/);
    await handlers.onMessage?.(
      {
        data: JSON.stringify({
          type: 'response.create',
          model: 'gateway-model',
          previous_response_id: warmupResponse.id,
          input: [],
          stream: true,
        }),
      } as never,
      ws as never
    );

    expect(prepareWebSocket.mock.calls[1]?.[0]).toMatchObject({ previousResponseId: warmupResponse.id });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      ws.send.mock.calls.slice(2).map(([payload]) => (JSON.parse(String(payload)) as { type: string }).type)
    ).toEqual(['response.created', 'response.in_progress', 'response.completed']);
  });

  it('returns Codex-compatible websocket errors with an HTTP status', async () => {
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });

    await handlers.onMessage?.({ data: JSON.stringify({ type: 'unsupported' }) } as never, ws as never);

    expect(JSON.parse(String(ws.send.mock.calls[0]?.[0]))).toEqual({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'Unsupported WebSocket event',
      },
    });
  });

  it('rate limits malformed messages before JSON parsing', async () => {
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });

    await handlers.onMessage?.({ data: '{' } as never, ws as never);

    expect(consumeInferenceRateLimit).toHaveBeenCalled();
    expect(JSON.parse(String(ws.send.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: 'invalid_request_error' },
    });
  });

  it('closes oversized messages before decoding', async () => {
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers(
      {
        user: USER,
        tokenId: 'token-1',
        tokenPrefix: 'gwi_12345678',
        rawToken: 'gwi_test',
      },
      8
    );

    await handlers.onMessage?.({ data: '123456789' } as never, ws as never);

    expect(ws.close).toHaveBeenCalledWith(1009, 'Message too large');
  });

  it('revalidates the inference token before every new response', async () => {
    const validateToken = vi.fn().mockResolvedValue(null);
    container.registerInstance(InferenceTokenService, { validateToken } as unknown as InferenceTokenService);
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_revoked',
    });

    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gateway-model', input: 'Hi' } }) } as never,
      ws as never
    );

    expect(validateToken).toHaveBeenCalledWith('gwi_revoked');
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(JSON.parse(String(ws.send.mock.calls.at(-1)?.[0]))).toMatchObject({ error: { code: 'invalid_api_key' } });
  });

  it('cancels an active response and closes when the account is deleted', async () => {
    const runtime = new InferenceRuntimeService();
    runtime.setExecutor({
      execute: vi.fn().mockImplementation(async (_request, context) => ({
        responseId: 'resp_deleted',
        resolvedModel: 'gateway-model',
        events: (async function* () {
          await new Promise<never>((_resolve, reject) => {
            if (context.signal.aborted) reject(context.signal.reason);
            else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          });
        })(),
      })),
    });
    const eventBus = new EventBusService();
    container.registerInstance(InferenceRuntimeService, runtime);
    container.registerInstance(InferenceProtocolService, protocolServiceStub());
    container.registerInstance(EventBusService, eventBus);
    const ws = websocket();
    const handlers = createInferenceResponsesWSHandlers({
      user: USER,
      tokenId: 'token-1',
      tokenPrefix: 'gwi_12345678',
      rawToken: 'gwi_test',
    });
    await handlers.onOpen?.({} as never, ws as never);

    const creating = handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gateway-model', input: 'Hi' } }) } as never,
      ws as never
    );
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    eventBus.publish(`permissions.changed.${USER.id}`, { reason: 'user_deleted', scopes: [], groupId: null });
    await creating;

    expect(ws.close).toHaveBeenCalledWith(1008, 'Access revoked');
    const messages = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as { type: string });
    expect(messages.filter((message) => message.type === 'response.cancelled')).toHaveLength(1);
  });
});

function protocolServiceStub(): InferenceProtocolService {
  return {
    prepareWebSocket: vi.fn().mockImplementation(async (request, auth, signal, requestId) => ({
      request,
      userId: auth.user.id,
      affinityKey: request.promptCacheKey,
      context: {
        requestId,
        userId: auth.user.id,
        tokenId: auth.tokenId,
        affinityKey: request.promptCacheKey,
        signal,
      },
    })),
    rememberWebSocket: vi.fn(),
  } as unknown as InferenceProtocolService;
}
