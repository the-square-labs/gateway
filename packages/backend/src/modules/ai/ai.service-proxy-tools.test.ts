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

const COMPACT_HOST = {
  id: 'proxy-1',
  slug: 'app-example-com',
  type: 'proxy',
  domainNames: ['app.example.com'],
  enabled: true,
  nodeId: 'node-1',
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
  it('routes proxy host list/get/create/delete operations through proxy service and compacts host output', async () => {
    const proxyService = {
      listProxyHosts: vi.fn().mockResolvedValue({ data: [FULL_HOST], total: 1 }),
      getProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      createProxyHost: vi.fn().mockResolvedValue(FULL_HOST),
      deleteProxyHost: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(proxyService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:view'] }, 'list_proxy_hosts', {
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
      service.executeTool({ ...BASE_USER, scopes: [`proxy:view:${COMPACT_HOST.id}`] }, 'get_proxy_host', {
        proxyHostId: COMPACT_HOST.id,
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: [] });
    expect(proxyService.getProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create'] }, 'create_proxy_host', {
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
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:create:node-1'] }, 'create_proxy_host', {
        nodeId: 'node-1',
        domainNames: ['scoped.example.com'],
      })
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });
    expect(proxyService.createProxyHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeId: 'node-1', domainNames: ['scoped.example.com'] }),
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:delete:${COMPACT_HOST.id}`] }, 'delete_proxy_host', {
        proxyHostId: COMPACT_HOST.id,
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(proxyService.deleteProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id, 'user-1');
  });

  it('routes proxy host update with advanced config checks and rejects raw config edits', async () => {
    const proxyService = {
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
        'update_proxy_host',
        {
          proxyHostId: COMPACT_HOST.id,
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
      { bypassAdvancedValidation: true }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'update_proxy_host', {
        proxyHostId: COMPACT_HOST.id,
        advancedConfig: 'proxy_set_header X-Test true;',
      })
    ).resolves.toEqual({ error: 'Advanced config requires proxy:advanced scope', invalidateStores: [] });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`proxy:edit:${COMPACT_HOST.id}`] }, 'update_proxy_host', {
        proxyHostId: COMPACT_HOST.id,
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
        'toggle_proxy_raw_mode',
        { proxyHostId: COMPACT_HOST.id, enabled: true }
      )
    ).resolves.toEqual({ result: COMPACT_HOST, invalidateStores: ['proxy'] });

    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(COMPACT_HOST.id, { rawConfigEnabled: true }, 'user-1', {
      bypassRawValidation: true,
    });
  });

  it('routes proxy folder operations and enforces per-host move scopes', async () => {
    const folderService = {
      createFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: 'Apps' }),
      moveHostsToFolder: vi.fn().mockResolvedValue({ success: true }),
      deleteFolder: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({}, folderService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'create_proxy_folder', {
        name: 'Apps',
        parentId: 'parent-1',
      })
    ).resolves.toEqual({ result: { id: 'folder-1', name: 'Apps' }, invalidateStores: ['proxy'] });
    expect(folderService.createFolder).toHaveBeenCalledWith({ name: 'Apps', parentId: 'parent-1' }, 'user-1');

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['proxy:folders:manage', 'proxy:edit:proxy-1', 'proxy:edit:proxy-2'] },
        'move_hosts_to_folder',
        {
          hostIds: ['proxy-1', 'proxy-2'],
          folderId: null,
        }
      )
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(folderService.moveHostsToFolder).toHaveBeenCalledWith(
      { hostIds: ['proxy-1', 'proxy-2'], folderId: null },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'move_hosts_to_folder', {
        hostIds: ['proxy-1'],
        folderId: 'folder-1',
      })
    ).resolves.toEqual({
      error: 'PERMISSION_DENIED: Missing required scope proxy:edit:proxy-1',
      invalidateStores: [],
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['proxy:folders:manage'] }, 'delete_proxy_folder', {
        folderId: 'folder-1',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['proxy'] });
    expect(folderService.deleteFolder).toHaveBeenCalledWith('folder-1', 'user-1');
  });
});
