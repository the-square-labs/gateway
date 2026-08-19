import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { AppEnv, User } from '@/types.js';
import { inferenceDiscoveryRoutes } from './inference-discovery.routes.js';
import { inferenceSetupRoutes } from './inference-setup.routes.js';
import { InferenceSetupEventsService } from './inference-setup-events.service.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({ APP_URL: 'https://gateway.example.com' }),
}));

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-users',
  scopes: ['feat:ai:use', 'inference:tokens:manage'],
  isBlocked: false,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/.well-known', inferenceDiscoveryRoutes);
  app.route('/api/inference/setup', inferenceSetupRoutes);
  return app;
}

function registerServices() {
  const oauth = {
    getIssuerUrl: vi.fn().mockReturnValue('https://gateway.example.com'),
    getInferenceSetupResourceUrl: vi.fn().mockReturnValue('https://gateway.example.com/api/inference/setup'),
    validateAccessToken: vi.fn().mockResolvedValue({
      user: USER,
      scopes: ['inference:setup'],
      tokenId: 'oauth-token-1',
      tokenPrefix: 'gwo_valid',
      clientId: 'goc_cli',
    }),
  };
  const tokens = {
    listManagedTokens: vi.fn().mockResolvedValue([]),
    createManagedToken: vi.fn().mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Codex · laptop',
      prefix: 'gwi_12345678',
      token: `gwi_${'a'.repeat(64)}`,
      harness: 'codex',
      deviceName: 'laptop',
      installationId: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-07-28T00:00:00.000Z',
      lastUsedAt: null,
    }),
    revokeManagedToken: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(OAuthService, oauth as unknown as OAuthService);
  container.registerInstance(GeneralSettingsService, {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockResolvedValue({
      features: { inferenceEnabled: true },
    }),
  } as unknown as GeneralSettingsService);
  container.registerInstance(InferenceTokenService, tokens as unknown as InferenceTokenService);
  container.registerInstance(InferenceModelService, {
    listForUser: vi.fn().mockResolvedValue({ data: [] }),
  } as unknown as InferenceModelService);
  const eventBus = new EventBusService();
  container.registerInstance(InferenceSetupEventsService, new InferenceSetupEventsService(eventBus));
  return { oauth, tokens };
}

afterEach(() => container.reset());

describe('inference setup discovery and control plane', () => {
  it('advertises disabled instances without requiring authentication', async () => {
    registerServices();
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled: vi.fn().mockResolvedValue(false),
      getConfig: vi.fn().mockResolvedValue({
        features: { inferenceEnabled: false },
        inference: {},
      }),
    } as unknown as GeneralSettingsService);

    const response = await createApp().request('/.well-known/wiolett-inference');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 2,
      enabled: false,
      minimumCliVersion: '0.3.0',
      oauth: { resource: 'https://gateway.example.com/api/inference/setup' },
      adapters: {
        openai: { baseUrl: 'https://gateway.example.com/api/inference/v1' },
        anthropic: { baseUrl: 'https://gateway.example.com/api/inference' },
      },
    });
  });

  it('rejects non-setup credentials and isolates OAuth validation to the setup resource', async () => {
    const { oauth } = registerServices();
    const app = createApp();

    const ordinary = await app.request('/api/inference/setup/me', {
      headers: { Authorization: 'Bearer gw_not_setup' },
    });
    const inference = await app.request('/api/inference/setup/me', {
      headers: { Authorization: 'Bearer gwi_not_setup' },
    });
    const setup = await app.request('/api/inference/setup/me', {
      headers: { Authorization: 'Bearer gwo_setup' },
    });

    expect(ordinary.status).toBe(401);
    expect(inference.status).toBe(401);
    expect(setup.status).toBe(200);
    expect(oauth.validateAccessToken).toHaveBeenCalledWith('gwo_setup', {
      resource: 'https://gateway.example.com/api/inference/setup',
    });
  });

  it('returns identity and performs owned managed-token lifecycle operations', async () => {
    const { tokens } = registerServices();
    const app = createApp();
    const headers = { Authorization: 'Bearer gwo_setup', 'Content-Type': 'application/json' };
    const installationId = '33333333-3333-4333-8333-333333333333';

    const me = await app.request('/api/inference/setup/me', { headers });
    const list = await app.request('/api/inference/setup/tokens', { headers });
    const create = await app.request('/api/inference/setup/tokens', {
      method: 'POST',
      headers,
      body: JSON.stringify({ harness: 'codex', deviceName: 'laptop', installationId }),
    });
    const revoke = await app.request('/api/inference/setup/tokens/22222222-2222-4222-8222-222222222222', {
      method: 'DELETE',
      headers,
    });

    expect(await me.json()).toMatchObject({
      user: { id: USER.id, email: USER.email, role: USER.groupName },
      inference: { enabled: true, allowed: true },
      catalogVersion: expect.any(String),
    });
    expect(await list.json()).toEqual({ data: [] });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ token: `gwi_${'a'.repeat(64)}` });
    expect(revoke.status).toBe(204);
    expect(tokens.createManagedToken).toHaveBeenCalledWith(USER.id, {
      harness: 'codex',
      deviceName: 'laptop',
      installationId,
    });
    expect(tokens.revokeManagedToken).toHaveBeenCalledWith(USER.id, '22222222-2222-4222-8222-222222222222');
  });

  it('accepts a dedicated Claude Code managed-token slot', async () => {
    const { tokens } = registerServices();
    const installationId = '44444444-4444-4444-8444-444444444444';
    const response = await createApp().request('/api/inference/setup/tokens', {
      method: 'POST',
      headers: { Authorization: 'Bearer gwo_setup', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        harness: 'claude-code',
        deviceName: 'workstation',
        installationId,
      }),
    });

    expect(response.status).toBe(201);
    expect(tokens.createManagedToken).toHaveBeenCalledWith(USER.id, {
      harness: 'claude-code',
      deviceName: 'workstation',
      installationId,
    });
  });

  it('opens an authenticated event stream with current catalog state', async () => {
    registerServices();
    const response = await createApp().request('/api/inference/setup/events', {
      headers: { Authorization: 'Bearer gwo_setup' },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    container.resolve(InferenceSetupEventsService).publishCatalogChanged();
    const second = await reader.read();
    await reader.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(new TextDecoder().decode(first.value)).toContain('event: ready');
    expect(new TextDecoder().decode(first.value)).toContain('catalogVersion');
    expect(new TextDecoder().decode(second.value)).toContain('event: invalidate');
    expect(new TextDecoder().decode(second.value)).toContain('catalog.changed');
  });
});

describe('InferenceSetupEventsService', () => {
  it('publishes invalidations and replays events after a known event ID', () => {
    const service = new InferenceSetupEventsService(new EventBusService());
    const first = service.publishCatalogChanged();
    const second = service.publishCatalogChanged();

    expect(service.since(first.id)).toEqual([second]);
    expect(service.since('unknown')).toEqual([]);
  });

  it('invalidates catalogs after user and permission-group changes', () => {
    const eventBus = new EventBusService();
    const service = new InferenceSetupEventsService(eventBus);
    const observed: ReturnType<InferenceSetupEventsService['publishCatalogChanged']>[] = [];
    service.subscribe((event) => observed.push(event));

    eventBus.publish('user.changed', { id: USER.id, action: 'updated' });
    eventBus.publish('group.changed', { id: USER.groupId, action: 'updated' });

    expect(observed).toHaveLength(2);
    expect(service.since(observed[0]!.id)).toEqual([observed[1]]);
  });
});
