import 'reflect-metadata';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';

const USER = { id: '11111111-1111-4111-8111-111111111111', isBlocked: false };
const MODEL = {
  id: 'model-1',
  publicId: 'gpt-5.5',
  enabled: true,
  sortOrder: 0,
  subscriptionMultiplier: '1',
  modalities: ['text'],
  capabilities: {},
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: null,
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
  reasoningEffortMap: { low: 'minimal', high: 'high' },
  metadata: {},
  priority: 0,
};
const CONNECTION = {
  id: 'conn-1',
  providerId: 'openai-apikey',
  authType: 'api_key',
  metadata: {},
  enabled: true,
  deletedAt: null,
  routingOrder: 0,
  apiMonthlyLimitMicrodollars: null,
};
const SOURCE_2 = {
  ...SOURCE,
  id: 'source-2',
  connectionId: 'conn-2',
  coreAccountId: 'anthropic',
  coreModelId: 'anthropic/claude-sonnet-5',
  upstreamModelId: 'claude-sonnet-5',
};
const CONNECTION_2 = { ...CONNECTION, id: 'conn-2', providerId: 'anthropic', routingOrder: 1 };

function selectChain(rows: unknown[]) {
  const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin', 'limit', 'groupBy']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

function containsColumn(value: unknown, columnName: string, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const candidate = value as Record<string, unknown>;
  if (candidate.name === columnName && candidate.table) return true;
  return Object.values(candidate).some((item) => containsColumn(item, columnName, seen));
}

function createContext(
  body: string | FormData | Buffer | null,
  headers: Record<string, string> = {},
  query: Record<string, string> = {}
) {
  const url = new URL('http://gateway.test/api/inference/v1/responses');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const raw = new Request(url, { method: 'POST', body, headers });
  return {
    get: (key: string) => {
      if (key === 'user') return USER;
      if (key === 'inferenceAuth') return { tokenId: 'token-1', tokenPrefix: 'gwi_x', rawToken: 'gwi_x.y' };
      return undefined;
    },
    req: {
      raw,
      query: (name: string) => url.searchParams.get(name) ?? undefined,
      header: (name: string) => raw.headers.get(name) ?? undefined,
      json: () => raw.json(),
      formData: () => raw.formData(),
      arrayBuffer: () => raw.arrayBuffer(),
    },
  } as never;
}

function createService(
  options: {
    coreResponse?: Response;
    coreError?: unknown;
    fetchError?: unknown;
    sources?: unknown[];
    pricing?: unknown;
  } = {}
) {
  const sourceRows = options.sources ?? [{ model: MODEL, source: SOURCE, connection: CONNECTION }];
  const selection = selectChain(sourceRows);
  const db = {
    select: vi.fn().mockReturnValue(selection),
    query: {
      inferencePricingSnapshots: {
        findFirst: vi.fn().mockResolvedValue(
          options.pricing === undefined
            ? {
                id: 'price-1',
                version: '2026-08',
                inputMicrodollarsPerMillion: 1_000_000,
                outputMicrodollarsPerMillion: 2_000_000,
                otherUnitPrices: { image_generation: 40_000, image_edit: 40_000 },
              }
            : options.pricing
        ),
      },
    },
  };
  const models = {
    listForUser: vi.fn().mockResolvedValue({ object: 'list', data: [{ id: MODEL.publicId }] }),
    resolveForUser: vi.fn().mockResolvedValue({
      model: MODEL,
      sources: sourceRows.map((row) => ({
        ...((row as { source?: Record<string, unknown> }).source ?? (row as Record<string, unknown>)),
        modalities: ['text'],
        capabilities: {},
      })),
    }),
  };
  const releaseAffinityTurn = vi.fn().mockResolvedValue(undefined);
  const routing = {
    select: vi.fn().mockResolvedValue({ connectionId: 'conn-1', providerId: 'openai-apikey' }),
    markAffinityActive: vi.fn().mockResolvedValue(undefined),
    beginAffinityTurn: vi.fn().mockResolvedValue(releaseAffinityTurn),
  };
  const bridge = options.coreError
    ? { dataPlaneTarget: vi.fn().mockRejectedValue(options.coreError) }
    : {
        dataPlaneTarget: vi
          .fn()
          .mockResolvedValue({ baseUrl: 'http://inference-core:10100', credential: 'ocx_data cred' }),
      };
  const coreAccounting = {
    createCoreRequest: vi.fn().mockResolvedValue({ requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    retargetCoreRequest: vi.fn().mockResolvedValue(undefined),
    finalizeCoreRequest: vi.fn().mockResolvedValue(undefined),
  };
  const legacyAccounting = {};
  const service = new InferenceCoreProxyService(
    db as never,
    bridge as never,
    models as never,
    routing as never,
    coreAccounting as never,
    legacyAccounting as never
  );
  const fetchStub = options.fetchError
    ? vi.fn().mockRejectedValue(options.fetchError)
    : vi.fn().mockResolvedValue(
        options.coreResponse ??
          new Response('data: {"type":"response.completed"}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
      );
  vi.stubGlobal('fetch', fetchStub);
  return { service, models, routing, releaseAffinityTurn, bridge, coreAccounting, fetchStub, selection };
}

afterEach(() => vi.unstubAllGlobals());

describe('inference core proxy', () => {
  it('rewrites the model to the core reference and injects signed context headers', async () => {
    const { service, fetchStub, coreAccounting } = createService();
    const c = createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi', reasoning: { effort: 'low' } }), {
      'content-type': 'application/json',
      authorization: 'Bearer gwi_secret',
      origin: 'https://evil.example',
      'x-wiolett-context': 'forged',
    });

    const response = await service.proxy(c, 'responses');

    expect(response.status).toBe(200);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://inference-core:10100/v1/responses');
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders['x-opencodex-api-key']).toBe('ocx_data cred');
    expect(sentHeaders['x-wiolett-contract']).toBe('wiolett-core/v1');
    expect(sentHeaders['x-wiolett-context']).toBeTruthy();
    expect(sentHeaders['x-wiolett-signature']).toBeTruthy();
    expect(sentHeaders.authorization).toBeUndefined();
    expect(sentHeaders.origin).toBeUndefined();
    const claims = JSON.parse(Buffer.from(sentHeaders['x-wiolett-context'], 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      contractId: 'wiolett-core/v1',
      tenantUserId: USER.id,
      publicModelId: 'gpt-5.5',
      coreAccountId: 'core-conn-1',
      coreModelId: 'core-conn-1/gpt-5.5',
      operation: 'responses',
    });
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe('core-conn-1/gpt-5.5');
    expect(sentBody.reasoning).toEqual({ effort: 'minimal' });
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id, model: MODEL })
    );
  });

  it('refreshes thread affinity activity when an HTTP turn finishes', async () => {
    const { service, routing, releaseAffinityTurn } = createService();
    let finishActivityRefresh!: () => void;
    routing.markAffinityActive.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishActivityRefresh = resolve;
      })
    );
    const response = await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-5.5', input: 'continue', prompt_cache_key: 'thread-activity' }), {
        'content-type': 'application/json',
      }),
      'responses'
    );

    await response.text();

    expect(routing.markAffinityActive).toHaveBeenCalledWith('thread-activity');
    expect(releaseAffinityTurn).not.toHaveBeenCalled();
    finishActivityRefresh();
    await vi.waitFor(() => expect(releaseAffinityTurn).toHaveBeenCalledOnce());
    expect(routing.markAffinityActive.mock.invocationCallOrder[0]).toBeLessThan(
      releaseAffinityTurn.mock.invocationCallOrder[0]!
    );
  });

  it('decodes Codex zstd-compressed Responses HTTP fallback bodies', async () => {
    const { service, fetchStub } = createService();
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: 'continue' })));
    const c = createContext(compressed, {
      'content-type': 'application/json',
      'content-encoding': 'zstd',
    });

    const response = await service.proxy(c, 'responses');

    expect(response.status).toBe(200);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'core-conn-1/gpt-5.5',
      input: 'continue',
    });
  });

  it('fails closed with a stable gateway error when the core is unavailable', async () => {
    const { service, coreAccounting } = createService({ coreError: new Error('not ready') });
    const c = createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi' }), { 'content-type': 'application/json' });
    await expect(service.proxy(c, 'responses')).rejects.toMatchObject({
      status: 503,
      code: 'inference_core_unavailable',
    });
    expect(coreAccounting.createCoreRequest).not.toHaveBeenCalled();
  });

  it('marks compact operations for protected-reserve accounting', async () => {
    const { service, coreAccounting } = createService();
    const c = createContext(JSON.stringify({ model: 'gpt-5.5', input: 'compact this conversation' }), {
      'content-type': 'application/json',
    });

    const response = await service.proxy(c, 'responses/compact');

    expect(response.status).toBe(200);
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'responses/compact', isCompaction: true })
    );
  });

  it('marks Responses compaction_trigger turns for protected-reserve accounting', async () => {
    const { service, coreAccounting } = createService();
    const c = createContext(
      JSON.stringify({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: 'history' }, { type: 'compaction_trigger' }],
      }),
      { 'content-type': 'application/json' }
    );

    const response = await service.proxy(c, 'responses');

    expect(response.status).toBe(200);
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(expect.objectContaining({ isCompaction: true }));
  });

  it('performs cross-provider failover in Gateway with a new signed pin', async () => {
    const { service, routing, coreAccounting, fetchStub } = createService({
      sources: [
        { source: SOURCE, connection: CONNECTION },
        { source: SOURCE_2, connection: CONNECTION_2 },
      ],
    });
    routing.select
      .mockResolvedValueOnce({ connectionId: 'conn-1', providerId: CONNECTION.providerId })
      .mockResolvedValueOnce({ connectionId: 'conn-2', providerId: CONNECTION_2.providerId });
    fetchStub
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'provider_rate_limited', message: 'busy' } }, { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      );

    const response = await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-5.5', input: 'continue', previous_response_id: 'resp_previous' }), {
        'content-type': 'application/json',
      }),
      'responses'
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const contexts = fetchStub.mock.calls.map(([, init]) => {
      const encoded = (init.headers as Record<string, string>)['x-wiolett-context'];
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    });
    expect(contexts.map((claims) => claims.coreAccountId)).toEqual(['core-conn-1', 'anthropic']);
    expect(contexts[0].rootRequestId).toBe(contexts[1].rootRequestId);
    const bodies = fetchStub.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(bodies.map((body) => body.model)).toEqual(['core-conn-1/gpt-5.5', 'anthropic/claude-sonnet-5']);
    expect(bodies.map((body) => body.previous_response_id)).toEqual(['resp_previous', 'resp_previous']);
    expect(routing.select).toHaveBeenNthCalledWith(1, {
      allowedConnectionIds: ['conn-1', 'conn-2'],
      existingThread: true,
    });
    expect(routing.select).toHaveBeenNthCalledWith(2, {
      providerId: 'anthropic',
      allowedConnectionIds: ['conn-2'],
      existingThread: true,
    });
    expect(coreAccounting.retargetCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      SOURCE_2,
      CONNECTION_2,
      0
    );
    await vi.waitFor(() => expect(coreAccounting.finalizeCoreRequest).toHaveBeenCalledOnce());
    expect(coreAccounting.finalizeCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'completed',
      undefined
    );
  });

  it('finalizes an HTTP transport failure exactly once with the normalized Gateway error', async () => {
    const { service, routing, releaseAffinityTurn, coreAccounting } = createService({
      fetchError: new Error('connect ECONNREFUSED'),
    });

    await expect(
      service.proxy(
        createContext(
          JSON.stringify({ model: 'gpt-5.5', input: 'continue', prompt_cache_key: 'thread-transport-error' }),
          { 'content-type': 'application/json' }
        ),
        'responses'
      )
    ).rejects.toMatchObject({ status: 503, code: 'inference_core_unavailable' });

    expect(coreAccounting.finalizeCoreRequest).toHaveBeenCalledOnce();
    expect(coreAccounting.finalizeCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'failed',
      expect.objectContaining({ status: 503, code: 'inference_core_unavailable' })
    );
    expect(routing.markAffinityActive).toHaveBeenCalledOnce();
    expect(releaseAffinityTurn).toHaveBeenCalledOnce();
  });

  it('keeps configured core sources routable across transient discovery omissions', async () => {
    const { service, routing, selection } = createService({
      sources: [
        { source: SOURCE, connection: CONNECTION, discovered: { available: false } },
        { source: SOURCE_2, connection: CONNECTION_2, discovered: { available: true } },
      ],
    });

    await service.resolveTarget(USER as never, MODEL.publicId);

    expect(routing.select).toHaveBeenCalledWith({
      allowedConnectionIds: ['conn-1', 'conn-2'],
      existingThread: false,
    });
    const where = (selection.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(containsColumn(where, 'available')).toBe(false);
  });

  it('streams the upstream body through and finalizes the request', async () => {
    const { service, coreAccounting } = createService();
    const c = createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi' }), { 'content-type': 'application/json' });
    const response = await service.proxy(c, 'responses');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('response.completed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coreAccounting.finalizeCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'completed',
      undefined
    );
  });

  it('repairs an interrupted core SSE body with a structured failed terminal', async () => {
    let reads = 0;
    const coreBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_core"}}\n\n'
            )
          );
          return;
        }
        controller.error(new Error('socket reset'));
      },
    });
    const { service, coreAccounting } = createService({
      coreResponse: new Response(coreBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const response = await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi' }), { 'content-type': 'application/json' }),
      'responses'
    );

    await expect(response.text()).resolves.toContain('response.failed');
    await vi.waitFor(() =>
      expect(coreAccounting.finalizeCoreRequest).toHaveBeenCalledWith(
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        'failed',
        expect.objectContaining({ message: 'socket reset' })
      )
    );
  });

  it('replaces an unreadable core error body with stable JSON', async () => {
    const brokenErrorBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('broken error body'));
      },
    });
    const { service } = createService({
      coreResponse: new Response(brokenErrorBody, { status: 502, headers: { 'content-type': 'application/json' } }),
    });
    const response = await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi' }), { 'content-type': 'application/json' }),
      'responses'
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'inference_core_stream_reset' },
    });
  });

  it('preserves the multipart image model and applies the fixed image charge', async () => {
    const { service, fetchStub, coreAccounting } = createService();
    const form = new FormData();
    form.set('model', 'gpt-image-2');
    form.set('n', '2');
    form.set('image', new Blob(['png'], { type: 'image/png' }), 'image.png');
    const c = createContext(form);

    await service.proxy(c, 'images/edits');

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('model')).toBe('gpt-image-2');
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fixedApiMicrodollars: 80_000 })
    );
  });

  it('converts Codex JSON image edits to the multipart core contract', async () => {
    const { service, fetchStub, coreAccounting } = createService();
    const c = createContext(
      JSON.stringify({
        images: [{ image_url: 'data:image/png;base64,cG5n' }, { image_url: 'data:image/jpeg;base64,anBn' }],
        prompt: 'change only the background',
        background: 'auto',
        model: 'gpt-image-2',
        n: 2,
        quality: 'auto',
        size: 'auto',
      }),
      { 'content-type': 'application/json; charset=utf-8' }
    );

    await service.proxy(c, 'images/edits');

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('prompt')).toBe('change only the background');
    expect(form.get('background')).toBe('auto');
    expect(form.get('quality')).toBe('auto');
    expect(form.get('size')).toBe('auto');
    expect(form.get('n')).toBe('2');
    const images = form.getAll('image[]');
    expect(images).toHaveLength(2);
    expect(images[0]).toBeInstanceOf(File);
    expect(images[1]).toBeInstanceOf(File);
    expect((images[0] as File).name).toBe('image-1.png');
    expect((images[0] as File).type).toBe('image/png');
    expect(await (images[0] as File).text()).toBe('png');
    expect((images[1] as File).name).toBe('image-2.jpg');
    expect((images[1] as File).type).toBe('image/jpeg');
    expect(await (images[1] as File).text()).toBe('jpg');
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fixedApiMicrodollars: 80_000 })
    );
  });

  it.each([
    {
      name: 'remote image URLs',
      images: [{ image_url: 'https://example.com/image.png' }],
      message: 'must be a base64 PNG, JPEG, or WebP data URL',
    },
    {
      name: 'more than five images',
      images: Array.from({ length: 6 }, () => ({ image_url: 'data:image/png;base64,cG5n' })),
      message: 'images must contain between 1 and 5 items',
    },
  ])('rejects Codex JSON image edits with $name', async ({ images, message }) => {
    const { service, fetchStub, coreAccounting } = createService();
    const c = createContext(JSON.stringify({ images, prompt: 'edit', model: 'gpt-image-2' }), {
      'content-type': 'application/json',
    });

    await expect(service.proxy(c, 'images/edits')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request_error',
      message: expect.stringContaining(message),
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(coreAccounting.createCoreRequest).not.toHaveBeenCalled();
  });

  it('routes Codex image models through an eligible OpenAI carrier without rewriting the image model', async () => {
    const { service, fetchStub, models, coreAccounting } = createService();
    const c = createContext(JSON.stringify({ model: 'gpt-image-2', prompt: 'draw a cat', n: 2 }), {
      'content-type': 'application/json',
    });

    await service.proxy(c, 'images/generations');

    expect(models.resolveForUser).not.toHaveBeenCalled();
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'draw a cat',
      n: 2,
    });
    const sentHeaders = init.headers as Record<string, string>;
    const claims = JSON.parse(Buffer.from(sentHeaders['x-wiolett-context'], 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      publicModelId: MODEL.publicId,
      coreAccountId: SOURCE.coreAccountId,
      coreModelId: SOURCE.coreModelId,
      operation: 'images',
    });
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'image_generation',
        model: MODEL,
        source: SOURCE,
        fixedApiMicrodollars: 80_000,
      })
    );
  });

  it('does not require API unit pricing for subscription image generation', async () => {
    const subscriptionSource = {
      ...SOURCE,
      sourceType: 'subscription',
      coreAccountId: 'pool-a',
      coreModelId: 'gpt-5.6-sol',
    };
    const subscriptionConnection = {
      ...CONNECTION,
      providerId: 'openai',
      authType: 'oauth',
      metadata: { coreAccountId: 'pool-a' },
    };
    const { service, coreAccounting } = createService({
      sources: [{ model: MODEL, source: subscriptionSource, connection: subscriptionConnection }],
      pricing: null,
    });

    await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-image-2', prompt: 'draw a cat' }), {
        'content-type': 'application/json',
      }),
      'images/generations'
    );

    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.not.objectContaining({ fixedApiMicrodollars: expect.anything() })
    );
  });

  it('never retries a paid image request after the core returns an error', async () => {
    const { service, fetchStub, routing } = createService({
      sources: [
        { model: MODEL, source: SOURCE, connection: CONNECTION },
        { model: MODEL, source: SOURCE_2, connection: CONNECTION_2 },
      ],
      coreResponse: Response.json({ error: { code: 'provider_unavailable' } }, { status: 503 }),
    });

    const response = await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-image-2', prompt: 'draw a cat' }), {
        'content-type': 'application/json',
      }),
      'images/generations'
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'image_generation_result_unknown' } });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(routing.select).toHaveBeenCalledTimes(1);
  });

  it('makes an ambiguous core transport failure non-retryable for image generation', async () => {
    const { service, fetchStub, routing } = createService({ fetchError: new Error('socket reset after dispatch') });

    await expect(
      service.proxy(
        createContext(JSON.stringify({ model: 'gpt-image-2', prompt: 'draw a cat' }), {
          'content-type': 'application/json',
        }),
        'images/generations'
      )
    ).rejects.toMatchObject({ status: 409, code: 'image_generation_result_unknown' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(routing.select).toHaveBeenCalledTimes(1);
  });

  it('rejects models without a core-backed source', async () => {
    const { service } = createService({ sources: [] });
    const c = createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi' }), { 'content-type': 'application/json' });
    await expect(service.proxy(c, 'responses')).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
    });
  });
});
