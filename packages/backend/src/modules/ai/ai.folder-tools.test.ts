import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { DockerNetworkAccessResourceService } from '@/modules/docker/docker-network-access-resource.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import { executeFolderTool } from './ai.folder-tools.js';
import { parseAndValidateAIToolArguments } from './ai.tools.js';

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

describe('AI folder tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips raw proxy config fields from proxy folder listings', async () => {
    const proxyFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([
        {
          id: 'folder-1',
          name: 'Apps',
          hosts: [
            {
              id: 'proxy-1',
              domainNames: ['app.example.com'],
              rawConfig: 'server { proxy_set_header Authorization secret; }',
              rawConfigEnabled: true,
            },
          ],
          children: [
            {
              id: 'folder-2',
              name: 'Nested',
              hosts: [
                {
                  id: 'proxy-2',
                  domainNames: ['nested.example.com'],
                  rawConfig: 'server { deny all; }',
                  rawConfigEnabled: true,
                },
              ],
              children: [],
            },
          ],
        },
      ]),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === FolderService) return proxyFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    const result = await executeFolderTool({ ...BASE_USER, scopes: ['proxy:view:proxy-1'] }, 'list_resource_folders', {
      resourceType: 'routes',
    });

    expect(proxyFolderService.getFolderTree).toHaveBeenCalledWith({ allowedHostIds: ['proxy-1'] });
    expect(JSON.stringify(result)).not.toContain('rawConfig');
    expect(JSON.stringify(result)).not.toContain('rawConfigEnabled');
    expect(JSON.stringify(result)).not.toContain('proxy_set_header Authorization');
    expect(result).toMatchObject([
      {
        hosts: [{ id: 'proxy-1', domainNames: ['app.example.com'] }],
        children: [{ hosts: [{ id: 'proxy-2', domainNames: ['nested.example.com'] }] }],
      },
    ]);
  });

  it('lists domain folders with the same access rules as GET /domains/folders', async () => {
    const domainFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([{ id: 'folder-1', name: 'Domains', children: [] }]),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === DomainFolderService) return domainFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['nodes:details'] }, 'list_resource_folders', {
        resourceType: 'domains',
      })
    ).rejects.toThrow('PERMISSION_DENIED: Missing one of required scopes: domains:view');

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['domains:folders:manage'] }, 'list_resource_folders', {
        resourceType: 'domains',
      })
    ).resolves.toEqual([{ id: 'folder-1', name: 'Domains', children: [] }]);
    expect(domainFolderService.getFolderTree).toHaveBeenLastCalledWith({ includeAllFolders: true });

    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['domains:view:domain-1', 'domains:edit:folder/folder-9'] },
        'list_resource_folders',
        { resourceType: 'domains' }
      )
    ).resolves.toEqual([{ id: 'folder-1', name: 'Domains', children: [] }]);
    expect(domainFolderService.getFolderTree).toHaveBeenLastCalledWith({
      allowedResourceIds: ['domain-1'],
      allowedFolderIds: ['folder-9'],
    });
  });

  it('lets node creators list every node folder, like the node folder route', async () => {
    const nodeFolderService = { getFolderTree: vi.fn().mockResolvedValue([]) };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === NodeFolderService) return nodeFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    await executeFolderTool({ ...BASE_USER, scopes: ['nodes:create'] }, 'list_resource_folders', {
      resourceType: 'nodes',
    });
    expect(nodeFolderService.getFolderTree).toHaveBeenCalledWith({ includeAllFolders: true });
  });

  it('requires the per-user grant on every reordered user, like the user reorder route', async () => {
    const userFolderService = { reorderResources: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === AdminUserFolderService) return userFolderService as never;
      throw new Error('Unexpected service resolution');
    });
    const userOne = '11111111-1111-4111-8111-111111111111';
    const userTwo = '22222222-2222-4222-8222-222222222222';
    const args = {
      resourceType: 'admin_users',
      operation: 'reorder_resources',
      items: [
        { id: userOne, sortOrder: 0 },
        { id: userTwo, sortOrder: 1 },
      ],
    };

    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['admin:users:folders:manage', `admin:users:${userOne}`] },
        'manage_resource_folder',
        args
      )
    ).rejects.toThrow(`PERMISSION_DENIED: Missing required scope admin:users:${userTwo}`);
    expect(userFolderService.reorderResources).not.toHaveBeenCalled();

    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['admin:users:folders:manage', 'admin:users'] },
        'manage_resource_folder',
        args
      )
    ).resolves.toEqual({ success: true });
    expect(userFolderService.reorderResources).toHaveBeenCalledTimes(1);
  });

  it('manages Page Project folders behind the Pages license and enabled profile', async () => {
    const requireFeature = vi.fn().mockResolvedValue(undefined);
    const requireEnabled = vi.fn().mockResolvedValue(undefined);
    const pageFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([]),
      createFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: 'Sites' }),
      moveResourcesToFolder: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === LicensePolicyService) return { requireFeature } as never;
      if (token === PageProfileService) return { requireEnabled } as never;
      if (token === PageProjectFolderService) return pageFolderService as never;
      throw new Error('Unexpected service resolution');
    });
    const projectId = '11111111-1111-4111-8111-111111111111';
    const folderId = '22222222-2222-4222-8222-222222222222';

    await executeFolderTool({ ...BASE_USER, scopes: [`pages:view:${projectId}`] }, 'list_resource_folders', {
      resourceType: 'pages',
    });
    expect(pageFolderService.getFolderTree).toHaveBeenCalledWith({
      allowedResourceIds: [projectId],
      allowedFolderIds: [],
    });
    expect(requireEnabled).not.toHaveBeenCalled();

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['pages:folders:manage'] }, 'manage_resource_folder', {
        resourceType: 'pages',
        operation: 'create',
        name: 'Sites',
      })
    ).resolves.toEqual({ id: 'folder-1', name: 'Sites' });
    expect(requireFeature).toHaveBeenCalledWith('pages');
    expect(requireEnabled).toHaveBeenCalledTimes(1);

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['pages:folders:manage'] }, 'manage_resource_folder', {
        resourceType: 'pages',
        operation: 'move_resources',
        resourceIds: [projectId],
        folderId,
      })
    ).rejects.toThrow(`PERMISSION_DENIED: Missing required scope pages:edit:${projectId}`);
    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['pages:folders:manage', 'pages:edit'] }, 'manage_resource_folder', {
        resourceType: 'pages',
        operation: 'move_resources',
        resourceIds: [projectId],
        folderId,
      })
    ).resolves.toEqual({ success: true });
    expect(pageFolderService.moveResourcesToFolder).toHaveBeenCalledWith({ ids: [projectId], folderId }, 'user-1');
  });

  it('uses the shared folder contract for SSL certificates', async () => {
    const sslFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([{ id: 'folder-1', name: 'TLS', children: [] }]),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === SSLCertificateFolderService) return sslFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['ssl:cert:view', 'ssl:cert:folders:manage'] },
        'list_resource_folders',
        { resourceType: 'ssl_certificates' }
      )
    ).resolves.toEqual([{ id: 'folder-1', name: 'TLS', children: [] }]);
    expect(sslFolderService.getFolderTree).toHaveBeenCalledWith({ includeAllFolders: true });
  });

  it('requires proxy edit scope for every proxy host reorder item', async () => {
    const proxyOneId = '11111111-1111-4111-8111-111111111111';
    const proxyTwoId = '22222222-2222-4222-8222-222222222222';
    const proxyFolderService = {
      reorderHosts: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === FolderService) return proxyFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['proxy:folders:manage', `proxy:edit:${proxyOneId}`] },
        'manage_resource_folder',
        {
          resourceType: 'routes',
          operation: 'reorder_resources',
          items: [
            { id: proxyOneId, sortOrder: 0 },
            { id: proxyTwoId, sortOrder: 1 },
          ],
        }
      )
    ).rejects.toThrow(`PERMISSION_DENIED: Missing required scope proxy:edit:${proxyTwoId}`);
    expect(proxyFolderService.reorderHosts).not.toHaveBeenCalled();

    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['proxy:folders:manage', `proxy:edit:${proxyOneId}`, `proxy:edit:${proxyTwoId}`] },
        'manage_resource_folder',
        {
          resourceType: 'routes',
          operation: 'reorder_resources',
          items: [
            { id: proxyOneId, sortOrder: 0 },
            { id: proxyTwoId, sortOrder: 1 },
          ],
        }
      )
    ).resolves.toEqual({ success: true });
    expect(proxyFolderService.reorderHosts).toHaveBeenCalledWith({
      items: [
        { id: proxyOneId, sortOrder: 0 },
        { id: proxyTwoId, sortOrder: 1 },
      ],
    });
  });

  it('limits Compose folder listings to project-scoped assignments', async () => {
    const dockerFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([{ id: 'compose-folder-1', name: 'Stacks', children: [] }]),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === DockerFolderService) return dockerFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['docker:compose:view:node-1/project-1'] }, 'list_resource_folders', {
        resourceType: 'docker',
        dockerResourceType: 'compose',
      })
    ).resolves.toEqual([{ id: 'compose-folder-1', name: 'Stacks', children: [] }]);
    expect(dockerFolderService.getFolderTree).toHaveBeenCalledWith({
      resourceType: 'compose',
      allowedFolderIds: [],
      allowedNodeIds: [],
      allowedResourceRefs: [{ nodeId: 'node-1', resourceKey: 'project-1' }],
    });
  });

  it('manages Compose project folders with the Docker folder route scopes', async () => {
    const dockerFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([]),
      createFolder: vi.fn().mockResolvedValue({ id: 'compose-folder-1', name: 'Stacks' }),
      moveResourcesToFolder: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === DockerFolderService) return dockerFolderService as never;
      throw new Error('Unexpected service resolution');
    });
    const folderId = '11111111-1111-4111-8111-111111111111';
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const items = [{ nodeId, resourceKey: 'project-1' }];

    expect(
      parseAndValidateAIToolArguments(
        'manage_resource_folder',
        JSON.stringify({ resourceType: 'docker', dockerResourceType: 'compose', operation: 'create', name: 'Stacks' })
      )
    ).toMatchObject({ ok: true });
    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['docker:compose:create'] }, 'list_resource_folders', {
        resourceType: 'docker',
        dockerResourceType: 'compose',
      })
    ).resolves.toEqual([]);
    expect(dockerFolderService.getFolderTree).toHaveBeenCalledWith({
      resourceType: 'compose',
      includeAllFolders: true,
    });

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['docker:containers:folders:manage'] }, 'manage_resource_folder', {
        resourceType: 'docker',
        dockerResourceType: 'compose',
        operation: 'create',
        name: 'Stacks',
      })
    ).resolves.toEqual({ id: 'compose-folder-1', name: 'Stacks' });
    expect(dockerFolderService.createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Stacks', resourceType: 'compose' }),
      'user-1'
    );

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['docker:containers:folders:manage'] }, 'manage_resource_folder', {
        resourceType: 'docker',
        dockerResourceType: 'compose',
        operation: 'move_resources',
        folderId,
        items,
      })
    ).rejects.toThrow('Missing required scope: docker:compose:manage');
    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['docker:containers:folders:manage', `docker:compose:manage:${nodeId}/project-1`] },
        'manage_resource_folder',
        { resourceType: 'docker', dockerResourceType: 'compose', operation: 'move_resources', folderId, items }
      )
    ).rejects.toThrow('PERMISSION_DENIED: Missing required destination scope docker:compose:manage');
    await expect(
      executeFolderTool(
        { ...BASE_USER, scopes: ['docker:containers:folders:manage', `docker:compose:manage:${nodeId}`] },
        'manage_resource_folder',
        { resourceType: 'docker', dockerResourceType: 'compose', operation: 'move_resources', folderId, items }
      )
    ).resolves.toEqual({ success: true });
    expect(dockerFolderService.moveResourcesToFolder).toHaveBeenCalledWith(
      { resourceType: 'compose', items, folderId },
      'user-1'
    );
  });
  it('requires the module edit scope on every moved resource and on the destination', async () => {
    const domainOne = '11111111-1111-4111-8111-111111111111';
    const domainTwo = '22222222-2222-4222-8222-222222222222';
    const folderId = '33333333-3333-4333-8333-333333333333';
    const domainFolderService = { moveResourcesToFolder: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === DomainFolderService) return domainFolderService as never;
      throw new Error('Unexpected service resolution');
    });
    const move = (scopes: string[], destination: string | null) =>
      executeFolderTool({ ...BASE_USER, scopes: ['domains:folders:manage', ...scopes] }, 'manage_resource_folder', {
        resourceType: 'domains',
        operation: 'move_resources',
        resourceIds: [domainOne, domainTwo],
        folderId: destination,
      });

    await expect(move([`domains:edit:${domainOne}`, `domains:edit:folder/${folderId}`], folderId)).rejects.toThrow(
      `PERMISSION_DENIED: Missing required scope domains:edit:${domainTwo}`
    );
    await expect(move([`domains:edit:${domainOne}`, `domains:edit:${domainTwo}`], folderId)).rejects.toThrow(
      'PERMISSION_DENIED: Missing domains:edit for the move destination'
    );
    // Moving to the root needs broad edit access.
    await expect(
      move([`domains:edit:${domainOne}`, `domains:edit:${domainTwo}`, `domains:edit:folder/${folderId}`], null)
    ).rejects.toThrow('PERMISSION_DENIED: Missing domains:edit for the move destination');
    expect(domainFolderService.moveResourcesToFolder).not.toHaveBeenCalled();

    await expect(
      move([`domains:edit:${domainOne}`, `domains:edit:${domainTwo}`, `domains:edit:folder/${folderId}`], folderId)
    ).resolves.toEqual({ success: true });
    expect(domainFolderService.moveResourcesToFolder).toHaveBeenCalledWith(
      { ids: [domainOne, domainTwo], folderId },
      'user-1'
    );
  });

  it.each([
    ['domains', DomainFolderService, 'domains:folders:manage', 'domains:edit'],
    ['ssl_certificates', SSLCertificateFolderService, 'ssl:cert:folders:manage', 'ssl:cert:issue'],
  ] as const)('passes %s folder moves through the per-resource edit check', async (resourceType, token, manage, edit) => {
    const folderId = '33333333-3333-4333-8333-333333333333';
    const parentId = '44444444-4444-4444-8444-444444444444';
    const folderService = { moveFolder: vi.fn().mockResolvedValue({ id: folderId }) };
    vi.spyOn(container, 'resolve').mockImplementation((resolved: unknown) => {
      if (resolved === token) return folderService as never;
      throw new Error('Unexpected service resolution');
    });
    const scopes = [manage, `${edit}:folder/${parentId}`];

    await executeFolderTool({ ...BASE_USER, scopes }, 'manage_resource_folder', {
      resourceType,
      operation: 'move_folder',
      folderId,
      parentId,
    });

    expect(folderService.moveFolder).toHaveBeenCalledWith(folderId, { parentId }, 'user-1', {
      scopes,
      editScope: edit,
    });
  });

  it('requires route edit access on the destination when moving routes into a folder', async () => {
    const routeId = '11111111-1111-4111-8111-111111111111';
    const folderId = '33333333-3333-4333-8333-333333333333';
    const proxyFolderService = { moveHostsToFolder: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === FolderService) return proxyFolderService as never;
      throw new Error('Unexpected service resolution');
    });
    const move = (scopes: string[]) =>
      executeFolderTool({ ...BASE_USER, scopes: ['proxy:folders:manage', ...scopes] }, 'manage_resource_folder', {
        resourceType: 'routes',
        operation: 'move_resources',
        resourceIds: [routeId],
        folderId,
      });

    await expect(move([`proxy:edit:${routeId}`])).rejects.toThrow(
      'PERMISSION_DENIED: Missing proxy:edit for the move destination'
    );
    await expect(move([`proxy:edit:${routeId}`, `proxy:edit:folder/${folderId}`])).resolves.toEqual({ success: true });
    expect(proxyFolderService.moveHostsToFolder).toHaveBeenCalledTimes(1);
  });

  it('applies the Docker folder route scopes to network moves and their destination', async () => {
    const folderId = '33333333-3333-4333-8333-333333333333';
    const nodeId = '44444444-4444-4444-8444-444444444444';
    const dockerFolderService = { moveResourcesToFolder: vi.fn().mockResolvedValue(undefined) };
    const networkResources = { resolveNetwork: vi.fn().mockResolvedValue('net-resource-1') };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === DockerFolderService) return dockerFolderService as never;
      if (token === DockerNetworkAccessResourceService) return networkResources as never;
      throw new Error('Unexpected service resolution');
    });
    const move = (scopes: string[]) =>
      executeFolderTool(
        { ...BASE_USER, scopes: ['docker:containers:folders:manage', ...scopes] },
        'manage_resource_folder',
        {
          resourceType: 'docker',
          dockerResourceType: 'network',
          operation: 'move_resources',
          items: [{ nodeId, resourceKey: 'backend' }],
          folderId,
        }
      );

    await expect(move([])).rejects.toThrow('Missing required scope: docker:networks:edit');
    await expect(move([`docker:networks:edit:${nodeId}/net-resource-1`])).rejects.toThrow(
      'PERMISSION_DENIED: Missing required destination scope docker:networks:edit'
    );
    expect(dockerFolderService.moveResourcesToFolder).not.toHaveBeenCalled();
    await expect(move([`docker:networks:edit:${nodeId}`])).resolves.toEqual({ success: true });
    expect(networkResources.resolveNetwork).toHaveBeenCalledWith(nodeId, 'backend');
  });
});
