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
    // Like the route, the caller scopes reach the service (custom upstream edits need proxy:raw:write).
    expect(statusPageService.updateSettings).toHaveBeenCalledWith({ enabled: false }, 'user-1', ['status-page:manage']);
  });

  it('reorders status page services with status-page:manage and the route schema', async () => {
    const serviceIds = ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'];
    const statusPageService = {
      reorderServices: vi.fn().mockResolvedValue([{ id: serviceIds[1] }, { id: serviceIds[0] }]),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(statusPageService as never);
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:view'] }, 'manage_status_page', {
        resource: 'services',
        operation: 'reorder',
        payload: { serviceIds },
      })
    ).resolves.toMatchObject({ error: 'PERMISSION_DENIED: Missing required scope status-page:manage' });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:manage'] }, 'manage_status_page', {
        resource: 'services',
        operation: 'reorder',
        payload: { serviceIds: [serviceIds[0], serviceIds[0]] },
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Service ids must be unique') });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:manage'] }, 'manage_status_page', {
        resource: 'services',
        operation: 'reorder',
        payload: { serviceIds: [...serviceIds].reverse() },
      })
    ).resolves.toMatchObject({ result: [{ id: serviceIds[1] }, { id: serviceIds[0] }] });
    expect(statusPageService.reorderServices).toHaveBeenCalledTimes(1);
    expect(statusPageService.reorderServices).toHaveBeenCalledWith([...serviceIds].reverse(), 'user-1');
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
    // The caller scopes go along so the service refuses a source the caller cannot view.
    expect(statusPageService.createService).toHaveBeenCalledWith(payload, 'user-1', ['status-page:manage']);
  });

  it('lists exposable sources with the caller scopes like GET /status-page/sources', async () => {
    const statusPageService = { listSources: vi.fn().mockResolvedValue([{ sourceType: 'node', sourceId: 'n1' }]) };
    vi.spyOn(container, 'resolve').mockReturnValue(statusPageService as never);
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:view'] }, 'manage_status_page', {
        resource: 'sources',
        operation: 'list',
      })
    ).resolves.toMatchObject({ error: 'PERMISSION_DENIED: Missing required scope status-page:manage' });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['status-page:manage', 'nodes:details'] }, 'manage_status_page', {
        resource: 'sources',
        operation: 'list',
      })
    ).resolves.toMatchObject({ result: [{ sourceType: 'node', sourceId: 'n1' }] });
    expect(statusPageService.listSources).toHaveBeenCalledWith(['status-page:manage', 'nodes:details']);
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
