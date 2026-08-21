import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { INFERENCE_CORE_CALLBACK_HEADERS, WIOLETT_CORE_CONTRACT_ID } from './inference-core.contract.js';
import { InferenceCoreBridgeService } from './inference-core-bridge.service.js';
import { inferenceCoreInternalRoutes } from './inference-core-internal.routes.js';

const CREDENTIAL = 'ocx_callbackcred0123456789abcdef0123456789ab';

function sign(timestamp: string, body: string, credential = CREDENTIAL): string {
  return createHmac('sha256', credential).update(`${timestamp}.${body}`).digest('base64url');
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route('/', inferenceCoreInternalRoutes);
  return app;
}

function callbackRequest(
  path: string,
  body: unknown,
  options: { credential?: string; timestamp?: string; signature?: string; contract?: string } = {}
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  return new Request(`http://internal${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INFERENCE_CORE_CALLBACK_HEADERS.contract]: options.contract ?? WIOLETT_CORE_CONTRACT_ID,
      [INFERENCE_CORE_CALLBACK_HEADERS.timestamp]: timestamp,
      [INFERENCE_CORE_CALLBACK_HEADERS.signature]: options.signature ?? sign(timestamp, raw, options.credential),
    },
    body: raw,
  });
}

const ADMISSION = {
  contractId: WIOLETT_CORE_CONTRACT_ID,
  rootRequestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  attemptId: 'att_1',
  parentAttemptId: null,
  attemptKind: 'root',
  coreAccountId: 'core-conn-1',
  coreModelId: 'core-conn-1/gpt-5.5',
  sourceType: 'subscription',
  operation: 'responses',
  estimate: { inputTokens: 100, maxOutputTokens: 50 },
  occurredAt: new Date().toISOString(),
};

const SETTLEMENT = {
  contractId: WIOLETT_CORE_CONTRACT_ID,
  rootRequestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  attemptId: 'att_1',
  parentAttemptId: null,
  attemptKind: 'root',
  terminalStatus: 'completed',
  coreAccountId: 'core-conn-1',
  coreModelId: 'core-conn-1/gpt-5.5',
  sourceType: 'subscription',
  upstreamStatus: 200,
  errorCode: null,
  usage: { uncachedInputTokens: 90, cachedInputTokens: 10, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: 0 },
  usageEstimated: false,
  emittedOutput: true,
  startedAt: new Date(Date.now() - 1000).toISOString(),
  completedAt: new Date().toISOString(),
};

function registerServices(accounting: Record<string, unknown> = {}) {
  container.registerInstance(InferenceCoreBridgeService, {
    callbackCredential: vi.fn().mockResolvedValue(CREDENTIAL),
  } as unknown as InferenceCoreBridgeService);
  const service = {
    admitCoreAttempt: vi.fn().mockResolvedValue({ decision: 'allow' }),
    settleCoreAttempt: vi.fn().mockResolvedValue(undefined),
    ...accounting,
  };
  container.registerInstance(InferenceCoreAccountingService, service as unknown as InferenceCoreAccountingService);
  return service;
}

afterEach(() => container.reset());

describe('inference core internal callbacks', () => {
  it('rejects callbacks with an invalid signature', async () => {
    registerServices();
    const response = await createApp().fetch(
      callbackRequest('/api/internal/inference-core/admission', ADMISSION, {
        credential: 'ocx_wrong6789abcdef0123456789abcdef01',
      })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'callback_signature_invalid' });
  });

  it('rejects callbacks outside the timestamp skew', async () => {
    registerServices();
    const stale = (Math.floor(Date.now() / 1000) - 300).toString();
    const response = await createApp().fetch(
      callbackRequest('/api/internal/inference-core/admission', ADMISSION, { timestamp: stale })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'callback_timestamp_stale' });
  });

  it('rejects callbacks with the wrong contract header', async () => {
    registerServices();
    const response = await createApp().fetch(
      callbackRequest('/api/internal/inference-core/admission', ADMISSION, { contract: 'wiolett-core/v0' })
    );
    expect(response.status).toBe(401);
  });

  it('rejects malformed admission payloads', async () => {
    registerServices();
    const response = await createApp().fetch(callbackRequest('/api/internal/inference-core/admission', { nope: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'callback_malformed' });
  });

  it('admits attempts and returns the gateway decision', async () => {
    const accounting = registerServices({
      admitCoreAttempt: vi
        .fn()
        .mockResolvedValue({ decision: 'deny', reason: 'budget_exceeded', retryAfterSeconds: 30 }),
    });
    const response = await createApp().fetch(callbackRequest('/api/internal/inference-core/admission', ADMISSION));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: 'deny', reason: 'budget_exceeded', retryAfterSeconds: 30 });
    expect(accounting.admitCoreAttempt).toHaveBeenCalledWith(ADMISSION);
  });

  it('settles attempts and acknowledges', async () => {
    const accounting = registerServices();
    const response = await createApp().fetch(callbackRequest('/api/internal/inference-core/settlement', SETTLEMENT));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(accounting.settleCoreAttempt).toHaveBeenCalledWith(SETTLEMENT);
  });
});
