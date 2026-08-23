import 'reflect-metadata';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';

const USER = { id: '11111111-1111-4111-8111-111111111111', isBlocked: false };
const MODEL = {
  id: 'model-1',
  publicId: 'gpt-5.5',
  enabled: true,
  subscriptionMultiplier: '1',
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
  coreAccountId: 'core-conn-2',
  coreModelId: 'core-conn-2/gpt-5.5',
};
const CONNECTION_2 = { ...CONNECTION, id: 'conn-2', routingOrder: 1 };

function selectChain(rows: unknown[]) {
  const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin', 'limit', 'groupBy']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  return chain;
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
  options: { coreResponse?: Response; coreError?: unknown; sources?: unknown[]; pricing?: unknown } = {}
) {
  const db = {
    select: vi.fn().mockReturnValue(selectChain(options.sources ?? [{ source: SOURCE, connection: CONNECTION }])),
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
  const models = { resolveForUser: vi.fn().mockResolvedValue({ model: MODEL, sources: [SOURCE] }) };
  const routing = { select: vi.fn().mockResolvedValue({ connectionId: 'conn-1', providerId: 'openai-apikey' }) };
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
  const fetchStub = vi.fn().mockResolvedValue(
    options.coreResponse ??
      new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
  );
  vi.stubGlobal('fetch', fetchStub);
  return { service, models, routing, bridge, coreAccounting, fetchStub };
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

  it('performs cross-account failover in Gateway with a new signed pin', async () => {
    const { service, routing, coreAccounting, fetchStub } = createService({
      sources: [
        { source: SOURCE, connection: CONNECTION },
        { source: SOURCE_2, connection: CONNECTION_2 },
      ],
    });
    routing.select
      .mockResolvedValueOnce({ connectionId: 'conn-1', providerId: CONNECTION.providerId })
      .mockResolvedValueOnce({ connectionId: 'conn-2', providerId: CONNECTION.providerId });
    fetchStub
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'provider_rate_limited', message: 'busy' } }, { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      );

    const response = await service.proxy(
      createContext(JSON.stringify({ model: 'gpt-5.5', input: 'hi' }), { 'content-type': 'application/json' }),
      'responses'
    );
    expect(response.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const contexts = fetchStub.mock.calls.map(([, init]) => {
      const encoded = (init.headers as Record<string, string>)['x-wiolett-context'];
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    });
    expect(contexts.map((claims) => claims.coreAccountId)).toEqual(['core-conn-1', 'core-conn-2']);
    expect(contexts[0].rootRequestId).toBe(contexts[1].rootRequestId);
    expect(coreAccounting.retargetCoreRequest).toHaveBeenCalledWith(
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      SOURCE_2,
      CONNECTION_2,
      0
    );
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

  it('rewrites multipart image edits and applies the fixed image charge', async () => {
    const { service, fetchStub, coreAccounting } = createService();
    const form = new FormData();
    form.set('model', 'gpt-5.5');
    form.set('n', '2');
    form.set('image', new Blob(['png'], { type: 'image/png' }), 'image.png');
    const c = createContext(form);

    await service.proxy(c, 'images/edits');

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('model')).toBe('core-conn-1/gpt-5.5');
    expect(coreAccounting.createCoreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fixedApiMicrodollars: 80_000 })
    );
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
