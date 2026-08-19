import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { AppEnv } from '@/types.js';
import { inferenceAdapterDiscovery } from './inference-setup.contract.js';

export const inferenceDiscoveryRoutes = new OpenAPIHono<AppEnv>();

inferenceDiscoveryRoutes.get('/wiolett-inference', async (c) => {
  const settings = await container.resolve(GeneralSettingsService).getConfig();
  return c.json({
    ...inferenceAdapterDiscovery(container.resolve(OAuthService)),
    enabled: settings.features.inferenceEnabled,
  });
});
