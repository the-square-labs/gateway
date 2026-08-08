import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService({
  notifRuleService,
  notifWebhookService,
  notifDeliveryService,
  notifDispatcherService,
  siemDestinationService,
  siemDeliveryService,
  generalSettingsService = { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
}: {
  notifRuleService?: Record<string, unknown>;
  notifWebhookService?: Record<string, unknown>;
  notifDeliveryService?: Record<string, unknown>;
  notifDispatcherService?: Record<string, unknown>;
  siemDestinationService?: Record<string, unknown>;
  siemDeliveryService?: Record<string, unknown>;
  generalSettingsService?: Record<string, unknown>;
} = {}) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifRuleService as never,
    notifWebhookService as never,
    notifDeliveryService as never,
    notifDispatcherService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    siemDestinationService as never,
    siemDeliveryService as never,
    generalSettingsService as never
  );
}

describe('AIService notification tool routing', () => {
  it('returns a clear tool result when notification services are unavailable', async () => {
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['notifications:view'] }, 'list_alert_rules', {})
    ).resolves.toEqual({
      result: { error: 'Notification service not available' },
      invalidateStores: [],
    });
  });

  it('creates alert rules with existing AI defaults', async () => {
    const notifRuleService = {
      create: vi.fn().mockResolvedValue({ id: 'rule-1' }),
    };
    const service = createService({ notifRuleService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['notifications:manage'] }, 'create_alert_rule', {
        name: 'CPU High',
        type: 'threshold',
        category: 'node',
        severity: 'warning',
        webhookIds: ['webhook-1'],
      })
    ).resolves.toMatchObject({
      result: { id: 'rule-1' },
      invalidateStores: [],
    });
    expect(notifRuleService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'CPU High',
        durationSeconds: 0,
        fireThresholdPercent: 100,
        resolveAfterSeconds: 60,
        resolveThresholdPercent: 100,
        resourceIds: [],
        webhookIds: ['webhook-1'],
        cooldownSeconds: 900,
        enabled: true,
      }),
      'user-1'
    );
  });

  it('creates webhooks with default POST method, signing header, and enabled state', async () => {
    const notifWebhookService = {
      create: vi.fn().mockResolvedValue({ id: 'webhook-1' }),
    };
    const service = createService({ notifWebhookService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['notifications:manage'] }, 'create_webhook', {
        name: 'Discord',
        url: 'https://example.test/webhook',
      })
    ).resolves.toMatchObject({
      result: { id: 'webhook-1' },
      invalidateStores: [],
    });
    expect(notifWebhookService.create).toHaveBeenCalledWith(
      {
        name: 'Discord',
        url: 'https://example.test/webhook',
        method: 'POST',
        templatePreset: undefined,
        bodyTemplate: undefined,
        signingSecret: undefined,
        signingHeader: 'X-Signature-256',
        enabled: true,
        headers: {},
      },
      'user-1'
    );
  });

  it('dispatches test webhooks using the raw webhook and a sample event', async () => {
    const webhook = { id: 'webhook-1', name: 'Discord' };
    const notifWebhookService = {
      getRaw: vi.fn().mockResolvedValue(webhook),
    };
    const notifDispatcherService = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    };
    const service = createService({ notifWebhookService, notifDispatcherService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['notifications:manage'] }, 'test_webhook', {
        webhookId: 'webhook-1',
      })
    ).resolves.toMatchObject({
      result: { success: true },
      invalidateStores: [],
    });
    expect(notifWebhookService.getRaw).toHaveBeenCalledWith('webhook-1');
    expect(notifDispatcherService.dispatch).toHaveBeenCalledWith(webhook, expect.any(Object), true);
  });

  it('lists webhook deliveries with clamped agent limits and passthrough filters', async () => {
    const notifDeliveryService = {
      list: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    const service = createService({ notifDeliveryService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['notifications:view'] }, 'list_webhook_deliveries', {
        webhookId: 'webhook-1',
        status: 'failed',
        limit: 999,
      })
    ).resolves.toMatchObject({
      result: { data: [], total: 0 },
      invalidateStores: [],
    });
    expect(notifDeliveryService.list).toHaveBeenCalledWith({
      page: 1,
      limit: 100,
      webhookId: 'webhook-1',
      status: 'failed',
    });
  });

  it('creates SIEM destinations with a one-time secret and returns only safe service output', async () => {
    const siemDestinationService = {
      create: vi.fn().mockResolvedValue({ id: 'siem-1', secretConfigured: true }),
    };
    const service = createService({ siemDestinationService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['audit:siem:manage'] }, 'create_siem_destination', {
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'custom_header',
        customHeaderName: 'X-API-Key',
        secret: 'one-time-secret',
      })
    ).resolves.toMatchObject({
      result: { id: 'siem-1', secretConfigured: true },
      invalidateStores: [],
    });
    expect(siemDestinationService.create).toHaveBeenCalledWith(
      {
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'custom_header',
        customHeaderName: 'X-API-Key',
        secret: 'one-time-secret',
        enabled: true,
      },
      'user-1'
    );
  });

  it('validates AI SIEM destination mutations with the HTTP route schema', async () => {
    const siemDestinationService = {
      create: vi.fn(),
      update: vi.fn(),
    };
    const service = createService({ siemDestinationService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['audit:siem:manage'] }, 'create_siem_destination', {
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'custom_header',
        customHeaderName: 'Host',
        secret: 'one-time-secret',
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('Custom header name cannot override a Gateway transport header'),
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['audit:siem:manage'] }, 'update_siem_destination', {
        destinationId: 'siem-1',
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('Provide at least one destination field to update'),
    });

    expect(siemDestinationService.create).not.toHaveBeenCalled();
    expect(siemDestinationService.update).not.toHaveBeenCalled();
  });

  it('lists SIEM deliveries with a clamped page size', async () => {
    const siemDeliveryService = { list: vi.fn().mockResolvedValue({ data: [], total: 0 }) };
    const service = createService({ siemDeliveryService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['audit:siem:view'] }, 'list_siem_deliveries', {
        status: 'failed',
        limit: 999,
      })
    ).resolves.toMatchObject({ result: { data: [], total: 0 } });
    expect(siemDeliveryService.list).toHaveBeenCalledWith({
      page: 1,
      limit: 100,
      destinationId: undefined,
      status: 'failed',
    });
  });

  it('does not invoke SIEM tools while the Gateway SIEM feature is disabled', async () => {
    const siemDestinationService = { list: vi.fn() };
    const generalSettingsService = { isFeatureEnabled: vi.fn().mockResolvedValue(false) };
    const service = createService({ siemDestinationService, generalSettingsService });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['audit:siem:view'] }, 'list_siem_destinations', {})
    ).resolves.toEqual({
      result: { error: 'SIEM feature is disabled' },
      invalidateStores: [],
    });

    expect(generalSettingsService.isFeatureEnabled).toHaveBeenCalledWith('siemEnabled');
    expect(siemDestinationService.list).not.toHaveBeenCalled();
  });
});
