import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv, User } from '@/types.js';
import { templateRoutes } from './templates.routes.js';
import { TemplatesService } from './templates.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [],
  isBlocked: false,
};

const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = {
  id: TEMPLATE_ID,
  name: 'TLS Server',
  description: null,
  certType: 'tls-server',
  keyAlgorithm: 'ecdsa-p256',
  validityDays: 365,
  isBuiltin: false,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/templates', templateRoutes);
  return app;
}

function registerServices(scopes: string[], templateService: Partial<TemplatesService>) {
  container.registerInstance(TokensService, {
    validateToken: vi.fn().mockResolvedValue({
      user: { ...USER, scopes },
      scopes,
      tokenId: 'token-1',
      tokenPrefix: 'gw_abc1234',
    }),
  } as unknown as TokensService);
  container.registerInstance(TemplatesService, templateService as TemplatesService);
  container.registerInstance(GeneralSettingsService, {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
  } as unknown as GeneralSettingsService);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
}

function authHeaders() {
  return {
    Authorization: 'Bearer gw_valid',
    'Content-Type': 'application/json',
  };
}

afterEach(() => {
  container.reset();
});

describe('PKI template route permissions', () => {
  it('rejects template listing without pki:templates:view', async () => {
    const listTemplates = vi.fn().mockResolvedValue([TEMPLATE]);
    registerServices(['pki:templates:create'], { listTemplates });

    const response = await createApp().request('/api/templates', { headers: authHeaders() });

    expect(response.status).toBe(403);
    expect(listTemplates).not.toHaveBeenCalled();
  });

  it('rejects template details without pki:templates:view', async () => {
    const getTemplate = vi.fn().mockResolvedValue(TEMPLATE);
    registerServices(['pki:templates:create'], { getTemplate });

    const response = await createApp().request(`/api/templates/${TEMPLATE_ID}`, {
      headers: authHeaders(),
    });

    expect(response.status).toBe(403);
    expect(getTemplate).not.toHaveBeenCalled();
  });

  it('allows template listing with pki:templates:view', async () => {
    const listTemplates = vi.fn().mockResolvedValue([TEMPLATE]);
    registerServices(['pki:templates:view'], { listTemplates });

    const response = await createApp().request('/api/templates', { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([TEMPLATE]);
  });
});
