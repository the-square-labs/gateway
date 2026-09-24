import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
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

const COMPACT_HOST = {
  id: '77777777-7777-4777-8777-777777777771',
  slug: 'app-example-com',
  type: 'proxy',
  domainNames: ['app.example.com'],
  enabled: true,
  nodeId: '11111111-1111-4111-8111-111111111111',
  upstreamKind: 'manual',
  forwardScheme: 'http',
  forwardHost: 'app',
  forwardPort: 3000,
  sslEnabled: true,
  sslForced: false,
  sslCertificateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  accessListId: '22222222-2222-4222-8222-222222222221',
  healthCheckEnabled: true,
  healthStatus: 'healthy',
  effectiveHealthStatus: 'healthy',
  lastHealthCheckAt: '2026-06-20T00:00:00.000Z',
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
};

const FULL_HOST = {
  ...COMPACT_HOST,
  rawConfig: 'server { deny all; }',
  rawConfigEnabled: true,
  advancedConfig: 'proxy_set_header X-Test true;',
};

function createService(proxyService: Record<string, unknown>, folderService: Record<string, unknown> = {}) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    proxyService as never,
    { assertFolderExists: vi.fn().mockResolvedValue(undefined), ...folderService } as never,
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

describe('AIService proxy tool routing', () => {
  afterEach(() => container.reset());

  it('keeps object upload bytes out of embedded AI execution', async () => {
    await expect(
      createService({}).executeTool({ ...BASE_USER, scopes: ['storage:objects:write'] }, 'upload_storage_object', {
        operation: 'begin',
        storageId: 'storage-1',
      })
    ).resolves.toEqual({
      error: 'Tool upload_storage_object is available only through remote MCP',
      invalidateStores: [],
    });
  });

  it('keeps binary Pages upload out of the embedded AI execution surface', async () => {
    const service = createService({});

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['pages:deploy:33333333-3333-4333-8333-333333333331'] },
        'upload_pages_artifact',
        {
          operation: 'begin',
          projectId: '33333333-3333-4333-8333-333333333331',
          declaredSizeBytes: 4,
          sha256: 'a'.repeat(64),
        }
      )
    ).resolves.toEqual({
      error: 'Tool upload_pages_artifact is available only through remote MCP',
      invalidateStores: [],
    });
  });

  it('routes proxy host list/get/create/delete operations through proxy service and compacts host output', async () => {
    const proxyService = {
      listProxyHosts: vi.fn().mockResolvedValue({ data: [FULL_HOST], total: 1 }),
      getProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      createProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      deleteProxyHost: vi.fn().mockResolvedValue(undefined),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:view'] }, 'list_routes', {
        search: 'app',
        page: 2,
        limit: 25,
      })
    ).resolves.toEqual({ result: { data: [COMPACT_HOST], total: 1 }, invalidateStores: [] });
    expect(proxyService.listProxyHosts).toHaveBeenCalledWith(
      { search: 'app', page: 2, limit: 25 },
      { allowedIds: undefined }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:view:${COMPACT_HOST.id}`] }, 'get_route', {
        routeId: COMPACT_HOST.id,
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: [] });
    expect(proxyService.getProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', {
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['app.example.com'],
        forwardHost: 'app',
        forwardPort: 3000,
        sslEnabled: true,
        websocketSupport: true,
        accessListId: '22222222-2222-4222-8222-222222222221',
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'proxy',
        upstreamKind: 'manual',
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['app.example.com'],
        forwardHost: 'app',
        forwardPort: 3000,
        forwardScheme: 'http',
        sslEnabled: true,
        sslForced: false,
        http2Support: true,
        websocketSupport: true,
        sslCertificateId: undefined,
        redirectUrl: undefined,
        redirectStatusCode: undefined,
        customHeaders: [],
        cacheEnabled: false,
        cacheOptions: undefined,
        rateLimitEnabled: false,
        rateLimitOptions: undefined,
        customRewrites: [],
        accessListId: '22222222-2222-4222-8222-222222222221',
        nginxTemplateId: undefined,
        templateVariables: undefined,
        healthCheckEnabled: false,
        healthCheckUrl: undefined,
        healthCheckInterval: undefined,
        healthCheckExpectedStatus: undefined,
        healthCheckExpectedBody: undefined,
      }),
      'user-1',
      { actorScopes: ['proxy:create'], bypassAdvancedValidation: false }
    );

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['proxy:create:11111111-1111-4111-8111-111111111111'] },
        'create_route',
        {
          nodeId: '11111111-1111-4111-8111-111111111111',
          domainNames: ['scoped.example.com'],
          forwardHost: 'app',
          forwardPort: 3000,
        }
      )
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.createProxyHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeId: '11111111-1111-4111-8111-111111111111', domainNames: ['scoped.example.com'] }),
      'user-1',
      { actorScopes: ['proxy:create:11111111-1111-4111-8111-111111111111'], bypassAdvancedValidation: false }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:delete:${COMPACT_HOST.id}`] }, 'delete_route', {
        routeId: COMPACT_HOST.id,
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(proxyService.deleteProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id, 'user-1');
  });

  it('routes proxy host update with advanced config checks and rejects raw config edits', async () => {
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      updateProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      toggleProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);

    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [
            `proxy:edit:${COMPACT_HOST.id}`,
            `proxy:advanced:${COMPACT_HOST.id}`,
            `proxy:advanced:bypass:${COMPACT_HOST.id}`,
            'proxy:create:11111111-1111-4111-8111-111111111112',
          ],
        },
        'update_route',
        {
          routeId: COMPACT_HOST.id,
          domainNames: ['new.example.com'],
          nodeId: '11111111-1111-4111-8111-111111111112',
          type: 'proxy',
          forwardHost: 'new-app',
          forwardPort: 3001,
          forwardScheme: 'https',
          enabled: false,
          sslEnabled: true,
          sslForced: true,
          http2Support: true,
          websocketSupport: true,
          sslCertificateId: null,
          internalCertificateId: null,
          accessListId: null,
          folderId: null,
          nginxTemplateId: null,
          templateVariables: { upstreamName: 'new-app' },
          customHeaders: [{ name: 'X-Test', value: 'true' }],
          customRewrites: [{ source: '/old', destination: '/new', type: 'temporary' }],
          cacheEnabled: true,
          cacheOptions: { maxAge: 60 },
          rateLimitEnabled: true,
          rateLimitOptions: { requestsPerSecond: 5, burst: 10 },
          healthCheckEnabled: true,
          healthCheckUrl: '/health',
          healthCheckInterval: 15,
          healthCheckExpectedStatus: null,
          healthCheckExpectedBody: null,
          healthCheckBodyMatchMode: null,
          healthCheckSlowThreshold: 0,
          advancedConfig: 'proxy_set_header X-Test true;',
        }
      )
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(
      COMPACT_HOST.id,
      {
        domainNames: ['new.example.com'],
        nodeId: '11111111-1111-4111-8111-111111111112',
        type: 'proxy',
        forwardHost: 'new-app',
        forwardPort: 3001,
        forwardScheme: 'https',
        sslEnabled: true,
        sslForced: true,
        http2Support: true,
        websocketSupport: true,
        sslCertificateId: null,
        internalCertificateId: null,
        accessListId: null,
        nginxTemplateId: null,
        templateVariables: { upstreamName: 'new-app' },
        customHeaders: [{ name: 'X-Test', value: 'true' }],
        customRewrites: [{ source: '/old', destination: '/new', type: 'temporary' }],
        cacheEnabled: true,
        cacheOptions: { maxAge: 60 },
        rateLimitEnabled: true,
        rateLimitOptions: { requestsPerSecond: 5, burst: 10 },
        healthCheckEnabled: true,
        healthCheckUrl: '/health',
        healthCheckInterval: 15,
        healthCheckExpectedStatus: null,
        healthCheckExpectedBody: null,
        healthCheckBodyMatchMode: null,
        healthCheckSlowThreshold: 0,
        advancedConfig: 'proxy_set_header X-Test true;',
      },
      'user-1',
      {
        actorScopes: [
          `proxy:edit:${COMPACT_HOST.id}`,
          `proxy:advanced:${COMPACT_HOST.id}`,
          `proxy:advanced:bypass:${COMPACT_HOST.id}`,
          'proxy:create:11111111-1111-4111-8111-111111111112',
        ],
        bypassAdvancedValidation: true,
      }
    );
    // `enabled` is applied through the toggle lifecycle, not the update write.
    expect(proxyService.toggleProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id, false, 'user-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'update_route', {
        routeId: COMPACT_HOST.id,
        advancedConfig: 'proxy_set_header X-Other true;',
      })
    ).resolves.toEqual({ error: 'Advanced config requires proxy:advanced scope', invalidateStores: [] });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'update_route', {
        routeId: COMPACT_HOST.id,
        rawConfig: 'server {}',
      })
    ).resolves.toEqual({ error: 'Raw config changes require dedicated raw config tools', invalidateStores: [] });
  });

  it('preserves the scoped raw-validation bypass when enabling raw mode and requires route edit like PUT', async () => {
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue({ ...FULL_HOST, rawConfigEnabled: false }),
      updateProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);
    const toggleScopes = [`proxy:raw:toggle:${COMPACT_HOST.id}`, `proxy:raw:bypass:${COMPACT_HOST.id}`];

    // PUT {rawConfigEnabled} is not a raw-only update, so it also needs proxy:edit on the route.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: toggleScopes }, 'toggle_route_raw_mode', {
        routeId: COMPACT_HOST.id,
        enabled: true,
      })
    ).resolves.toEqual({
      error: `PERMISSION_DENIED: Missing required scope proxy:edit:${COMPACT_HOST.id}`,
      invalidateStores: [],
    });
    expect(proxyService.updateProxyHost).not.toHaveBeenCalled();

    const scopes = [...toggleScopes, `proxy:edit:${COMPACT_HOST.id}`];
    await expect(
      service.executeTool({ ...BASE_USER, scopes }, 'toggle_route_raw_mode', {
        routeId: COMPACT_HOST.id,
        enabled: true,
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });

    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id, { rawConfigEnabled: true }, 'user-1', {
      bypassAdvancedValidation: false,
      bypassRawValidation: true,
      actorScopes: scopes,
    });
  });

  it('creates managed Docker and Pages routes with canonical authorization context', async () => {
    const dockerHost = {
      ...FULL_HOST,
      upstreamKind: 'docker_container',
      dockerNodeId: '44444444-4444-4444-8444-444444444441',
      dockerNodeSlug: 'workloads',
      dockerContainerName: 'app',
      dockerContainerPort: 8080,
      dockerHostPort: 32080,
      dockerProtocol: 'tcp',
      secureLinkActive: true,
    };
    const pagesHost = {
      ...FULL_HOST,
      upstreamKind: 'pages',
      pageTarget: {
        projectId: '33333333-3333-4333-8333-333333333331',
        projectName: 'Docs',
        projectSlug: 'docs',
        tagId: '55555555-5555-4555-8555-555555555551',
        tagName: 'production',
        deploymentId: 'deployment-1',
        status: 'ready',
        generation: 3,
        lastErrorCode: null,
      },
    };
    const proxyService = {
      createProxyHost: vi.fn().mockResolvedValueOnce(dockerHost).mockResolvedValueOnce(pagesHost),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(LicensePolicyService, {
      requireFeature: vi.fn().mockResolvedValue(undefined),
    } as unknown as LicensePolicyService);
    container.registerInstance(PageProfileService, {
      requireEnabled: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageProfileService);
    const service = createService(proxyService);

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['proxy:create', 'docker:containers:view:44444444-4444-4444-8444-444444444441'] },
        'create_route',
        {
          nodeId: '11111111-1111-4111-8111-111111111111',
          domainNames: ['docker.example.com'],
          upstreamKind: 'docker_container',
          dockerNodeId: '44444444-4444-4444-8444-444444444441',
          dockerContainerName: 'app',
          dockerContainerPort: 8080,
        }
      )
    ).resolves.toMatchObject({
      result: {
        upstreamKind: 'docker_container',
        dockerNodeId: '44444444-4444-4444-8444-444444444441',
        dockerContainerName: 'app',
        dockerContainerPort: 8080,
      },
    });
    expect(proxyService.createProxyHost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        upstreamKind: 'docker_container',
        dockerNodeId: '44444444-4444-4444-8444-444444444441',
        dockerContainerName: 'app',
        dockerContainerPort: 8080,
      }),
      'user-1',
      {
        actorScopes: ['proxy:create', 'docker:containers:view:44444444-4444-4444-8444-444444444441'],
        bypassAdvancedValidation: false,
      }
    );

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['proxy:create', 'pages:view:33333333-3333-4333-8333-333333333331'] },
        'create_route',
        {
          nodeId: '11111111-1111-4111-8111-111111111111',
          domainNames: ['pages.example.com'],
          upstreamKind: 'pages',
          pageProjectId: '33333333-3333-4333-8333-333333333331',
          pageTagId: '55555555-5555-4555-8555-555555555551',
        }
      )
    ).resolves.toMatchObject({
      result: {
        upstreamKind: 'pages',
        pageTarget: {
          projectId: '33333333-3333-4333-8333-333333333331',
          tagId: '55555555-5555-4555-8555-555555555551',
          deploymentId: 'deployment-1',
        },
      },
    });
    expect(proxyService.createProxyHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        upstreamKind: 'pages',
        pageProjectId: '33333333-3333-4333-8333-333333333331',
        pageTagId: '55555555-5555-4555-8555-555555555551',
      }),
      'user-1',
      {
        actorScopes: ['proxy:create', 'pages:view:33333333-3333-4333-8333-333333333331'],
        bypassAdvancedValidation: false,
      }
    );
  });

  it('uses the dedicated route maintenance lifecycle', async () => {
    const maintenanceHost = {
      ...FULL_HOST,
      maintenanceEnabled: true,
      maintenanceStartedAt: '2026-08-23T00:00:00.000Z',
    };
    const proxyService = {
      toggleMaintenance: vi.fn().mockResolvedValue(maintenanceHost),
    };
    const service = createService(proxyService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'set_route_maintenance', {
        routeId: COMPACT_HOST.id,
        enabled: true,
      })
    ).resolves.toMatchObject({
      result: { maintenanceEnabled: true, maintenanceStartedAt: '2026-08-23T00:00:00.000Z' },
      invalidateStores: ['proxy'],
    });
    expect(proxyService.toggleMaintenance).toHaveBeenCalledWith(COMPACT_HOST.id, true, 'user-1');
  });

  it('retargets a Route to Pages with the same entitlement and project access checks as REST', async () => {
    const requireFeature = vi.fn().mockResolvedValue(undefined);
    const requireEnabled = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(LicensePolicyService, { requireFeature } as unknown as LicensePolicyService);
    container.registerInstance(PageProfileService, { requireEnabled } as unknown as PageProfileService);
    const pagesHost = {
      ...FULL_HOST,
      upstreamKind: 'pages',
      pageTarget: {
        projectId: '33333333-3333-4333-8333-333333333331',
        projectName: 'Docs',
        projectSlug: 'docs',
        tagId: '55555555-5555-4555-8555-555555555551',
        tagName: 'production',
        deploymentId: 'deployment-1',
        status: 'ready',
        generation: 1,
        lastErrorCode: null,
      },
    };
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      updateProxyHost: vi.fn().mockResolvedValue(pagesHost),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);
    const scopes = [`proxy:edit:${COMPACT_HOST.id}`, 'pages:view:33333333-3333-4333-8333-333333333331'];

    await expect(
      service.executeTool({ ...BASE_USER, scopes }, 'update_route', {
        routeId: COMPACT_HOST.id,
        upstreamKind: 'pages',
        pageProjectId: '33333333-3333-4333-8333-333333333331',
        pageTagId: '55555555-5555-4555-8555-555555555551',
      })
    ).resolves.toMatchObject({
      result: {
        upstreamKind: 'pages',
        pageTarget: {
          projectId: '33333333-3333-4333-8333-333333333331',
          tagId: '55555555-5555-4555-8555-555555555551',
        },
      },
      invalidateStores: ['proxy'],
    });
    expect(requireFeature).toHaveBeenCalledWith('pages');
    expect(requireEnabled).toHaveBeenCalled();
    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(
      COMPACT_HOST.id,
      {
        upstreamKind: 'pages',
        pageProjectId: '33333333-3333-4333-8333-333333333331',
        pageTagId: '55555555-5555-4555-8555-555555555551',
      },
      'user-1',
      { actorScopes: scopes, bypassAdvancedValidation: false }
    );
  });

  it('routes proxy folder operations and enforces per-host move scopes', async () => {
    const folderService = {
      createFolder: vi.fn().mockResolvedValue({ id: '66666666-6666-4666-8666-666666666661', name: 'Apps' }),
      moveHostsToFolder: vi.fn().mockResolvedValue({ success: true }),
      deleteFolder: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({}, folderService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'create_route_folder', {
        name: 'Apps',
        parentId: '66666666-6666-4666-8666-666666666660',
      })
    ).resolves.toEqual({
      result: { id: '66666666-6666-4666-8666-666666666661', name: 'Apps' },
      invalidateStores: ['proxy'],
    });
    expect(folderService.createFolder).toHaveBeenCalledWith(
      { name: 'Apps', parentId: '66666666-6666-4666-8666-666666666660' },
      'user-1'
    );

    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [
            'proxy:folders:manage',
            'proxy:edit:77777777-7777-4777-8777-777777777771',
            'proxy:edit:77777777-7777-4777-8777-777777777772',
            'proxy:edit:folder/66666666-6666-4666-8666-666666666661',
          ],
        },
        'move_routes_to_folder',
        {
          routeIds: ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772'],
          folderId: '66666666-6666-4666-8666-666666666661',
        }
      )
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(folderService.moveHostsToFolder).toHaveBeenCalledWith(
      {
        hostIds: ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772'],
        folderId: '66666666-6666-4666-8666-666666666661',
      },
      'user-1'
    );

    // Like the move route, the destination needs route edit access too (root needs broad proxy:edit).
    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [
            'proxy:folders:manage',
            'proxy:edit:77777777-7777-4777-8777-777777777771',
            'proxy:edit:77777777-7777-4777-8777-777777777772',
          ],
        },
        'move_routes_to_folder',
        { routeIds: ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772'], folderId: null }
      )
    ).resolves.toEqual({ error: 'Missing route edit access for the move destination', invalidateStores: [] });
    expect(folderService.moveHostsToFolder).toHaveBeenCalledTimes(1);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'move_routes_to_folder', {
        routeIds: ['77777777-7777-4777-8777-777777777771'],
        folderId: '66666666-6666-4666-8666-666666666661',
      })
    ).resolves.toEqual({
      error: 'PERMISSION_DENIED: Missing required scope proxy:edit:77777777-7777-4777-8777-777777777771',
      invalidateStores: [],
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'delete_route_folder', {
        folderId: '66666666-6666-4666-8666-666666666661',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(folderService.deleteFolder).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666661', 'user-1');
  });
  it('applies the proxy route reference, template-variable and raw-mode checks on create_route', async () => {
    const assertReferenceAccess = vi.fn().mockResolvedValue(undefined);
    const proxyService = { createProxyHost: vi.fn().mockResolvedValue(FULL_HOST), assertReferenceAccess };
    const service = createService(proxyService);
    const input = {
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['app.example.com'],
      forwardHost: 'app',
      forwardPort: 3000,
      internalCertificateId: '88888888-8888-4888-8888-888888888881',
      nginxTemplateId: '99999999-9999-4999-8999-999999999991',
    };

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', input)
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(assertReferenceAccess).toHaveBeenCalledWith(['proxy:create'], expect.objectContaining(input));

    assertReferenceAccess.mockRejectedValueOnce(
      new AppError(
        403,
        'FORBIDDEN',
        'Deploying a PKI certificate to a proxy route requires permission to export its private key'
      )
    );
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', input)
    ).resolves.toEqual({
      error: 'Deploying a PKI certificate to a proxy route requires permission to export its private key',
      invalidateStores: [],
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', {
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['app.example.com'],
        forwardHost: 'app',
        forwardPort: 3000,
        templateVariables: { accessList: '', upstreamName: 'app' },
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    // Gateway-managed keys are dropped like the HTTP route does, not rejected.
    expect(proxyService.createProxyHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ templateVariables: { upstreamName: 'app' } }),
      'user-1',
      expect.anything()
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', {
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['app.example.com'],
        forwardHost: 'app',
        forwardPort: 3000,
        templateVariables: ['accessList'],
      })
    ).resolves.toEqual({ error: 'templateVariables must be an object', invalidateStores: [] });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', {
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['app.example.com'],
        type: 'raw',
      })
    ).resolves.toEqual({ error: 'Enabling raw mode requires proxy:raw:toggle scope', invalidateStores: [] });
    expect(proxyService.createProxyHost).toHaveBeenCalledTimes(2);
  });

  it('applies the proxy route move, reference, raw-toggle and template checks on update_route', async () => {
    const existing = {
      ...FULL_HOST,
      type: 'proxy',
      rawConfigEnabled: false,
      folderId: '66666666-6666-4666-8666-666666666661',
    };
    const assertReferenceAccess = vi.fn().mockResolvedValue(undefined);
    const assertFolderExists = vi.fn().mockResolvedValue(undefined);
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue(existing),
      updateProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      assertReferenceAccess,
    };
    const service = createService(proxyService, { assertFolderExists });
    const editScope = `proxy:edit:${COMPACT_HOST.id}`;
    const run = (scopes: string[], args: Record<string, unknown>) =>
      service.executeTool({ ...BASE_USER, scopes }, 'update_route', { routeId: COMPACT_HOST.id, ...args });

    // An unchanged folder and an echoed raw flag are ignored, like a full-object PUT.
    await expect(
      run([editScope], { folderId: '66666666-6666-4666-8666-666666666661', rawConfigEnabled: false, type: 'proxy' })
    ).resolves.toEqual({
      result: COMPACT_HOST,
      invalidateStores: ['proxy'],
    });
    expect(proxyService.updateProxyHost).toHaveBeenLastCalledWith(COMPACT_HOST.id, { type: 'proxy' }, 'user-1', {
      actorScopes: [editScope],
      bypassAdvancedValidation: false,
    });
    expect(assertReferenceAccess).toHaveBeenLastCalledWith([editScope], { type: 'proxy' }, existing);

    // Moving to another folder needs folder management and edit access on the destination.
    await expect(run([editScope], { folderId: '66666666-6666-4666-8666-666666666662' })).resolves.toEqual({
      error: 'Moving a route requires proxy:folders:manage scope. Required permission: proxy:folders:manage',
      invalidateStores: [],
    });
    await expect(
      run([editScope, 'proxy:folders:manage'], { folderId: '66666666-6666-4666-8666-666666666662' })
    ).resolves.toEqual({
      error: 'Missing route edit access for the move destination',
      invalidateStores: [],
    });
    const moveScopes = [editScope, 'proxy:folders:manage', 'proxy:edit:folder/66666666-6666-4666-8666-666666666662'];
    await expect(run(moveScopes, { folderId: '66666666-6666-4666-8666-666666666662' })).resolves.toEqual({
      result: COMPACT_HOST,
      invalidateStores: ['proxy'],
    });
    expect(assertFolderExists).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666662');
    expect(proxyService.updateProxyHost).toHaveBeenLastCalledWith(
      COMPACT_HOST.id,
      { folderId: '66666666-6666-4666-8666-666666666662' },
      'user-1',
      expect.anything()
    );

    // Changing the stored raw mode needs proxy:raw:toggle.
    await expect(run([editScope], { rawConfigEnabled: true })).resolves.toEqual({
      error: 'Toggling raw mode requires proxy:raw:toggle scope',
      invalidateStores: [],
    });
    await expect(run([editScope, `proxy:raw:toggle:${COMPACT_HOST.id}`], { rawConfigEnabled: true })).resolves.toEqual({
      result: COMPACT_HOST,
      invalidateStores: ['proxy'],
    });
    expect(proxyService.updateProxyHost).toHaveBeenLastCalledWith(
      COMPACT_HOST.id,
      { rawConfigEnabled: true },
      'user-1',
      {
        actorScopes: [editScope, `proxy:raw:toggle:${COMPACT_HOST.id}`],
        bypassAdvancedValidation: false,
        bypassRawValidation: false,
      }
    );

    // Echoing the stored advanced config is allowed; clearing it without the scope is dropped.
    await expect(run([editScope], { advancedConfig: FULL_HOST.advancedConfig })).resolves.toMatchObject({
      result: COMPACT_HOST,
    });
    await expect(
      run([editScope], { advancedConfig: null, sslCertificateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' })
    ).resolves.toMatchObject({
      result: COMPACT_HOST,
    });
    expect(proxyService.updateProxyHost).toHaveBeenLastCalledWith(
      COMPACT_HOST.id,
      { sslCertificateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
      'user-1',
      expect.anything()
    );
    expect(assertReferenceAccess).toHaveBeenLastCalledWith(
      [editScope],
      { sslCertificateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
      existing
    );

    // Node moves need proxy:create on the new node; reserved template variables are dropped.
    await expect(run([editScope], { nodeId: '11111111-1111-4111-8111-111111111119' })).resolves.toEqual({
      error: 'Missing required scope: proxy:create:11111111-1111-4111-8111-111111111119',
      invalidateStores: [],
    });
    await expect(
      run([editScope], { templateVariables: { sslCertPath: '/etc/passwd', upstreamName: 'app' } })
    ).resolves.toMatchObject({ result: COMPACT_HOST });
    expect(proxyService.updateProxyHost).toHaveBeenLastCalledWith(
      COMPACT_HOST.id,
      { templateVariables: { upstreamName: 'app' } },
      'user-1',
      expect.anything()
    );
    expect(assertReferenceAccess).toHaveBeenLastCalledWith(
      [editScope],
      { templateVariables: { upstreamName: 'app' } },
      existing
    );

    // A reference the caller cannot use stops the update before the service runs.
    const calls = proxyService.updateProxyHost.mock.calls.length;
    assertReferenceAccess.mockRejectedValueOnce(
      new AppError(403, 'FORBIDDEN', 'Viewing the selected access list is required')
    );
    await expect(run([editScope], { accessListId: '22222222-2222-4222-8222-222222222229' })).resolves.toEqual({
      error: 'Viewing the selected access list is required',
      invalidateStores: [],
    });
    expect(proxyService.updateProxyHost).toHaveBeenCalledTimes(calls);
  });

  it('validates create_route with the route schema and accepts folder-scoped create grants', async () => {
    const folderId = '66666666-6666-4666-8666-666666666663';
    const proxyService = {
      createProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);
    const base = {
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['app.example.com'],
      forwardPort: 3000,
    };

    // The nginx-bound hostname is validated like POST /proxy-hosts.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_route', {
        ...base,
        forwardHost: 'app; return 200',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Invalid hostname') });
    expect(proxyService.createProxyHost).not.toHaveBeenCalled();

    // A folder grant passes the tool gate; the destination check still applies.
    const scopes = [`proxy:create:folder/${folderId}`];
    await expect(
      service.executeTool({ ...BASE_USER, scopes }, 'create_route', { ...base, forwardHost: 'app' })
    ).resolves.toEqual({ error: 'Missing proxy:create permission for the selected destination', invalidateStores: [] });
    await expect(
      service.executeTool({ ...BASE_USER, scopes }, 'create_route', { ...base, forwardHost: 'app', folderId })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
  });

  it('redacts Page targets the caller cannot view from route summaries', async () => {
    const pagesHost = {
      ...FULL_HOST,
      upstreamKind: 'pages',
      pageTarget: { projectId: 'project-9', projectName: 'Private', tagId: 'tag-9' },
    };
    const service = createService({ getProxyHost: vi.fn().mockResolvedValue(pagesHost) });

    const hidden = await service.executeTool({ ...BASE_USER, scopes: ['proxy:view'] }, 'get_route', {
      routeId: COMPACT_HOST.id,
    });
    expect(hidden.result).not.toHaveProperty('pageTarget');
    const visible = await service.executeTool(
      { ...BASE_USER, scopes: ['proxy:view', 'pages:view:project-9'] },
      'get_route',
      { routeId: COMPACT_HOST.id }
    );
    expect(visible.result).toMatchObject({ pageTarget: { projectId: 'project-9' } });
  });

  it('inspects routes and validates config through manage_route with route scopes', async () => {
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      getProxyHostBySlug: vi.fn().mockResolvedValue(FULL_HOST),
      getProxyHostHealthHistory: vi.fn().mockResolvedValue([{ status: 'online' }]),
      getProxySecureLinkStatus: vi.fn().mockResolvedValue({ active: false }),
      validateAdvancedConfig: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    };
    const service = createService(proxyService);
    const viewScope = `proxy:view:${COMPACT_HOST.id}`;

    // Full settings: advanced config needs proxy:advanced, stored raw config an exact proxy:raw:read.
    const config = await service.executeTool({ ...BASE_USER, scopes: [viewScope] }, 'manage_route', {
      operation: 'get_config',
      routeId: COMPACT_HOST.id,
    });
    expect(config.result).toMatchObject({ advancedConfig: null, rawConfig: null, rawConfigEnabled: true });
    const rawConfig = await service.executeTool(
      {
        ...BASE_USER,
        scopes: [viewScope, `proxy:advanced:${COMPACT_HOST.id}`, `proxy:raw:read:${COMPACT_HOST.id}`],
      },
      'manage_route',
      { operation: 'get_config', routeId: COMPACT_HOST.id }
    );
    expect(rawConfig.result).toMatchObject({
      advancedConfig: FULL_HOST.advancedConfig,
      rawConfig: FULL_HOST.rawConfig,
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:view:other'] }, 'manage_route', {
        operation: 'get_by_slug',
        slug: COMPACT_HOST.slug,
      })
    ).resolves.toEqual({ error: `Missing required scope: proxy:view:${COMPACT_HOST.id}`, invalidateStores: [] });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: [viewScope] }, 'manage_route', {
        operation: 'health_history',
        routeId: COMPACT_HOST.id,
      })
    ).resolves.toEqual({ result: [{ status: 'online' }], invalidateStores: [] });

    // validate_config uses the same advanced/raw scopes and bypass grants as POST /proxy-hosts/validate-config.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: [viewScope] }, 'manage_route', {
        operation: 'validate_config',
        routeId: COMPACT_HOST.id,
        snippet: 'return 200;',
      })
    ).resolves.toEqual({ error: 'Advanced config requires proxy:advanced scope', invalidateStores: [] });
    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [`proxy:raw:write:${COMPACT_HOST.id}`, `proxy:raw:bypass:${COMPACT_HOST.id}`],
        },
        'manage_route',
        { operation: 'validate_config', routeId: COMPACT_HOST.id, snippet: 'server {}', mode: 'raw' }
      )
    ).resolves.toEqual({ result: { valid: true, errors: [] }, invalidateStores: [] });
    expect(proxyService.validateAdvancedConfig).toHaveBeenCalledWith('server {}', true, false, true);
  });

  it('previews and tests nginx templates with the template route scopes', async () => {
    const templateService = {
      previewWithSampleData: vi.fn().mockReturnValue('rendered-sample'),
      renderTemplate: vi.fn().mockReturnValue('rendered-host'),
    };
    const nodeDispatch = {
      getFirstNginxNodeId: vi.fn().mockResolvedValue('node-9'),
      applyConfig: vi.fn().mockResolvedValue({ success: false, error: 'nginx: [emerg] unknown directive' }),
    };
    // Loaded lazily: importing these before AIService trips a module cycle in the test graph.
    const { NginxTemplateService } = await import('@/modules/proxy/nginx-template.service.js');
    const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
    container.registerInstance(NginxTemplateService, templateService as never);
    container.registerInstance(NodeDispatchService, nodeDispatch as never);
    const service = createService({ getProxyHost: vi.fn().mockResolvedValue(FULL_HOST) });
    const templateId = '99999999-9999-4999-8999-999999999992';

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:templates:view'] }, 'manage_proxy_template', {
        operation: 'preview',
        content: 'server {}',
      })
    ).resolves.toEqual({ result: { rendered: 'rendered-sample' }, invalidateStores: ['proxy'] });

    // Rendering against a stored route needs view access to it; advanced config follows proxy:advanced.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:templates:view'] }, 'manage_proxy_template', {
        operation: 'preview',
        content: 'server {}',
        routeId: COMPACT_HOST.id,
      })
    ).resolves.toMatchObject({ error: expect.stringContaining(`proxy:view:${COMPACT_HOST.id}`) });
    await service.executeTool(
      { ...BASE_USER, scopes: ['proxy:templates:view', `proxy:view:${COMPACT_HOST.id}`] },
      'manage_proxy_template',
      { operation: 'preview', content: 'server {}', routeId: COMPACT_HOST.id }
    );
    expect(templateService.renderTemplate).toHaveBeenCalledWith(
      'server {}',
      expect.objectContaining({ id: COMPACT_HOST.id, advancedConfig: null })
    );

    // Testing needs proxy:raw:write plus edit on the template (or create for new content).
    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['proxy:templates:edit', 'proxy:raw:write'] },
        'manage_proxy_template',
        { operation: 'test', content: 'server {}' }
      )
    ).resolves.toMatchObject({ error: expect.stringContaining('proxy:templates:create') });
    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: [`proxy:templates:edit:${templateId}`, 'proxy:raw:write'] },
        'manage_proxy_template',
        { operation: 'test', content: 'server {}', templateId }
      )
    ).resolves.toEqual({
      result: { rendered: 'rendered-sample', valid: false, errors: ['nginx: [emerg] unknown directive'] },
      invalidateStores: ['proxy'],
    });
    expect(nodeDispatch.applyConfig).toHaveBeenCalledWith(
      'node-9',
      expect.stringMatching(/^test-/),
      'rendered-sample',
      true
    );
  });

  it('writes raw config with the raw-only PUT checks', async () => {
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      updateProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);
    const scopes = [`proxy:raw:write:${COMPACT_HOST.id}`];

    await expect(
      service.executeTool({ ...BASE_USER, scopes }, 'update_route_raw_config', {
        routeId: COMPACT_HOST.id,
        rawConfig: 'server { return 204; }',
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(
      COMPACT_HOST.id,
      { rawConfig: 'server { return 204; }' },
      'user-1',
      { bypassAdvancedValidation: false, bypassRawValidation: false, actorScopes: scopes }
    );
  });

  it('issues maintenance access codes only with proxy:maintenance:bypass on the route', async () => {
    const issue = vi.fn().mockResolvedValue({ code: 'code-1', expiresInSeconds: 300 });
    const { ProxyMaintenanceAccessService } = await import('@/modules/proxy/proxy-maintenance-access.service.js');
    container.registerInstance(ProxyMaintenanceAccessService, { issue } as never);
    const service = createService({});

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'manage_route', {
        operation: 'maintenance_access_code',
        routeId: COMPACT_HOST.id,
      })
    ).resolves.toMatchObject({ error: `Missing required scope: proxy:maintenance:bypass:${COMPACT_HOST.id}` });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:maintenance:bypass:${COMPACT_HOST.id}`] }, 'manage_route', {
        operation: 'maintenance_access_code',
        routeId: COMPACT_HOST.id,
      })
    ).resolves.toMatchObject({ result: { code: 'code-1', expiresInSeconds: 300 } });
    expect(issue).toHaveBeenCalledWith(COMPACT_HOST.id, 'user-1');
  });
});
