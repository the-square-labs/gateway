import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { AppEnv } from '@/types.js';
import { errorHandler } from './error-handler.js';

describe('errorHandler', () => {
  it('preserves inference status and code on management routes', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get('/usage', () => {
      throw new InferenceProtocolError(503, 'budget_policy_unavailable', 'Inference limits are not configured');
    });

    const response = await app.request('/usage');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'budget_policy_unavailable',
      message: 'Inference limits are not configured',
    });
  });
});
