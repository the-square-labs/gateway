import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0'.repeat(64);

// In-memory upstream WebSocket: captures the constructor args and lets the
// test drive open/message/close events.
const upstreamInstances: Array<{
  url: string;
  options: { headers: Record<string, string> };
  sent: string[];
  handlers: Record<string, (...args: unknown[]) => void>;
  readyState: number;
  close: () => void;
}> = [];

vi.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    url: string;
    options: { headers: Record<string, string> };
    sent: string[] = [];
    handlers: Record<string, (...args: unknown[]) => void> = {};
    readyState = 1;
    constructor(url: string, options: { headers: Record<string, string> }) {
      this.url = url;
      this.options = options;
      upstreamInstances.push(this as never);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler;
    }
    send(frame: string) {
      this.sent.push(frame);
    }
    close() {
      this.readyState = 3;
    }
  }
  return { default: FakeWebSocket, OPEN: 1 };
});

import { container, TOKENS } from '@/container.js';
import { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { InferenceTokenService } from '../inference-token.service.js';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';
import { createCoreResponsesWSHandlers } from './inference-core-proxy.ws.js';

const USER = { id: '11111111-1111-4111-8111-111111111111', isBlocked: false, scopes: [] };

function registerCommon() {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue({ user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_a' }),
  } as never);
  const evalMock = vi.fn().mockResolvedValue(1);
  container.registerInstance(TOKENS.RedisClient, {
    pipeline: vi.fn().mockReturnValue({
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
    }),
    eval: evalMock,
  } as never);
  const proxy = {
    resolveTarget: vi.fn().mockResolvedValue({
      model: { id: 'model-1', publicId: 'gpt-5.5', reasoningEfforts: [], defaultReasoningEffort: null },
      selected: {
        source: {
          id: 'source-1',
          reasoningEffortMap: {},
          coreAccountId: 'core-conn-1',
          coreModelId: 'core-conn-1/gpt-5.5',
        },
        connection: { id: 'conn-1' },
      },
      upstreamModel: 'core-conn-1/gpt-5.5',
      coreAccountId: 'core-conn-1',
      candidateConnectionIds: ['conn-1'],
    }),
    dataPlaneTarget: vi.fn().mockResolvedValue({ baseUrl: 'http://inference-core:10100', credential: 'ocx_data' }),
  };
  container.registerInstance(InferenceCoreProxyService, proxy as never);
  const accounting = {
    createCoreRequest: vi.fn().mockResolvedValue({ requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    retargetCoreRequest: vi.fn().mockResolvedValue(undefined),
    finalizeCoreRequest: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(InferenceCoreAccountingService, accounting as never);
  return { proxy, accounting, evalMock };
}

function clientSocket() {
  return { send: vi.fn(), close: vi.fn() };
}

const AUTH = { user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_a', rawToken: 'gwi_a.token' } as never;

afterEach(() => {
  container.reset();
  upstreamInstances.length = 0;
});

describe('core responses websocket proxy', () => {
  it('proxies a turn with rewritten model and signed headers, then finalizes', async () => {
    const { accounting } = registerCommon();
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.5', input: 'hi' } }) } as never,
      ws as never
    );
    const upstream = upstreamInstances[0]!;
    expect(upstream.url).toBe('ws://inference-core:10100/v1/responses');
    expect(upstream.options.headers['x-opencodex-api-key']).toBe('ocx_data');
    expect(upstream.options.headers['x-wiolett-signature']).toBeTruthy();

    upstream.handlers.open?.();
    const frame = JSON.parse(upstream.sent[0]!);
    expect(frame.response.model).toBe('core-conn-1/gpt-5.5');

    upstream.handlers.message?.(JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi' }));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('output_text.delta'));

    upstream.handlers.message?.(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }));
    upstream.handlers.close?.();
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith('3fa85f64-5717-4562-b3fc-2c963f66afa6', 'completed');
  });

  it.each(['error', 'response.failed', 'response.incomplete'])('%s finalizes the request as failed', async (type) => {
    const { accounting } = registerCommon();
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.5', input: 'hi' } }) } as never,
      ws as never
    );
    const upstream = upstreamInstances[0]!;
    upstream.handlers.open?.();
    upstream.handlers.message?.(
      JSON.stringify(
        type === 'error'
          ? { type, status: 502, error: { code: 'upstream_server_error', message: 'failed' } }
          : { type, response: { id: 'resp_1', status: type.slice('response.'.length) } }
      )
    );
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'failed'
    );
  });

  it('rejects a second turn while one is active', async () => {
    registerCommon();
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    const message = { data: JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.5', input: 'hi' } }) };
    await handlers.onMessage?.(message as never, ws as never);
    await handlers.onMessage?.(message as never, ws as never);
    const errors = ws.send.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((frame) => frame.type === 'error');
    expect(errors.some((frame) => frame.status === 409)).toBe(true);
  });

  it('answers generate:false warmups without creating an accounting row', async () => {
    const { accounting } = registerCommon();
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', generate: false, model: 'gpt-5.5' }) } as never,
      ws as never
    );
    expect(upstreamInstances).toHaveLength(0);
    expect(accounting.createCoreRequest).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map((call) => JSON.parse(call[0] as string).type)).toEqual([
      'response.created',
      'response.completed',
    ]);
  });

  it('closes unauthorized connections', () => {
    registerCommon();
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(null);
    handlers.onOpen?.({} as never, ws as never);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });

  it('ends the turn on the terminal event: upstream closes, the lease releases, and the next turn is accepted', async () => {
    const { accounting, evalMock } = registerCommon();
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    const message = { data: JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.5', input: 'hi' } }) };
    await handlers.onMessage?.(message as never, ws as never);
    const first = upstreamInstances[0]!;
    first.handlers.open?.();
    // The concurrency lease is held for the whole turn: exactly one eval (acquire) so far.
    expect(evalMock).toHaveBeenCalledTimes(1);

    first.handlers.message?.(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }));
    // The proxy closes the per-turn upstream itself; the core never does.
    expect(first.readyState).toBe(3);
    first.handlers.close?.();
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith('3fa85f64-5717-4562-b3fc-2c963f66afa6', 'completed');
    // Turn end released the lease (acquire + release evals).
    await vi.waitFor(() => expect(evalMock).toHaveBeenCalledTimes(2));

    await handlers.onMessage?.(message as never, ws as never);
    expect(upstreamInstances).toHaveLength(2);
    const errors = ws.send.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((frame) => frame.type === 'error');
    expect(errors.some((frame) => frame.status === 409)).toBe(false);
  });

  it('fails over a pre-output connection failure without changing the root request', async () => {
    const { proxy, accounting } = registerCommon();
    proxy.resolveTarget
      .mockResolvedValueOnce({
        model: { id: 'model-1', publicId: 'gpt-5.5', reasoningEfforts: [], defaultReasoningEffort: null },
        selected: {
          source: {
            id: 'source-1',
            reasoningEffortMap: {},
            coreAccountId: 'core-conn-1',
            coreModelId: 'core-conn-1/gpt-5.5',
          },
          connection: { id: 'conn-1' },
        },
        upstreamModel: 'core-conn-1/gpt-5.5',
        coreAccountId: 'core-conn-1',
        candidateConnectionIds: ['conn-1', 'conn-2'],
      })
      .mockResolvedValueOnce({
        model: { id: 'model-1', publicId: 'gpt-5.5', reasoningEfforts: [], defaultReasoningEffort: null },
        selected: {
          source: {
            id: 'source-2',
            reasoningEffortMap: {},
            coreAccountId: 'core-conn-2',
            coreModelId: 'core-conn-2/gpt-5.5',
          },
          connection: { id: 'conn-2' },
        },
        upstreamModel: 'core-conn-2/gpt-5.5',
        coreAccountId: 'core-conn-2',
        candidateConnectionIds: ['conn-2'],
      });
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.5', input: 'hi' } }) } as never,
      ws as never
    );

    const first = upstreamInstances[0]!;
    first.handlers.error?.(new Error('connection reset'));
    await vi.waitFor(() => expect(upstreamInstances).toHaveLength(2));
    const second = upstreamInstances[1]!;
    second.handlers.open?.();

    const firstContext = JSON.parse(
      Buffer.from(first.options.headers['x-wiolett-context']!, 'base64url').toString('utf8')
    );
    const secondContext = JSON.parse(
      Buffer.from(second.options.headers['x-wiolett-context']!, 'base64url').toString('utf8')
    );
    expect(secondContext.rootRequestId).toBe(firstContext.rootRequestId);
    expect(secondContext.coreAccountId).toBe('core-conn-2');
    expect(JSON.parse(second.sent[0]!).response.model).toBe('core-conn-2/gpt-5.5');
    expect(accounting.retargetCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      expect.objectContaining({ id: 'source-2' }),
      expect.objectContaining({ id: 'conn-2' })
    );
    expect(ws.send).not.toHaveBeenCalled();

    second.handlers.message?.(JSON.stringify({ type: 'response.completed', response: { id: 'resp_2' } }));
    await vi.waitFor(() =>
      expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith('3fa85f64-5717-4562-b3fc-2c963f66afa6', 'completed')
    );
  });

  it('reports a rejected core upgrade without rotating provider connections', async () => {
    const { proxy, accounting } = registerCommon();
    proxy.resolveTarget.mockResolvedValueOnce({
      model: { id: 'model-1', publicId: 'gpt-5.5', reasoningEfforts: [], defaultReasoningEffort: null },
      selected: {
        source: {
          id: 'source-1',
          reasoningEffortMap: {},
          coreAccountId: 'core-conn-1',
          coreModelId: 'core-conn-1/gpt-5.5',
        },
        connection: { id: 'conn-1' },
      },
      upstreamModel: 'core-conn-1/gpt-5.5',
      coreAccountId: 'core-conn-1',
      candidateConnectionIds: ['conn-1', 'conn-2'],
    });
    const ws = clientSocket();
    const handlers = createCoreResponsesWSHandlers(AUTH);
    handlers.onOpen?.({} as never, ws as never);
    await handlers.onMessage?.(
      { data: JSON.stringify({ type: 'response.create', response: { model: 'gpt-5.5', input: 'hi' } }) } as never,
      ws as never
    );

    upstreamInstances[0]!.handlers['unexpected-response']?.({}, { statusCode: 426, resume: vi.fn() });

    await vi.waitFor(() => expect(accounting.finalizeCoreRequest).toHaveBeenCalled());
    expect(upstreamInstances).toHaveLength(1);
    expect(proxy.resolveTarget).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      type: 'error',
      status: 502,
      error: {
        code: 'inference_core_unavailable',
        message: 'Inference core rejected the WebSocket upgrade with status 426',
      },
    });
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'failed',
      expect.objectContaining({ statusCode: 426 })
    );
  });
});
