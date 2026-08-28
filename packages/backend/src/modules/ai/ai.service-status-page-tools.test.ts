import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
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

function createService() {
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
    {} as never
  );
}

describe('AIService status page tool routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes status page settings reads and updates with operation-specific scopes', async () => {
    const statusPageService = {
      getConfig: vi.fn().mockResolvedValue({ enabled: true }),
      updateSettings: vi.fn().mockResolvedValue({ enabled: false }),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(statusPageService as never);
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:view'] }, 'manage_status_page', {
        resource: 'settings',
        operation: 'get',
      })
    ).resolves.toMatchObject({
      result: { enabled: true },
      invalidateStores: [],
    });

    const denied = await service.executeTool({ ...BASE_USER, scopes: ['status-page:view'] }, 'manage_status_page', {
      resource: 'settings',
      operation: 'update',
      payload: { enabled: false },
    });
    expect(denied.error).toBe('PERMISSION_DENIED: Missing required scope status-page:manage');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:manage'] }, 'manage_status_page', {
        resource: 'settings',
        operation: 'update',
        payload: { enabled: false },
      })
    ).resolves.toMatchObject({
      result: { enabled: false },
      invalidateStores: [],
    });
    expect(statusPageService.updateSettings).toHaveBeenCalledWith({ enabled: false }, 'user-1');
  });

  it('creates status page services after schema parsing', async () => {
    const statusPageService = {
      createService: vi.fn().mockResolvedValue({ id: 'service-1' }),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(statusPageService as never);
    const service = createService();
    const payload = {
      sourceType: 'proxy_host',
      sourceId: '550e8400-e29b-41d4-a716-446655440000',
      publicName: 'API',
      publicDescription: null,
      enabled: true,
    };

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:manage'] }, 'manage_status_page', {
        resource: 'services',
        operation: 'create',
        payload,
      })
    ).resolves.toMatchObject({
      result: { id: 'service-1' },
      invalidateStores: [],
    });
    expect(statusPageService.createService).toHaveBeenCalledWith(payload, 'user-1');
  });

  it('lists and updates incidents with the expected operation-specific methods', async () => {
    const statusPageService = {
      listIncidents: vi.fn().mockResolvedValue({ data: [] }),
      createIncidentUpdate: vi.fn().mockResolvedValue({ id: 'update-1' }),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(statusPageService as never);
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:view'] }, 'manage_status_page', {
        resource: 'incidents',
        operation: 'list',
        status: 'active',
        limit: '10',
      })
    ).resolves.toMatchObject({
      result: { data: [] },
      invalidateStores: [],
    });
    expect(statusPageService.listIncidents).toHaveBeenCalledWith({
      status: 'active',
      limit: 10,
      offset: 0,
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:incidents:update'] }, 'manage_status_page', {
        resource: 'incident_updates',
        operation: 'create_update',
        incidentId: 'incident-1',
        payload: { message: 'Investigating', status: 'investigating' },
      })
    ).resolves.toMatchObject({
      result: { id: 'update-1' },
      invalidateStores: [],
    });
    expect(statusPageService.createIncidentUpdate).toHaveBeenCalledWith(
      'incident-1',
      { message: 'Investigating', status: 'investigating' },
      'user-1'
    );
  });
});
