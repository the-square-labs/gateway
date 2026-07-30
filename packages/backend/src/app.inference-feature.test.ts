import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { inferenceFeatureGuard, inferenceHarnessEndpointsGuard } from './app.js';
import type { AppEnv } from './types.js';

describe('inference feature guard', () => {
  afterEach(() => container.reset());

  it('reads the persisted Gateway feature setting for every request', async () => {
    const isFeatureEnabled = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled,
    } as unknown as GeneralSettingsService);

    const disabled = new Hono<AppEnv>();
    disabled.use('*', inferenceFeatureGuard());
    disabled.get('/models', (c) => c.json({ object: 'list' }));
    const disabledResponse = await disabled.request('/models');
    expect(disabledResponse.status).toBe(404);
    await expect(disabledResponse.json()).resolves.toMatchObject({ code: 'INFERENCE_DISABLED' });

    const enabled = new Hono<AppEnv>();
    enabled.use('*', inferenceFeatureGuard());
    enabled.get('/models', (c) => c.json({ object: 'list' }));
    expect((await enabled.request('/models')).status).toBe(200);
    expect(isFeatureEnabled).toHaveBeenNthCalledWith(1, 'inferenceEnabled');
    expect(isFeatureEnabled).toHaveBeenNthCalledWith(2, 'inferenceEnabled');
  });

  it('keeps the base adapter available while gating harness-specific endpoints', async () => {
    const getInferenceSettings = vi
      .fn()
      .mockResolvedValueOnce({ harnessSpecificEndpointsEnabled: false })
      .mockResolvedValueOnce({ harnessSpecificEndpointsEnabled: true });
    container.registerInstance(GeneralSettingsService, {
      getInferenceSettings,
    } as unknown as GeneralSettingsService);

    const disabled = new Hono<AppEnv>();
    disabled.use('*', inferenceHarnessEndpointsGuard());
    disabled.get('/responses', (c) => c.json({ ok: true }));
    const disabledResponse = await disabled.request('/responses');
    expect(disabledResponse.status).toBe(404);
    await expect(disabledResponse.json()).resolves.toMatchObject({
      code: 'INFERENCE_HARNESS_ENDPOINTS_DISABLED',
    });

    const enabled = new Hono<AppEnv>();
    enabled.use('*', inferenceHarnessEndpointsGuard());
    enabled.get('/responses', (c) => c.json({ ok: true }));
    expect((await enabled.request('/responses')).status).toBe(200);
  });
});
