import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0'.repeat(64);

vi.mock('@/modules/auth/live-session-user.js', () => ({
  resolveLiveUser: vi.fn().mockResolvedValue({ id: 'user-1', isBlocked: false }),
}));

import { InferenceCoreExecutor } from './inference-core-executor.service.js';
import type { InferenceRequest } from '../protocol/inference-protocol.types.js';

const MODEL = {
  id: 'model-1',
  publicId: 'gpt-5.5',
  reasoningEfforts: ['low'],
  defaultReasoningEffort: null,
};
const SOURCE = {
  id: 'source-1',
  connectionId: 'conn-1',
  enabled: true,
  sourceType: 'subscription',
  subscriptionMultiplierOverride: null,
  coreAccountId: 'core-conn-1',
  coreModelId: 'core-conn-1/gpt-5.5',
  reasoningEffortMap: { low: 'minimal' },
};
const CONNECTION = { id: 'conn-1', providerId: 'openai', enabled: true, deletedAt: null };
const FALLBACK_SOURCE = {
  ...SOURCE,
  id: 'source-2',
  connectionId: 'conn-2',
  coreAccountId: 'core-conn-2',
  coreModelId: 'core-conn-2/gpt-5.5',
};
const FALLBACK_CONNECTION = { ...CONNECTION, id: 'conn-2' };

const REQUEST: InferenceRequest = {
  protocol: 'responses',
  model: 'gpt-5.5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  stream: true,
  reasoningEffort: 'low',
  isCompaction: false,
  extensions: {},
};

function createExecutor(options: { coreResponse?: Response; coreError?: unknown } = {}) {
  const proxy = {
    resolveTarget: vi.fn().mockResolvedValue({
      model: MODEL,
      selected: { source: SOURCE, connection: CONNECTION },
      upstreamModel: 'core-conn-1/gpt-5.5',
      coreAccountId: 'core-conn-1',
      candidateConnectionIds: ['conn-1'],
    }),
    dataPlaneTarget: vi.fn().mockResolvedValue({ baseUrl: 'http://inference-core:10100', credential: 'ocx_data' }),
  };
  const accounting = {
    createCoreRequest: vi.fn().mockResolvedValue({ requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    retargetCoreRequest: vi.fn().mockResolvedValue(undefined),
    finalizeCoreRequest: vi.fn().mockResolvedValue(undefined),
  };
  const executor = new InferenceCoreExecutor({} as never, proxy as never, accounting as never);
  const fetchStub = options.coreError
    ? vi.fn().mockRejectedValue(options.coreError)
    : vi.fn().mockResolvedValue(
        options.coreResponse ??
          new Response(
            [
              'data: {"type":"response.output_text.delta","item_id":"i1","delta":"Hi"}',
              'data: {"type":"response.completed","response":{"id":"resp_9","model":"core-conn-1/gpt-5.5","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
              '',
            ].join('\n\n'),
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
          )
      );
  vi.stubGlobal('fetch', fetchStub);
  return { executor, proxy, accounting, fetchStub };
}

const CONTEXT = {
  requestId: 'req-1',
  userId: 'user-1',
  tokenId: 'token-1',
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe('inference core executor', () => {
  it('runs the request through the core and streams mapped events', async () => {
    const { executor, accounting, fetchStub } = createExecutor();
    const execution = await executor.execute(REQUEST, CONTEXT);

    expect(execution.resolvedModel).toBe('gpt-5.5');
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://inference-core:10100/v1/responses');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencodex-api-key']).toBe('ocx_data');
    expect(headers['x-wiolett-signature']).toBeTruthy();
    const wire = JSON.parse(init.body as string);
    expect(wire.model).toBe('core-conn-1/gpt-5.5');
    expect(wire.reasoning).toEqual({ effort: 'minimal' });

    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events.some((event) => event.type === 'output_text.delta' && event.delta === 'Hi')).toBe(true);
    expect(events.some((event) => event.type === 'completed')).toBe(true);
    expect(accounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', protocol: 'responses', operation: 'inference' })
    );
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith(expect.any(String), 'completed');
  });

  it('fails closed when the core is unreachable', async () => {
    const { executor, accounting } = createExecutor({ coreError: new Error('connection refused') });
    await expect(executor.execute(REQUEST, CONTEXT)).rejects.toMatchObject({
      status: 503,
      code: 'inference_core_unavailable',
    });
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith(expect.any(String), 'failed', expect.any(Error));
  });

  it('does not create an accounting root when the core target is unavailable', async () => {
    const { executor, proxy, accounting } = createExecutor();
    proxy.dataPlaneTarget.mockRejectedValueOnce(new Error('core is stopped'));

    await expect(executor.execute(REQUEST, CONTEXT)).rejects.toMatchObject({
      status: 503,
      code: 'inference_core_unavailable',
    });
    expect(accounting.createCoreRequest).not.toHaveBeenCalled();
    expect(accounting.finalizeCoreRequest).not.toHaveBeenCalled();
  });

  it('fails over before output using the same root and retargets accounting', async () => {
    const { executor, proxy, accounting } = createExecutor();
    proxy.resolveTarget
      .mockResolvedValueOnce({
        model: MODEL,
        selected: { source: SOURCE, connection: CONNECTION },
        upstreamModel: 'core-conn-1/gpt-5.5',
        coreAccountId: 'core-conn-1',
        candidateConnectionIds: ['conn-1', 'conn-2'],
      })
      .mockResolvedValueOnce({
        model: MODEL,
        selected: { source: FALLBACK_SOURCE, connection: FALLBACK_CONNECTION },
        upstreamModel: 'core-conn-2/gpt-5.5',
        coreAccountId: 'core-conn-2',
        candidateConnectionIds: ['conn-2'],
      });
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'try another account' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          [
            'data: {"type":"response.output_text.delta","item_id":"i1","delta":"Hi"}',
            'data: {"type":"response.completed","response":{"id":"resp_9","model":"core-conn-2/gpt-5.5","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
            '',
          ].join('\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      );
    vi.stubGlobal('fetch', fetchStub);

    const execution = await executor.execute(REQUEST, CONTEXT);
    for await (const _event of execution.events) {
      // Drain the stream so terminal accounting runs.
    }

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(proxy.resolveTarget).toHaveBeenLastCalledWith(
      expect.anything(),
      'gpt-5.5',
      expect.objectContaining({ excludeConnectionIds: ['conn-1'] })
    );
    expect(accounting.retargetCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      FALLBACK_SOURCE,
      FALLBACK_CONNECTION,
      0
    );
    const firstHeaders = (fetchStub.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchStub.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    const firstContext = JSON.parse(Buffer.from(firstHeaders['x-wiolett-context']!, 'base64url').toString('utf8'));
    const secondContext = JSON.parse(Buffer.from(secondHeaders['x-wiolett-context']!, 'base64url').toString('utf8'));
    expect(firstContext.rootRequestId).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(secondContext.rootRequestId).toBe(firstContext.rootRequestId);
    expect(secondContext.coreAccountId).toBe('core-conn-2');
    expect(accounting.createCoreRequest).toHaveBeenCalledTimes(1);
    expect(accounting.finalizeCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'completed'
    );
  });

  it('maps core error envelopes to stable gateway errors', async () => {
    const { executor } = createExecutor({
      coreResponse: new Response(JSON.stringify({ error: { code: 'model_unknown', message: 'no such model' } }), {
        status: 404,
      }),
    });
    await expect(executor.execute(REQUEST, CONTEXT)).rejects.toMatchObject({
      status: 404,
      code: 'model_unknown',
    });
  });
});
