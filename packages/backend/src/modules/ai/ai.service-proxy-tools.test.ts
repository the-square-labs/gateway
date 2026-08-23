import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
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
  id: 'proxy-1',
  slug: 'app-example-com',
  type: 'proxy',
  domainNames: ['app.example.com'],
  enabled: true,
  nodeId: 'node-1',
  upstreamKind: 'manual',
  forwardScheme: 'http',
  forwardHost: 'app',
  forwardPort: 3000,
  sslEnabled: true,
  sslForced: false,
  sslCertificateId: 'ssl-1',
  accessListId: 'acl-1',
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
    folderService as never,
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

  it('keeps binary Pages upload out of the embedded AI execution surface', async () => {
    const service = createService({});

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pages:deploy:project-1'] }, 'upload_pages_artifact', {
        operation: 'begin',
        projectId: 'project-1',
        declaredSizeBytes: 4,
        sha256: 'a'.repeat(64),
      })
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
        nodeId: 'node-1',
        domainNames: ['app.example.com'],
        forwardHost: 'app',
        forwardPort: 3000,
        sslEnabled: true,
        websocketSupport: true,
        accessListId: 'acl-1',
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'proxy',
        upstreamKind: 'manual',
        nodeId: 'node-1',
        domainNames: ['app.example.com'],
        forwardHost: 'app',
        forwardPort: 3000,
        forwardScheme: 'http',
        sslEnabled: true,
        sslForced: false,
        http2Support: false,
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
        accessListId: 'acl-1',
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
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create:node-1'] }, 'create_route', {
        nodeId: 'node-1',
        domainNames: ['scoped.example.com'],
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.createProxyHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeId: 'node-1', domainNames: ['scoped.example.com'] }),
      'user-1',
      { actorScopes: ['proxy:create:node-1'], bypassAdvancedValidation: false }
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
          ],
        },
        'update_route',
        {
          routeId: COMPACT_HOST.id,
          domainNames: ['new.example.com'],
          nodeId: 'node-2',
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
        nodeId: 'node-2',
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
      },
      'user-1',
      {
        actorScopes: [
          `proxy:edit:${COMPACT_HOST.id}`,
          `proxy:advanced:${COMPACT_HOST.id}`,
          `proxy:advanced:bypass:${COMPACT_HOST.id}`,
        ],
        bypassAdvancedValidation: true,
      }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'update_route', {
        routeId: COMPACT_HOST.id,
        advancedConfig: 'proxy_set_header X-Test true;',
      })
    ).resolves.toEqual({ error: 'Advanced config requires proxy:advanced scope', invalidateStores: [] });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'update_route', {
        routeId: COMPACT_HOST.id,
        rawConfig: 'server {}',
      })
    ).resolves.toEqual({ error: 'Raw config changes require dedicated raw config tools', invalidateStores: [] });
  });

  it('preserves the scoped raw-validation bypass when enabling raw mode', async () => {
    const proxyService = {
      updateProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
    };
    const service = createService(proxyService);

    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [`proxy:raw:toggle:${COMPACT_HOST.id}`, `proxy:raw:bypass:${COMPACT_HOST.id}`],
        },
        'toggle_route_raw_mode',
        { routeId: COMPACT_HOST.id, enabled: true }
      )
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });

    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id, { rawConfigEnabled: true }, 'user-1', {
      bypassRawValidation: true,
    });
  });

  it('creates managed Docker and Pages routes with canonical authorization context', async () => {
    const dockerHost = {
      ...FULL_HOST,
      upstreamKind: 'docker_container',
      dockerNodeId: 'docker-node-1',
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
        projectId: 'project-1',
        projectName: 'Docs',
        projectSlug: 'docs',
        tagId: 'tag-1',
        tagName: 'production',
        deploymentId: 'deployment-1',
        status: 'ready',
        generation: 3,
        lastErrorCode: null,
      },
    };
    const proxyService = {
      createProxyHost: vi.fn().mockResolvedValueOnce(dockerHost).mockResolvedValueOnce(pagesHost),
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
        { ...BASE_USER, scopes: ['proxy:create', 'docker:containers:view:docker-node-1'] },
        'create_route',
        {
          nodeId: 'node-1',
          domainNames: ['docker.example.com'],
          upstreamKind: 'docker_container',
          dockerNodeId: 'docker-node-1',
          dockerContainerName: 'app',
          dockerContainerPort: 8080,
        }
      )
    ).resolves.toMatchObject({
      result: {
        upstreamKind: 'docker_container',
        dockerNodeId: 'docker-node-1',
        dockerContainerName: 'app',
        dockerContainerPort: 8080,
      },
    });
    expect(proxyService.createProxyHost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        upstreamKind: 'docker_container',
        dockerNodeId: 'docker-node-1',
        dockerContainerName: 'app',
        dockerContainerPort: 8080,
      }),
      'user-1',
      {
        actorScopes: ['proxy:create', 'docker:containers:view:docker-node-1'],
        bypassAdvancedValidation: false,
      }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create', 'pages:view:project-1'] }, 'create_route', {
        nodeId: 'node-1',
        domainNames: ['pages.example.com'],
        upstreamKind: 'pages',
        pageProjectId: 'project-1',
        pageTagId: 'tag-1',
      })
    ).resolves.toMatchObject({
      result: {
        upstreamKind: 'pages',
        pageTarget: { projectId: 'project-1', tagId: 'tag-1', deploymentId: 'deployment-1' },
      },
    });
    expect(proxyService.createProxyHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ upstreamKind: 'pages', pageProjectId: 'project-1', pageTagId: 'tag-1' }),
      'user-1',
      { actorScopes: ['proxy:create', 'pages:view:project-1'], bypassAdvancedValidation: false }
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
        projectId: 'project-1',
        projectName: 'Docs',
        projectSlug: 'docs',
        tagId: 'tag-1',
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
    };
    const service = createService(proxyService);
    const scopes = [`proxy:edit:${COMPACT_HOST.id}`, 'pages:view:project-1'];

    await expect(
      service.executeTool({ ...BASE_USER, scopes }, 'update_route', {
        routeId: COMPACT_HOST.id,
        upstreamKind: 'pages',
        pageProjectId: 'project-1',
        pageTagId: 'tag-1',
      })
    ).resolves.toMatchObject({
      result: { upstreamKind: 'pages', pageTarget: { projectId: 'project-1', tagId: 'tag-1' } },
      invalidateStores: ['proxy'],
    });
    expect(requireFeature).toHaveBeenCalledWith('pages');
    expect(requireEnabled).toHaveBeenCalled();
    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(
      COMPACT_HOST.id,
      { upstreamKind: 'pages', pageProjectId: 'project-1', pageTagId: 'tag-1' },
      'user-1',
      { actorScopes: scopes, bypassAdvancedValidation: false }
    );
  });

  it('routes proxy folder operations and enforces per-host move scopes', async () => {
    const folderService = {
      createFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: 'Apps' }),
      moveHostsToFolder: vi.fn().mockResolvedValue({ success: true }),
      deleteFolder: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({}, folderService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'create_route_folder', {
        name: 'Apps',
        parentId: 'parent-1',
      })
    ).resolves.toEqual({ result: { id: 'folder-1', name: 'Apps' }, invalidateStores: ['proxy'] });
    expect(folderService.createFolder).toHaveBeenCalledWith({ name: 'Apps', parentId: 'parent-1' }, 'user-1');

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['proxy:folders:manage', 'proxy:edit:proxy-1', 'proxy:edit:proxy-2'] },
        'move_routes_to_folder',
        {
          routeIds: ['proxy-1', 'proxy-2'],
          folderId: null,
        }
      )
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(folderService.moveHostsToFolder).toHaveBeenCalledWith(
      { hostIds: ['proxy-1', 'proxy-2'], folderId: null },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'move_routes_to_folder', {
        routeIds: ['proxy-1'],
        folderId: 'folder-1',
      })
    ).resolves.toEqual({
      error: 'PERMISSION_DENIED: Missing required scope proxy:edit:proxy-1',
      invalidateStores: [],
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'delete_route_folder', {
        folderId: 'folder-1',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(folderService.deleteFolder).toHaveBeenCalledWith('folder-1', 'user-1');
  });
});
