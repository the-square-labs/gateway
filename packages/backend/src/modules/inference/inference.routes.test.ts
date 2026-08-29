import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { InferenceUsageService } from './accounting/inference-usage.service.js';
import { inferenceManagementRoutes } from './inference.routes.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';
import { InferenceModelConfigurationService } from './models/inference-model-configuration.service.js';
import { InferenceOAuthService } from './providers/inference-oauth.service.js';
import { InferenceProviderService } from './providers/inference-provider.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-users',
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

function createDb(user: User = USER) {
  return {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: user.id,
          oidcSubject: user.oidcSubject,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          groupId: user.groupId,
          additionalScopes: [],
          isBlocked: false,
        }),
      },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: user.groupId, parentId: null, name: user.groupName, scopes: user.scopes }]),
      },
    },
  };
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route('/api/inference', inferenceManagementRoutes);
  return app;
}

function registerSession(user: User = USER) {
  const session: SessionData = {
    userId: user.id,
    user,
    accessToken: 'oidc-access',
    csrfToken: 'csrf-token',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(session),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, createDb(user) as never);
}

afterEach(() => container.reset());

describe('inference management token routes', () => {
  it('lists, creates, and revokes tokens through a live browser session', async () => {
    registerSession();
    const service = {
      listTokens: vi.fn().mockResolvedValue([]),
      createToken: vi.fn().mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Codex',
        tokenPrefix: 'gwi_12345678',
        status: 'active',
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-07-24T00:00:00.000Z',
        token: `gwi_${'a'.repeat(64)}`,
      }),
      revokeToken: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(InferenceTokenService, service as unknown as InferenceTokenService);
    const app = createApp();
    const sessionHeaders = { Cookie: 'session_id=session-1' };
    const mutationHeaders = {
      ...sessionHeaders,
      'X-CSRF-Token': 'csrf-token',
      'Content-Type': 'application/json',
    };

    const list = await app.request('/api/inference/tokens', { headers: sessionHeaders });
    const create = await app.request('/api/inference/tokens', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ name: 'Codex' }),
    });
    const revoke = await app.request('/api/inference/tokens/22222222-2222-4222-8222-222222222222', {
      method: 'DELETE',
      headers: mutationHeaders,
    });

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ token: `gwi_${'a'.repeat(64)}` });
    expect(revoke.status).toBe(204);
    expect(service.createToken).toHaveBeenCalledWith(USER.id, { name: 'Codex' });
    expect(service.revokeToken).toHaveBeenCalledWith(USER.id, '22222222-2222-4222-8222-222222222222');
  });

  it('rejects ordinary and inference bearer tokens from browser-only management routes', async () => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: USER,
        scopes: USER.scopes,
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as unknown as TokensService);
    const app = createApp();

    const ordinary = await app.request('/api/inference/tokens', {
      headers: { Authorization: 'Bearer gw_test' },
    });
    const inference = await app.request('/api/inference/tokens', {
      headers: { Authorization: 'Bearer gwi_test' },
    });

    expect(ordinary.status).toBe(403);
    expect(inference.status).toBe(401);
  });

  it('enforces provider scopes and never returns a connected secret', async () => {
    const providerAdmin = {
      ...USER,
      scopes: [...USER.scopes, 'inference:providers:view', 'inference:providers:manage'],
    };
    registerSession(providerAdmin);
    const connected = {
      id: '33333333-3333-4333-8333-333333333333',
      providerId: 'openai-apikey',
      name: 'Production',
      authType: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      accountExternalId: null,
      accountLabel: null,
      enabled: true,
      routingOrder: 0,
      status: 'healthy',
      healthReason: null,
      syncStatus: 'success',
      syncLastError: null,
      lastSyncedAt: '2026-07-24T00:00:00.000Z',
      nextSyncAt: '2026-07-24T00:05:00.000Z',
      metadata: {},
      createdBy: providerAdmin.id,
      deletedAt: null,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      credential: {
        connectionId: '33333333-3333-4333-8333-333333333333',
        kind: 'api_key',
        last4: 'cret',
        expiresAt: null,
      },
      discoveredModels: [],
      quota: [],
    };
    const providerService = {
      listCatalog: vi.fn().mockReturnValue([]),
      listConnections: vi.fn().mockResolvedValue([connected]),
      createKeyConnection: vi.fn().mockResolvedValue(connected),
    };
    container.registerInstance(InferenceProviderService, providerService as unknown as InferenceProviderService);
    const app = createApp();
    const headers = {
      Cookie: 'session_id=session-1',
      'X-CSRF-Token': 'csrf-token',
      'Content-Type': 'application/json',
    };

    const response = await app.request('/api/inference/providers/connections', {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: 'openai-apikey', name: 'Production', apiKey: 'super-secret' }),
    });

    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain('super-secret');
    expect(providerService.createKeyConnection).toHaveBeenCalledWith(
      providerAdmin.id,
      expect.objectContaining({ providerId: 'openai-apikey', apiKey: 'super-secret' })
    );
  });

  it('saves the complete model configuration through one atomic service call', async () => {
    const modelAdmin = { ...USER, scopes: [...USER.scopes, 'inference:models:manage'] };
    registerSession(modelAdmin);
    const modelId = '22222222-2222-4222-8222-222222222222';
    const service = { save: vi.fn().mockResolvedValue({ id: modelId, publicId: 'logical-model' }) };
    container.registerInstance(
      InferenceModelConfigurationService,
      service as unknown as InferenceModelConfigurationService
    );
    const payload = {
      model: {
        publicId: 'logical-model',
        displayName: 'Logical model',
        contextWindow: 100_000,
        maxInputTokens: 80_000,
        maxOutputTokens: 20_000,
        autoCompactTokenLimit: 70_000,
        modalities: ['text'],
        capabilities: { tools: true },
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        defaultAccessAllowed: true,
        subscriptionMultiplier: 1,
      },
      sources: [
        {
          connectionId: '33333333-3333-4333-8333-333333333333',
          discoveredModelId: '44444444-4444-4444-8444-444444444444',
          reasoningEffortMap: {},
        },
      ],
      access: { mode: 'everyone', subjects: [] },
    };

    const response = await createApp().request(`/api/inference/models/${modelId}/configuration`, {
      method: 'PUT',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(service.save).toHaveBeenCalledWith(modelAdmin.id, modelId, payload);
    expect(await response.json()).toMatchObject({ id: modelId, publicId: 'logical-model' });
  });

  it('persists model order through the batch reorder route', async () => {
    const modelAdmin = { ...USER, scopes: [...USER.scopes, 'inference:models:manage'] };
    registerSession(modelAdmin);
    const items = [
      { id: '22222222-2222-4222-8222-222222222222', sortOrder: 0 },
      { id: '33333333-3333-4333-8333-333333333333', sortOrder: 1 },
    ];
    const service = { reorder: vi.fn().mockResolvedValue(undefined) };
    container.registerInstance(InferenceModelService, service as unknown as InferenceModelService);

    const response = await createApp().request('/api/inference/models/reorder', {
      method: 'PUT',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items }),
    });

    expect(response.status).toBe(200);
    expect(service.reorder).toHaveBeenCalledWith(modelAdmin.id, items);
    expect(await response.json()).toEqual({ success: true });
  });

  it('passes a connection quota reserve through the provider management route', async () => {
    const providerAdmin = {
      ...USER,
      scopes: [...USER.scopes, 'inference:providers:view', 'inference:providers:manage'],
    };
    registerSession(providerAdmin);
    const connectionId = '33333333-3333-4333-8333-333333333333';
    const service = {
      updateConnection: vi.fn().mockResolvedValue({
        id: connectionId,
        minimumRemainingPercent: 25,
      }),
    };
    container.registerInstance(InferenceProviderService, service as unknown as InferenceProviderService);

    const response = await createApp().request(`/api/inference/providers/connections/${connectionId}`, {
      method: 'PATCH',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ minimumRemainingPercent: 25 }),
    });

    expect(response.status).toBe(200);
    expect(service.updateConnection).toHaveBeenCalledWith(providerAdmin.id, connectionId, {
      minimumRemainingPercent: 25,
    });
  });

  it('passes a monthly API limit through the provider management route', async () => {
    const providerAdmin = {
      ...USER,
      scopes: [...USER.scopes, 'inference:providers:view', 'inference:providers:manage'],
    };
    registerSession(providerAdmin);
    const connectionId = '33333333-3333-4333-8333-333333333333';
    const service = {
      updateConnection: vi.fn().mockResolvedValue({
        id: connectionId,
        apiMonthlyLimitMicrodollars: 25_000_000,
      }),
    };
    container.registerInstance(InferenceProviderService, service as unknown as InferenceProviderService);

    const response = await createApp().request(`/api/inference/providers/connections/${connectionId}`, {
      method: 'PATCH',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiMonthlyLimitMicrodollars: 25_000_000 }),
    });

    expect(response.status).toBe(200);
    expect(service.updateConnection).toHaveBeenCalledWith(providerAdmin.id, connectionId, {
      apiMonthlyLimitMicrodollars: 25_000_000,
    });
  });

  it('auto-polls OAuth status and synchronizes a newly completed connection', async () => {
    const providerAdmin = {
      ...USER,
      scopes: [...USER.scopes, 'inference:providers:view', 'inference:providers:manage'],
    };
    registerSession(providerAdmin);
    const connectionId = '33333333-3333-4333-8333-333333333333';
    const oauthService = {
      status: vi.fn().mockResolvedValue({
        id: '55555555-5555-4555-8555-555555555555',
        providerId: 'openai',
        status: 'complete',
        authorizationUrl: 'https://auth.example/device',
        completionMode: 'device_poll',
        connectionId,
        expiresAt: '2026-07-24T00:10:00.000Z',
      }),
    };
    const providerService = { syncConnection: vi.fn().mockResolvedValue({ id: connectionId }) };
    container.registerInstance(InferenceOAuthService, oauthService as unknown as InferenceOAuthService);
    container.registerInstance(InferenceProviderService, providerService as unknown as InferenceProviderService);

    const response = await createApp().request('/api/inference/providers/oauth/55555555-5555-4555-8555-555555555555', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(oauthService.status).toHaveBeenCalledWith(providerAdmin.id, '55555555-5555-4555-8555-555555555555');
    expect(providerService.syncConnection).toHaveBeenCalledWith(connectionId, true);
  });

  it('does not expose the legacy non-atomic model creation route', async () => {
    const modelAdmin = {
      ...USER,
      scopes: [...USER.scopes, 'inference:models:manage'],
    };
    registerSession(modelAdmin);
    const app = createApp();
    const response = await app.request('/api/inference/models', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        publicId: 'kimi-k3',
        displayName: 'Kimi K3',
        contextWindow: 256000,
        maxInputTokens: 240000,
        maxOutputTokens: 16000,
        autoCompactTokenLimit: 220000,
        modalities: ['text'],
        capabilities: { tools: true, reasoning: true },
        reasoningEfforts: ['high', 'ultra'],
        defaultReasoningEffort: 'high',
        defaultAccessAllowed: true,
        subscriptionMultiplier: 3,
      }),
    });

    expect(response.status).toBe(404);
  });

  it('does not expose legacy non-atomic model source mutations', async () => {
    const modelAdmin = { ...USER, scopes: [...USER.scopes, 'inference:models:manage'] };
    registerSession(modelAdmin);
    const response = await createApp().request('/api/inference/models/sources/66666666-6666-4666-8666-666666666666', {
      method: 'DELETE',
      headers: { Cookie: 'session_id=session-1', 'X-CSRF-Token': 'csrf-token' },
    });

    expect(response.status).toBe(404);
  });

  it('returns only percentages and recovery times from self usage', async () => {
    registerSession(USER);
    container.registerInstance(InferenceUsageService, {
      self: vi.fn().mockResolvedValue({
        enabled: true,
        api: { configured: true, percentage: 20, recoveryAt: '2026-08-01T00:00:00.000Z' },
        subscription: {
          '5h': { configured: true, percentage: 10, recoveryAt: '2026-07-24T05:00:00.000Z' },
          '7d': { configured: false, percentage: 30, recoveryAt: '2026-07-31T00:00:00.000Z' },
          '30d': { configured: true, percentage: 40, recoveryAt: '2026-08-23T00:00:00.000Z' },
        },
      }),
    } as unknown as InferenceUsageService);
    const app = createApp();
    const response = await app.request('/api/inference/usage/self', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).api.configured).toBe(true);
    expect(text).toContain('percentage');
    expect(text).not.toMatch(/credits|microdollars|tokens|price/i);
  });

  it('returns 30-day usage totals scoped to the current user', async () => {
    registerSession(USER);
    const overview = {
      windowDays: 30,
      requestTotals: [{ status: 'completed', requests: 4, credits: '2', apiMicrodollars: 100, tokens: 500 }],
      ledgerTotals: [{ budgetType: 'api', credits: '2', apiMicrodollars: 100, tokens: 500 }],
      dailyUsage: [{ date: '2026-08-28', requests: 4, credits: 2, apiMicrodollars: 100, tokens: 500 }],
    };
    const selfOverview = vi.fn().mockResolvedValue(overview);
    container.registerInstance(InferenceUsageService, { selfOverview } as unknown as InferenceUsageService);

    const response = await createApp().request('/api/inference/usage/self/overview', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(overview);
    expect(selfOverview).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }));
  });

  it('accepts independently disabled rolling windows in the default limit policy', async () => {
    const limitsAdmin = { ...USER, scopes: [...USER.scopes, 'inference:limits:manage'] };
    registerSession(limitsAdmin);
    const service = { setDefault: vi.fn().mockResolvedValue([]) };
    container.registerInstance(InferenceUsageService, service as unknown as InferenceUsageService);
    const payload = {
      enabled: true,
      credits5hEnabled: false,
      credits5h: 100,
      credits7dEnabled: true,
      credits7d: 500,
      credits30dEnabled: false,
      credits30d: 1_000,
      apiMonthlyMicrodollars: 0,
      billingTimezone: 'Europe/Chisinau',
    };

    const response = await createApp().request('/api/inference/limits/default', {
      method: 'PUT',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(service.setDefault).toHaveBeenCalledWith(limitsAdmin.id, payload);
  });

  it('resets all usage windows for one user', async () => {
    const limitsAdmin = { ...USER, scopes: [...USER.scopes, 'inference:limits:manage'] };
    registerSession(limitsAdmin);
    const service = {
      resetUserLimits: vi.fn().mockResolvedValue({
        resetAt: '2026-08-28T12:00:00.000Z',
        usage: { credits5h: 0, credits7d: 0, credits30d: 0, apiMonthlyMicrodollars: 0, recoveryAt: {} },
      }),
    };
    container.registerInstance(InferenceUsageService, service as unknown as InferenceUsageService);

    const response = await createApp().request(`/api/inference/limits/users/${USER.id}/reset`, {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'X-CSRF-Token': 'csrf-token' },
    });

    expect(response.status).toBe(200);
    expect(service.resetUserLimits).toHaveBeenCalledWith(limitsAdmin.id, USER.id);
  });

  it('lets limits-only administrators list users without receiving usage data', async () => {
    const limitsAdmin = { ...USER, scopes: [...USER.scopes, 'inference:limits:manage'] };
    registerSession(limitsAdmin);
    const rows = [
      {
        id: USER.id,
        email: USER.email,
        name: USER.name,
        avatarUrl: null,
        limits: { enabled: true },
        usage: null,
      },
    ];
    const service = { limitUsers: vi.fn().mockResolvedValue(rows) };
    container.registerInstance(InferenceUsageService, service as unknown as InferenceUsageService);

    const response = await createApp().request('/api/inference/limits/users', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rows);
    expect(service.limitUsers).toHaveBeenCalledOnce();
  });

  it('returns server-paged activity and forwards search filters', async () => {
    const usageAdmin = { ...USER, scopes: [...USER.scopes, 'inference:usage:view'] };
    registerSession(usageAdmin);
    const service = {
      activity: vi.fn().mockResolvedValue({ data: [{ id: 'request-1' }], nextPage: 3 }),
    };
    container.registerInstance(InferenceUsageService, service as unknown as InferenceUsageService);

    const response = await createApp().request(
      `/api/inference/usage/activity?page=2&limit=6&search=kimi&status=completed&userId=${USER.id}&model=kimi-k3`,
      { headers: { Cookie: 'session_id=session-1' } }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: 'request-1' }], nextPage: 3 });
    expect(service.activity).toHaveBeenCalledWith({
      page: 2,
      limit: 6,
      search: 'kimi',
      status: 'completed',
      userId: USER.id,
      model: 'kimi-k3',
    });
  });

  it('returns activity filter options for usage administrators', async () => {
    const usageAdmin = { ...USER, scopes: [...USER.scopes, 'inference:usage:view'] };
    registerSession(usageAdmin);
    const filters = {
      users: [{ id: USER.id, name: USER.name, email: USER.email, avatarUrl: USER.avatarUrl }],
      models: ['gpt-5.6', 'kimi-k3'],
    };
    const service = { activityFilters: vi.fn().mockResolvedValue(filters) };
    container.registerInstance(InferenceUsageService, service as unknown as InferenceUsageService);

    const response = await createApp().request('/api/inference/usage/activity/filters', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(filters);
    expect(service.activityFilters).toHaveBeenCalledOnce();
  });
});
