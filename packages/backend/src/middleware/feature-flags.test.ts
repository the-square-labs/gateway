import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { AppEnv } from '@/types.js';
import { requireGatewayFeature } from './feature-flags.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', requireGatewayFeature('siemEnabled', 'SIEM'));
  app.get('/siem', (c) => c.json({ ok: true }));
  return app;
}

afterEach(() => container.reset());

describe('requireGatewayFeature', () => {
  it('returns FEATURE_DISABLED before a SIEM endpoint runs', async () => {
    const isFeatureEnabled = vi.fn().mockResolvedValue(false);
    container.registerInstance(GeneralSettingsService, { isFeatureEnabled } as never);

    const response = await createApp().request('/siem');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(isFeatureEnabled).toHaveBeenCalledWith('siemEnabled');
  });

  it('allows a SIEM endpoint while the feature is enabled', async () => {
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled: vi.fn().mockResolvedValue(true),
    } as never);

    const response = await createApp().request('/siem');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
