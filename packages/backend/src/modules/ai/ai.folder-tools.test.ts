import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { DockerNetworkAccessResourceService } from '@/modules/docker/docker-network-access-resource.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import { executeFolderTool } from './ai.folder-tools.js';

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

  it('requires domain view scope for domain folder listings', async () => {
    const domainFolderService = {
      getFolderTree: vi.fn().mockResolvedValue([{ id: 'folder-1', name: 'Domains', children: [] }]),
    };
    vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
      if (token === DomainFolderService) return domainFolderService as never;
      throw new Error('Unexpected service resolution');
    });

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['domains:folders:manage'] }, 'list_resource_folders', {
        resourceType: 'domains',
      })
    ).rejects.toThrow('PERMISSION_DENIED: Missing required scope domains:view');

    await expect(
      executeFolderTool({ ...BASE_USER, scopes: ['domains:view', 'domains:folders:manage'] }, 'list_resource_folders', {
        resourceType: 'domains',
      })
    ).resolves.toEqual([{ id: 'folder-1', name: 'Domains', children: [] }]);
    expect(domainFolderService.getFolderTree).toHaveBeenCalledWith({ includeAllFolders: true });
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
      allowedNodeIds: [],
      allowedResourceRefs: [{ nodeId: 'node-1', resourceKey: 'project-1' }],
    });
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
