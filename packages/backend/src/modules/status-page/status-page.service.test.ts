import { describe, expect, it, vi } from 'vitest';
import {
  databaseConnections,
  dockerComposeProjects,
  dockerDeployments,
  dockerHealthChecks,
  nodes,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyHosts,
  settings,
  statusPageIncidents,
  statusPageServices,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { StatusPageService } from './status-page.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function createService(db: any, proxyService: any = {}) {
  const service = new StatusPageService(
    db,
    {
      upsertStatusPageSystemHost: vi.fn().mockResolvedValue({ id: 'proxy-status' }),
      disableStatusPageSystemHost: vi.fn().mockResolvedValue(null),
      ...proxyService,
    },
    { log: vi.fn().mockResolvedValue(undefined) } as any
  );
  service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
  return service;
}

function dbForSettings(node: any, cert: any = null) {
  return {
    query: {
      settings: { findFirst: vi.fn().mockResolvedValue(null) },
      nodes: { findFirst: vi.fn().mockResolvedValue(node) },
      sslCertificates: { findFirst: vi.fn().mockResolvedValue(cert) },
      nginxTemplates: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: (table: unknown) => ({
      values: (value: unknown) => ({
        onConflictDoUpdate: vi.fn().mockImplementation(async () => {
          expect(table).toBe(settings);
          return value;
        }),
      }),
    }),
  };
}

function dbForSettingsConfig(config: Record<string, unknown>, node: any = null) {
  return {
    query: {
      settings: { findFirst: vi.fn().mockResolvedValue({ value: config }) },
      nodes: { findFirst: vi.fn().mockResolvedValue(node) },
      sslCertificates: { findFirst: vi.fn().mockResolvedValue(null) },
      nginxTemplates: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: (table: unknown) => ({
      values: (value: unknown) => ({
        onConflictDoUpdate: vi.fn().mockImplementation(async () => {
          expect(table).toBe(settings);
          return value;
        }),
      }),
    }),
  };
}

describe('StatusPageService settings validation', () => {
  it('enforces the Personal entitlement at the shared service creation boundary', async () => {
    const service = createService({});
    service.setLicensePolicyService({
      requireFeature: vi.fn().mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'upgrade')),
    } as never);

    await expect(service.createService({} as never, USER_ID)).rejects.toMatchObject({
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
  });

  it('rejects enabling without an online nginx node', async () => {
    const service = createService(dbForSettings(null));

    await expect(
      service.updateSettings(
        {
          enabled: true,
          domain: 'status.example.com',
          nodeId: '22222222-2222-4222-8222-222222222222',
        },
        USER_ID
      )
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an active certificate that does not cover the status domain', async () => {
    const service = createService(
      dbForSettings(
        {
          id: '22222222-2222-4222-8222-222222222222',
          type: 'nginx',
          status: 'online',
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          status: 'active',
          domainNames: ['other.example.com'],
        }
      )
    );

    await expect(
      service.updateSettings(
        {
          enabled: true,
          domain: 'status.example.com',
          nodeId: '22222222-2222-4222-8222-222222222222',
          sslCertificateId: '33333333-3333-4333-8333-333333333333',
        },
        USER_ID
      )
    ).rejects.toBeInstanceOf(AppError);
  });

  it('creates the system proxy host when the enabled config is valid', async () => {
    const proxyService = { upsertStatusPageSystemHost: vi.fn().mockResolvedValue({ id: 'proxy-status' }) };
    const service = createService(
      dbForSettings(
        {
          id: '22222222-2222-4222-8222-222222222222',
          type: 'nginx',
          status: 'online',
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          status: 'active',
          domainNames: ['*.example.com'],
        }
      ),
      proxyService
    );

    const config = await service.updateSettings(
      {
        enabled: true,
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        sslCertificateId: '33333333-3333-4333-8333-333333333333',
      },
      USER_ID
    );

    expect(proxyService.upsertStatusPageSystemHost).toHaveBeenCalledWith(
      {
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        sslCertificateId: '33333333-3333-4333-8333-333333333333',
        nginxTemplateId: null,
        upstreamUrl: null,
      },
      USER_ID
    );
    expect(config.proxyHostId).toBe('proxy-status');
  });

  it('validates and applies a custom proxy template for the system proxy host', async () => {
    const proxyService = { upsertStatusPageSystemHost: vi.fn().mockResolvedValue({ id: 'proxy-status' }) };
    const db = dbForSettings({
      id: '22222222-2222-4222-8222-222222222222',
      type: 'nginx',
      status: 'online',
    });
    db.query.nginxTemplates.findFirst = vi.fn().mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      type: 'proxy',
    });
    const service = createService(db, proxyService);

    await service.updateSettings(
      {
        enabled: true,
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        proxyTemplateId: '44444444-4444-4444-8444-444444444444',
      },
      USER_ID
    );

    expect(proxyService.upsertStatusPageSystemHost).toHaveBeenCalledWith(
      {
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        sslCertificateId: null,
        nginxTemplateId: '44444444-4444-4444-8444-444444444444',
        upstreamUrl: null,
      },
      USER_ID
    );
  });

  it('applies a custom upstream URL for the system proxy host', async () => {
    const proxyService = { upsertStatusPageSystemHost: vi.fn().mockResolvedValue({ id: 'proxy-status' }) };
    const service = createService(
      dbForSettings({
        id: '22222222-2222-4222-8222-222222222222',
        type: 'nginx',
        status: 'online',
      }),
      proxyService
    );

    await service.updateSettings(
      {
        enabled: true,
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        upstreamUrl: 'http://172.16.20.60:3000',
      },
      USER_ID,
      ['proxy:raw:write']
    );

    expect(proxyService.upsertStatusPageSystemHost).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamUrl: 'http://172.16.20.60:3000',
      }),
      USER_ID
    );
  });

  it('rejects custom upstream changes without raw proxy permission', async () => {
    const service = createService(
      dbForSettings({
        id: '22222222-2222-4222-8222-222222222222',
        type: 'nginx',
        status: 'online',
      })
    );

    await expect(
      service.updateSettings(
        {
          enabled: true,
          domain: 'status.example.com',
          nodeId: '22222222-2222-4222-8222-222222222222',
          upstreamUrl: 'http://172.16.20.60:3000',
        },
        USER_ID,
        ['status-page:manage']
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('removes the system proxy host reference when disabled', async () => {
    const proxyService = { disableStatusPageSystemHost: vi.fn().mockResolvedValue({ id: 'proxy-status' }) };
    const service = createService(
      dbForSettingsConfig({
        enabled: true,
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        proxyHostId: 'proxy-status',
      }),
      proxyService
    );

    const config = await service.updateSettings({ enabled: false }, USER_ID);

    expect(proxyService.disableStatusPageSystemHost).toHaveBeenCalledWith(USER_ID);
    expect(config.enabled).toBe(false);
    expect(config.proxyHostId).toBeNull();
  });

  it('rejects moving an enabled status page to another nginx node', async () => {
    const service = createService(
      dbForSettingsConfig({
        enabled: true,
        domain: 'status.example.com',
        nodeId: '22222222-2222-4222-8222-222222222222',
        proxyHostId: 'proxy-status',
      })
    );

    await expect(
      service.updateSettings({ nodeId: '55555555-5555-4555-8555-555555555555' }, USER_ID)
    ).rejects.toMatchObject({ code: 'STATUS_PAGE_NODE_CHANGE_REQUIRES_DISABLE' });
  });

  it('syncs auto-incident thresholds to exposed services', async () => {
    const serviceThresholdUpdates: unknown[] = [];
    const db = {
      query: {
        settings: { findFirst: vi.fn().mockResolvedValue(null) },
        nodes: { findFirst: vi.fn().mockResolvedValue(null) },
        sslCertificates: { findFirst: vi.fn().mockResolvedValue(null) },
        nginxTemplates: { findFirst: vi.fn().mockResolvedValue(null) },
      },
      insert: (table: unknown) => ({
        values: (value: unknown) => ({
          onConflictDoUpdate: vi.fn().mockImplementation(async () => {
            expect(table).toBe(settings);
            return value;
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (value: unknown) => ({
          where: vi.fn().mockImplementation(async () => {
            expect(table).toBe(statusPageServices);
            serviceThresholdUpdates.push(value);
          }),
        }),
      }),
    };
    const service = createService(db);

    const config = await service.updateSettings(
      { autoCreateThresholdSeconds: 300, autoResolveThresholdSeconds: 120 },
      USER_ID
    );

    expect(config.autoCreateThresholdSeconds).toBe(300);
    expect(config.autoResolveThresholdSeconds).toBe(120);
    expect(serviceThresholdUpdates).toHaveLength(1);
    expect(serviceThresholdUpdates[0]).toMatchObject({
      createThresholdSeconds: 300,
      resolveThresholdSeconds: 120,
    });
  });
});

describe('StatusPageService shutdown snapshot', () => {
  it('primes and updates the synchronous public-host cache used by raw HTTP tracking', async () => {
    const db = dbForSettingsConfig(
      { enabled: true, domain: 'Status.Example.com' },
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'nginx',
        status: 'online',
      }
    );
    const service = createService(db);

    await service.primePublicHost();
    expect(service.isCachedStatusHost('status.example.com:443')).toBe(true);

    await service.updateSettings({ enabled: false }, USER_ID);
    expect(service.isCachedStatusHost('status.example.com')).toBe(false);
  });

  it('freezes the public host and DTO for the rest of the process lifetime', async () => {
    let config = { enabled: true, title: 'Before update', description: '', domain: 'status.example.com' };
    const db = {
      query: {
        settings: { findFirst: vi.fn(async () => ({ value: config })) },
        statusPageServices: { findMany: vi.fn().mockResolvedValue([]) },
        statusPageIncidents: { findMany: vi.fn().mockResolvedValue([]) },
        statusPageIncidentUpdates: { findMany: vi.fn().mockResolvedValue([]) },
      },
    };
    const service = createService(db);

    await service.freezePublicSnapshot();
    const frozen = await service.getPublicDto();
    config = { enabled: true, title: 'After update', description: '', domain: 'other.example.com' };

    expect((await service.getPublicDto())?.title).toBe('Before update');
    expect((await service.getPublicDto())?.generatedAt).toBe(frozen?.generatedAt);
    expect(await service.isStatusHost('status.example.com')).toBe(true);
    expect(await service.isStatusHost('other.example.com')).toBe(false);
  });
});

describe('StatusPageService safe DTO', () => {
  it('does not expose source identifiers or internal upstream fields', async () => {
    const historyTs = new Date().toISOString();
    const serviceRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        sourceType: 'proxy_host',
        sourceId: '55555555-5555-4555-8555-555555555555',
        publicName: 'Website',
        publicDescription: 'Public website',
        publicGroup: 'Edge',
        sortOrder: 0,
        enabled: true,
      },
    ];
    const proxyRows = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        isSystem: false,
        domainNames: ['internal.example.test'],
        forwardHost: '10.0.0.2',
        forwardPort: 8080,
        maintenanceEnabled: true,
        healthStatus: 'online',
        healthHistory: [{ ts: historyTs, status: 'online', responseMs: 12, slow: true }],
      },
    ];
    const db = {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue({
            value: { enabled: true, title: 'Status', description: '', domain: 'status.example.com' },
          }),
        },
        statusPageServices: { findMany: vi.fn().mockResolvedValue(serviceRows) },
        statusPageIncidents: { findMany: vi.fn().mockResolvedValue([]) },
        statusPageIncidentUpdates: { findMany: vi.fn().mockResolvedValue([]) },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === nodes) return [];
            if (table === proxyHosts) return proxyRows;
            if (table === databaseConnections) return [];
            if (table === statusPageServices) return serviceRows;
            return [];
          },
        }),
      }),
    };

    const dto = await createService(db).getPublicDto();
    const serialized = JSON.stringify(dto);

    expect(dto?.services[0]).toMatchObject({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Website',
      status: 'maintenance',
      healthHistory: [{ ts: historyTs, status: 'operational', slow: true }],
    });
    expect(dto?.overallStatus).toBe('maintenance');
    expect(serialized).not.toContain('55555555-5555-4555-8555-555555555555');
    expect(serialized).not.toContain('10.0.0.2');
    expect(serialized).not.toContain('8080');
    expect(serialized).not.toContain('internal.example.test');
  });

  it('uses recent node health history for node-backed service status', async () => {
    const historyTs = new Date().toISOString();
    const serviceRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        sourceType: 'node',
        sourceId: '22222222-2222-4222-8222-222222222222',
        publicName: 'Nginx',
        publicDescription: null,
        publicGroup: null,
        sortOrder: 0,
        enabled: true,
      },
    ];
    const nodeRows = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        displayName: 'nginx',
        hostname: 'daemon-nginx',
        status: 'online',
        healthHistory: [{ ts: historyTs, status: 'degraded' }],
      },
    ];
    const db = {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue({
            value: { enabled: true, title: 'Status', description: '', domain: 'status.example.com' },
          }),
        },
        statusPageServices: { findMany: vi.fn().mockResolvedValue(serviceRows) },
        statusPageIncidents: { findMany: vi.fn().mockResolvedValue([]) },
        statusPageIncidentUpdates: { findMany: vi.fn().mockResolvedValue([]) },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === nodes) return nodeRows;
            if (table === proxyHosts) return [];
            if (table === databaseConnections) return [];
            if (table === statusPageServices) return serviceRows;
            return [];
          },
        }),
      }),
    };

    const dto = await createService(db).getPublicDto();

    expect(dto?.services[0]).toMatchObject({
      name: 'Nginx',
      status: 'degraded',
      healthHistory: [{ ts: historyTs, status: 'degraded' }],
    });
  });

  it('does not expose incidents that only affect hidden services', async () => {
    const publicServiceId = '44444444-4444-4444-8444-444444444444';
    const hiddenServiceId = '99999999-9999-4999-8999-999999999999';
    const serviceRows = [
      {
        id: publicServiceId,
        sourceType: 'proxy_host',
        sourceId: '55555555-5555-4555-8555-555555555555',
        publicName: 'Website',
        publicDescription: null,
        publicGroup: null,
        sortOrder: 0,
        enabled: true,
      },
    ];
    const proxyRows = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        isSystem: false,
        domainNames: ['internal.example.test'],
        healthStatus: 'online',
        healthHistory: [],
      },
    ];
    const incidentRows = [
      {
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Hidden database outage',
        message: 'This should not be public',
        severity: 'critical',
        status: 'active',
        type: 'manual',
        affectedServiceIds: [hiddenServiceId],
        startedAt: new Date(),
        resolvedAt: null,
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        title: 'Public website issue',
        message: 'This should be public',
        severity: 'warning',
        status: 'active',
        type: 'manual',
        affectedServiceIds: [publicServiceId, hiddenServiceId],
        startedAt: new Date(),
        resolvedAt: null,
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        title: 'General maintenance',
        message: 'Global incident',
        severity: 'info',
        status: 'active',
        type: 'manual',
        affectedServiceIds: [],
        startedAt: new Date(),
        resolvedAt: null,
      },
    ];
    const db = {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue({
            value: { enabled: true, title: 'Status', description: '', domain: 'status.example.com' },
          }),
        },
        statusPageServices: { findMany: vi.fn().mockResolvedValue(serviceRows) },
        statusPageIncidents: { findMany: vi.fn().mockResolvedValue(incidentRows) },
        statusPageIncidentUpdates: { findMany: vi.fn().mockResolvedValue([]) },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === nodes) return [];
            if (table === proxyHosts) return proxyRows;
            if (table === databaseConnections) return [];
            if (table === statusPageServices) return serviceRows;
            return [];
          },
        }),
      }),
    };

    const dto = await createService(db).getPublicDto();

    expect(dto?.incidents.map((incident) => incident.title)).toEqual(['Public website issue', 'General maintenance']);
    expect(dto?.incidents[0].affectedServiceIds).toEqual([publicServiceId]);
    expect(JSON.stringify(dto)).not.toContain(hiddenServiceId);
    expect(JSON.stringify(dto)).not.toContain('This should not be public');
  });
});

describe('StatusPageService incident deletion', () => {
  it('applies incident pagination offset without loading the full history', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = createService({
      query: {
        statusPageIncidents: { findMany },
      },
    });

    await service.listIncidents({ status: 'all', limit: 20, offset: 40 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
        offset: 40,
      })
    );
  });

  it('rejects deleting active incidents', async () => {
    const service = createService({
      query: {
        statusPageIncidents: {
          findFirst: vi.fn().mockResolvedValue({
            id: '66666666-6666-4666-8666-666666666666',
            status: 'active',
            severity: 'critical',
            type: 'manual',
          }),
        },
      },
    });

    await expect(service.deleteIncident('66666666-6666-4666-8666-666666666666', USER_ID)).rejects.toBeInstanceOf(
      AppError
    );
  });

  it('deletes resolved incidents', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const deleteMock = vi.fn().mockReturnValue({ where });
    const service = createService({
      query: {
        statusPageIncidents: {
          findFirst: vi.fn().mockResolvedValue({
            id: '77777777-7777-4777-8777-777777777777',
            status: 'resolved',
            severity: 'info',
            type: 'automatic',
          }),
        },
      },
      delete: deleteMock,
    });

    await service.deleteIncident('77777777-7777-4777-8777-777777777777', USER_ID);

    expect(deleteMock).toHaveBeenCalledWith(statusPageIncidents);
    expect(where).toHaveBeenCalledOnce();
  });
});

describe('StatusPageService Docker sources', () => {
  it('resolves Docker, Compose, and Pages health sources', async () => {
    const containerServiceId = '11111111-1111-4111-8111-111111111112';
    const deploymentServiceId = '11111111-1111-4111-8111-111111111113';
    const containerCheckId = '22222222-2222-4222-8222-222222222222';
    const deploymentId = '33333333-3333-4333-8333-333333333333';
    const composeServiceId = '11111111-1111-4111-8111-111111111114';
    const composeProjectId = '55555555-5555-4555-8555-555555555555';
    const pagesServiceId = '11111111-1111-4111-8111-111111111115';
    const pageProjectId = '66666666-6666-4666-8666-666666666666';
    const pageDeploymentId = '77777777-7777-4777-8777-777777777777';
    const serviceRows = [
      {
        id: containerServiceId,
        sourceType: 'docker_container',
        sourceId: containerCheckId,
      },
      {
        id: deploymentServiceId,
        sourceType: 'docker_deployment',
        sourceId: deploymentId,
      },
      {
        id: composeServiceId,
        sourceType: 'docker_compose_project',
        sourceId: composeProjectId,
      },
      {
        id: pagesServiceId,
        sourceType: 'pages_project',
        sourceId: pageProjectId,
      },
    ];
    const containerCheck = {
      id: containerCheckId,
      target: 'container',
      containerName: 'api',
      healthStatus: 'online',
      healthHistory: [{ ts: new Date().toISOString(), status: 'online' }],
    };
    const deploymentCheck = {
      id: '44444444-4444-4444-8444-444444444444',
      target: 'deployment',
      deploymentId,
      healthStatus: 'degraded',
      healthHistory: [{ ts: new Date().toISOString(), status: 'degraded' }],
    };
    const deployment = {
      id: deploymentId,
      name: 'web',
    };
    const composeProject = {
      id: composeProjectId,
      name: 'Storefront',
      status: 'running',
      availability: 'available',
    };
    const pageProject = {
      id: pageProjectId,
      name: 'Docs',
      migrationStatus: null,
    };
    const latestTag = {
      projectId: pageProjectId,
      name: 'latest',
      deploymentId: pageDeploymentId,
    };
    const pageDeployment = {
      id: pageDeploymentId,
      status: 'ready',
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === nodes) return [];
            if (table === proxyHosts) return [];
            if (table === databaseConnections) return [];
            if (table === dockerHealthChecks) return [containerCheck, deploymentCheck];
            if (table === dockerDeployments) return [deployment];
            if (table === dockerComposeProjects) return [composeProject];
            if (table === pageProjects) return [pageProject];
            if (table === pageTags) return [latestTag];
            if (table === pageDeployments) return [pageDeployment];
            return [];
          },
        }),
      }),
    };

    const sources = await createService(db).resolveSources(serviceRows as never);

    expect(sources.get(containerServiceId)).toMatchObject({
      label: 'api',
      rawStatus: 'online',
      status: 'operational',
    });
    expect(sources.get(deploymentServiceId)).toMatchObject({
      label: 'web',
      rawStatus: 'degraded',
      status: 'degraded',
    });
    expect(sources.get(composeServiceId)).toMatchObject({
      label: 'Storefront',
      rawStatus: 'online',
      status: 'operational',
    });
    expect(sources.get(pagesServiceId)).toMatchObject({
      label: 'Docs',
      rawStatus: 'online',
      status: 'operational',
    });
  });
});

describe('StatusPageService ordering', () => {
  it('persists the complete service order atomically', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const updates: Array<{ id: string; sortOrder: number }> = [];
    const findMany = vi.fn().mockResolvedValue(ids.map((id) => ({ id })));
    const db = {
      query: { statusPageServices: { findMany } },
      transaction: async (work: (tx: any) => Promise<void>) =>
        work({
          update: () => ({
            set: (values: { sortOrder: number }) => ({
              where: (condition: { queryChunks?: unknown[] }) => {
                const id = ids[updates.length]!;
                updates.push({ id, sortOrder: values.sortOrder });
                return condition;
              },
            }),
          }),
        }),
    };
    const service = createService(db);

    await service.reorderServices([...ids].reverse(), USER_ID);

    expect(updates.map((update) => update.sortOrder)).toEqual([0, 1]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('rejects partial reorder payloads', async () => {
    const db = {
      query: {
        statusPageServices: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: '11111111-1111-4111-8111-111111111111' },
              { id: '22222222-2222-4222-8222-222222222222' },
            ]),
        },
      },
    };

    await expect(
      createService(db).reorderServices(['11111111-1111-4111-8111-111111111111'], USER_ID)
    ).rejects.toMatchObject({ code: 'STATUS_PAGE_REORDER_INVALID' });
  });
});
