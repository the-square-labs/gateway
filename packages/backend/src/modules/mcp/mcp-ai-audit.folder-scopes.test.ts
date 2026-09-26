import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKENS } from '@/container.js';
import {
  databaseConnectionFolders,
  databaseConnections,
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  loggingEnvironmentFolders,
  loggingEnvironments,
  nodeFolders,
  nodes,
  objectStorageConnections,
  objectStorageFolders,
  proxyHostFolders,
  proxyHosts,
} from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { boundScopes, hasScopeForCreation } from '@/lib/permissions.js';
import { canonicalizeScopes, isMcpTokenScope, SYSTEM_ADMIN_SCOPES } from '@/lib/scopes.js';
import { directResourceIdsForScopes } from '@/modules/ai/ai.service-helpers.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import type { User } from '@/types.js';
import {
  AIService,
  container,
  createFolderScopeTestDb,
  createService,
  DockerDeploymentService,
  LoggingEnvironmentService,
  USER,
} from './mcp-ai-audit.test-helpers.js';
import { registerMcpToolHandlers } from './mcp-tools.js';

vi.mock('@/modules/docker/compose/compose-child.guard.js', () => ({
  assertComposeChildMutationAllowed: vi.fn().mockResolvedValue(undefined),
  assertComposeVolumeMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

/**
 * A token whose only grants target folders ("MyProject") must reach every resource inside the
 * folder through MCP, including resources placed there after the grant, and nothing outside it.
 * Folder grants are expanded by the real `expandFolderScopes`, like every authenticated request.
 */

const NODE = '44444444-4444-4444-8444-444444444444';
const INGRESS_NODE = '55555555-5555-4555-8555-555555555555';
const CONTAINER_FOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const IMAGE_FOLDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const VOLUME_FOLDER = 'aaaaaaaa-0000-4000-8000-000000000003';
const NETWORK_FOLDER = 'aaaaaaaa-0000-4000-8000-000000000004';
const ROUTE_FOLDER = 'bbbbbbbb-0000-4000-8000-000000000001';
const EMPTY_ROUTE_FOLDER = 'bbbbbbbb-0000-4000-8000-000000000002';
const DATABASE_FOLDER = 'cccccccc-0000-4000-8000-000000000001';
const STORAGE_FOLDER = 'cccccccc-0000-4000-8000-000000000002';
const EMPTY_STORAGE_FOLDER = 'cccccccc-0000-4000-8000-000000000003';
const LOGGING_FOLDER = 'cccccccc-0000-4000-8000-000000000004';
const NODE_FOLDER = 'dddddddd-0000-4000-8000-000000000001';
const EMPTY_NODE_FOLDER = 'dddddddd-0000-4000-8000-000000000002';
const ROUTE_IN = 'eeeeeeee-0000-4000-8000-000000000001';
const ROUTE_OUT = 'eeeeeeee-0000-4000-8000-000000000002';
const IMAGE_IN = `sha256:${'1'.repeat(64)}`;
const IMAGE_OUT = `sha256:${'2'.repeat(64)}`;

function folderRows() {
  return new Map<unknown, Array<Record<string, unknown>>>([
    [
      dockerContainerFolders,
      [
        { id: CONTAINER_FOLDER, parentId: null, resourceType: 'container' },
        { id: IMAGE_FOLDER, parentId: null, resourceType: 'image' },
        { id: VOLUME_FOLDER, parentId: null, resourceType: 'volume' },
        { id: NETWORK_FOLDER, parentId: null, resourceType: 'network' },
      ],
    ],
    [
      dockerContainerFolderAssignments,
      [
        { folderId: CONTAINER_FOLDER, nodeId: NODE, resourceType: 'container', resourceKey: 'app' },
        { folderId: CONTAINER_FOLDER, nodeId: NODE, resourceType: 'container', resourceKey: 'web' },
        { folderId: IMAGE_FOLDER, nodeId: NODE, resourceType: 'image', resourceKey: IMAGE_IN },
        { folderId: VOLUME_FOLDER, nodeId: NODE, resourceType: 'volume', resourceKey: 'data-in' },
        { folderId: NETWORK_FOLDER, nodeId: NODE, resourceType: 'network', resourceKey: 'net-key-in' },
      ],
    ],
    [
      dockerAccessResources,
      [
        { id: 'access-app', nodeId: NODE, resourceKey: 'app' },
        { id: 'access-other', nodeId: NODE, resourceKey: 'other' },
        { id: 'access-net-in', nodeId: NODE, resourceKey: 'net-key-in' },
        { id: 'access-net-out', nodeId: NODE, resourceKey: 'net-key-out' },
      ],
    ],
    [
      dockerDeployments,
      [
        { id: 'deployment-in', nodeId: NODE, name: 'web' },
        { id: 'deployment-out', nodeId: NODE, name: 'api' },
      ],
    ],
    [dockerComposeProjects, []],
    [
      proxyHostFolders,
      [
        { id: ROUTE_FOLDER, parentId: null },
        { id: EMPTY_ROUTE_FOLDER, parentId: null },
      ],
    ],
    [
      proxyHosts,
      [
        { id: ROUTE_IN, folderId: ROUTE_FOLDER },
        { id: ROUTE_OUT, folderId: null },
      ],
    ],
    [databaseConnectionFolders, [{ id: DATABASE_FOLDER, parentId: null }]],
    [
      databaseConnections,
      [
        { id: 'database-in', folderId: DATABASE_FOLDER },
        { id: 'database-out', folderId: null },
      ],
    ],
    [
      objectStorageFolders,
      [
        { id: STORAGE_FOLDER, parentId: null },
        { id: EMPTY_STORAGE_FOLDER, parentId: null },
      ],
    ],
    [
      objectStorageConnections,
      [
        { id: 'storage-in', folderId: STORAGE_FOLDER },
        { id: 'storage-out', folderId: null },
      ],
    ],
    [loggingEnvironmentFolders, [{ id: LOGGING_FOLDER, parentId: null }]],
    [
      loggingEnvironments,
      [
        { id: 'env-in', folderId: LOGGING_FOLDER },
        { id: 'env-out', folderId: null },
      ],
    ],
    [
      nodeFolders,
      [
        { id: NODE_FOLDER, parentId: null },
        { id: EMPTY_NODE_FOLDER, parentId: null },
      ],
    ],
    [
      nodes,
      [
        { id: NODE, folderId: NODE_FOLDER },
        { id: INGRESS_NODE, folderId: null },
      ],
    ],
  ]);
}

let rows = folderRows();

function expand(scopes: string[]) {
  return expandFolderScopes(createFolderScopeTestDb(rows) as never, scopes);
}

function folderGrants(bases: string[], folderId: string) {
  return bases.map((base) => `${base}:folder/${folderId}`);
}

type McpResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

/**
 * The token's owner: `null` holds the same folder grants as the token; otherwise a system administrator
 * whose broad scopes must never widen the folder-restricted grant (the rc.10 report).
 */
let ownerScopes: string[] | null = null;

/**
 * One MCP connection for an OAuth token, expanded and bounded by its owner like the OAuth token
 * lifecycle and AuthService do on every request.
 */
async function connect(grants: string[], services: Parameters<typeof createService>[0]) {
  const expanded = await expand(grants);
  const scopes = ownerScopes
    ? canonicalizeScopes(boundScopes(expanded, ownerScopes)).filter(isMcpTokenScope)
    : expanded;
  const account: User = { ...USER, scopes: ownerScopes ?? scopes };
  const service = createService({
    ...services,
    authService: { getUserById: vi.fn().mockResolvedValue(account) },
  });
  container.registerInstance(AIService, service);
  const handlers = new Map<unknown, (request: unknown, extra: unknown) => Promise<unknown>>();
  const server = {
    server: {
      registerCapabilities: vi.fn(),
      setRequestHandler: (schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) =>
        handlers.set(schema, handler),
    },
  };
  registerMcpToolHandlers(
    server as never,
    {
      server: server as never,
      scopes,
      tokenId: 'token-folder',
      tokenPrefix: 'gwo_folder',
      authType: 'oauth',
      eagerToolListing: true,
    },
    account
  );
  return {
    scopes,
    async toolNames(): Promise<string[]> {
      const result = (await handlers.get(ListToolsRequestSchema)!({ params: {} }, {})) as {
        tools: Array<{ name: string }>;
      };
      return result.tools.map((tool) => tool.name);
    },
    async call(name: string, args: Record<string, unknown>) {
      const result = (await handlers.get(CallToolRequestSchema)!(
        { params: { name, arguments: args } },
        { sendNotification: vi.fn() }
      )) as McpResult;
      const text = result.content[0]?.text ?? '';
      if (result.isError) return { error: text };
      return { result: JSON.parse(text) };
    },
  };
}

function registerPlatformServices() {
  container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as never);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
    requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
}

const auditService = () => ({ log: vi.fn().mockResolvedValue(undefined) });

describe.each([
  ['with the same folder grants', null],
  ['who is a system administrator', [...SYSTEM_ADMIN_SCOPES]],
])('MCP tools with folder-scoped grants, owner %s', (_owner, owner) => {
  beforeEach(() => {
    ownerScopes = owner;
    rows = folderRows();
    registerPlatformServices();
  });

  describe('Docker containers', () => {
    const grants = folderGrants(
      ['docker:containers:view', 'docker:containers:manage', 'docker:containers:create'],
      CONTAINER_FOLDER
    );
    const containerRows = () => [
      { id: 'runtime-app', name: 'app', state: 'running', scopeResourceId: 'access-app' },
      { id: 'runtime-other', name: 'other', state: 'running', scopeResourceId: 'access-other' },
      { id: 'runtime-new', name: 'app-new', state: 'running', scopeResourceId: 'access-new' },
    ];
    const inspect = (_nodeId: string, containerId: string) => {
      const row = containerRows().find((item) => item.name === containerId || item.id === containerId);
      return Promise.resolve({
        Id: row?.id ?? containerId,
        Name: `/${row?.name ?? containerId}`,
        Config: { Labels: {}, Env: [] },
        State: { Status: 'running' },
        scopeResourceId: row?.scopeResourceId ?? '',
      });
    };

    function dockerService() {
      return {
        listContainers: vi.fn().mockResolvedValue(containerRows()),
        inspectContainer: vi.fn(inspect),
        startContainer: vi.fn().mockResolvedValue(undefined),
        stopContainer: vi.fn().mockResolvedValue({ accepted: true }),
        createContainer: vi.fn(
          async (nodeId: string, input: { folderId?: string | null; name: string }, _userId: string, scopes) => {
            // DockerManagementService.createContainer authorizes the destination like this.
            if (!hasScopeForCreation(scopes, 'docker:containers:create', input.folderId, nodeId)) {
              throw new Error('Missing docker:containers:create for the destination node or folder');
            }
            return { id: 'runtime-created', name: input.name };
          }
        ),
      };
    }

    it('offers the container tools and lists only the containers inside the folder', async () => {
      const docker = dockerService();
      const mcp = await connect(grants, { nodesService: {}, dockerService: docker, auditService: auditService() });

      expect(mcp.scopes).toEqual(
        expect.arrayContaining([
          `docker:containers:view:${NODE}/access-app`,
          `docker:containers:view:${NODE}/deployment-in`,
        ])
      );
      expect(await mcp.toolNames()).toEqual(
        expect.arrayContaining([
          'list_docker_containers',
          'get_docker_container',
          'start_docker_container',
          'stop_docker_container',
          'create_docker_container',
          'list_docker_deployments',
          'list_resource_folders',
        ])
      );

      const listed = await mcp.call('list_docker_containers', { nodeId: NODE });
      expect(listed.error).toBeUndefined();
      expect(listed.result.data.map((item: { name: string }) => item.name)).toEqual(['app']);
    });

    it('reads and controls containers inside the folder and refuses containers outside it', async () => {
      const docker = dockerService();
      const mcp = await connect(grants, { nodesService: {}, dockerService: docker, auditService: auditService() });

      await expect(mcp.call('get_docker_container', { nodeId: NODE, containerId: 'app' })).resolves.toMatchObject({
        result: { Id: 'runtime-app' },
      });
      await expect(mcp.call('start_docker_container', { nodeId: NODE, containerId: 'app' })).resolves.toEqual({
        result: { success: true },
      });
      expect(docker.startContainer).toHaveBeenCalledWith(NODE, 'app', USER.id);

      const outsideRead = await mcp.call('get_docker_container', { nodeId: NODE, containerId: 'other' });
      expect(outsideRead.error).toContain('PERMISSION_DENIED');
      const outsideStop = await mcp.call('stop_docker_container', { nodeId: NODE, containerId: 'other' });
      expect(outsideStop.error).toContain('PERMISSION_DENIED');
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    it('sees and controls a container placed in the folder after the grant', async () => {
      rows.get(dockerContainerFolderAssignments)!.push({
        folderId: CONTAINER_FOLDER,
        nodeId: NODE,
        resourceType: 'container',
        resourceKey: 'app-new',
      });
      rows.get(dockerAccessResources)!.push({ id: 'access-new', nodeId: NODE, resourceKey: 'app-new' });
      const docker = dockerService();
      const mcp = await connect(grants, { nodesService: {}, dockerService: docker, auditService: auditService() });

      const listed = await mcp.call('list_docker_containers', { nodeId: NODE });
      expect(listed.result.data.map((item: { name: string }) => item.name)).toEqual(['app', 'app-new']);
      await expect(mcp.call('start_docker_container', { nodeId: NODE, containerId: 'app-new' })).resolves.toEqual({
        result: { success: true },
      });
    });

    it('creates containers in the granted folder only', async () => {
      const docker = dockerService();
      const mcp = await connect(grants, { nodesService: {}, dockerService: docker, auditService: auditService() });

      const created = await mcp.call('create_docker_container', {
        nodeId: NODE,
        folderId: CONTAINER_FOLDER,
        image: 'nginx:alpine',
        name: 'app-2',
      });
      expect(created.error).toBeUndefined();
      expect(created.result).toMatchObject({ success: true, data: { id: 'runtime-created' } });

      const outside = await mcp.call('create_docker_container', { nodeId: NODE, image: 'nginx:alpine', name: 'app-3' });
      expect(outside.error).toContain('Missing docker:containers:create');
    });
  });

  it('lists and controls Docker deployments inside the folder only', async () => {
    const listSummary = vi.fn().mockResolvedValue([
      { id: 'deployment-in', nodeId: NODE, name: 'web', status: 'running' },
      { id: 'deployment-out', nodeId: NODE, name: 'api', status: 'running' },
    ]);
    const start = vi.fn().mockResolvedValue({ id: 'deployment-in', status: 'running' });
    container.registerInstance(DockerDeploymentService, { listSummary, start } as never);
    const mcp = await connect(folderGrants(['docker:containers:view', 'docker:containers:manage'], CONTAINER_FOLDER), {
      nodesService: {},
      auditService: auditService(),
    });

    const listed = await mcp.call('list_docker_deployments', { nodeId: NODE });
    expect(listed.error).toBeUndefined();
    expect(listed.result.data.map((item: { id: string }) => item.id)).toEqual(['deployment-in']);

    await expect(
      mcp.call('start_docker_deployment', { nodeId: NODE, deploymentId: 'deployment-in' })
    ).resolves.toMatchObject({ result: { success: true } });
    const outside = await mcp.call('start_docker_deployment', { nodeId: NODE, deploymentId: 'deployment-out' });
    expect(outside.error).toContain('PERMISSION_DENIED');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lists Docker images, volumes and networks of their folders and removes only images inside', async () => {
    const docker = {
      listImages: vi.fn().mockResolvedValue([
        { id: IMAGE_IN, repoTags: ['app:1'] },
        { id: IMAGE_OUT, repoTags: ['other:1'] },
      ]),
      listVolumes: vi.fn().mockResolvedValue([{ name: 'data-in' }, { name: 'data-out' }]),
      listNetworks: vi.fn().mockResolvedValue([
        { id: 'network-in', name: 'app-net', Labels: {}, scopeResourceId: 'access-net-in' },
        { id: 'network-out', name: 'other-net', Labels: {}, scopeResourceId: 'access-net-out' },
      ]),
      removeImage: vi.fn().mockResolvedValue(undefined),
    };
    const mcp = await connect(
      [
        ...folderGrants(['docker:images:view', 'docker:images:delete'], IMAGE_FOLDER),
        ...folderGrants(['docker:volumes:view'], VOLUME_FOLDER),
        ...folderGrants(['docker:networks:view'], NETWORK_FOLDER),
      ],
      { nodesService: {}, dockerService: docker, auditService: auditService() }
    );

    expect(await mcp.toolNames()).toEqual(
      expect.arrayContaining([
        'list_docker_images',
        'list_docker_volumes',
        'list_docker_networks',
        'remove_docker_image',
      ])
    );
    const images = await mcp.call('list_docker_images', { nodeId: NODE });
    expect(images.result.data.map((item: { id: string }) => item.id)).toEqual([IMAGE_IN]);
    const volumes = await mcp.call('list_docker_volumes', { nodeId: NODE });
    expect(volumes.result.data.map((item: { name: string }) => item.name)).toEqual(['data-in']);
    const networks = await mcp.call('list_docker_networks', { nodeId: NODE });
    expect(networks.result.data.map((item: { id: string }) => item.id)).toEqual(['network-in']);

    await expect(mcp.call('remove_docker_image', { nodeId: NODE, imageId: IMAGE_IN })).resolves.toEqual({
      result: { success: true },
    });
    const outside = await mcp.call('remove_docker_image', { nodeId: NODE, imageId: IMAGE_OUT });
    expect(outside.error).toContain('PERMISSION_DENIED');
    expect(docker.removeImage).toHaveBeenCalledTimes(1);
  });

  it('lets the assistant list folder-scoped Docker images, volumes and networks too', async () => {
    const scopes = await expand([
      ...folderGrants(['docker:images:view'], IMAGE_FOLDER),
      ...folderGrants(['docker:volumes:view'], VOLUME_FOLDER),
      ...folderGrants(['docker:networks:view'], NETWORK_FOLDER),
    ]);
    const service = createService({
      nodesService: {},
      auditService: auditService(),
      authService: { getUserById: vi.fn().mockResolvedValue({ ...USER, scopes }) },
      dockerService: {
        listImages: vi.fn().mockResolvedValue([{ id: IMAGE_IN }, { id: IMAGE_OUT }]),
        listVolumes: vi.fn().mockResolvedValue([{ name: 'data-in' }, { name: 'data-out' }]),
        listNetworks: vi.fn().mockResolvedValue([
          { id: 'network-in', Labels: {}, scopeResourceId: 'access-net-in' },
          { id: 'network-out', Labels: {}, scopeResourceId: 'access-net-out' },
        ]),
      },
    });
    const user = { ...USER, scopes };

    const images = await service.executeTool(user, 'list_docker_images', { nodeId: NODE });
    expect((images.result as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual([IMAGE_IN]);
    const volumes = await service.executeTool(user, 'list_docker_volumes', { nodeId: NODE });
    expect((volumes.result as { data: Array<{ name: string }> }).data.map((item) => item.name)).toEqual(['data-in']);
    const networks = await service.executeTool(user, 'list_docker_networks', { nodeId: NODE });
    expect((networks.result as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual(['network-in']);
  });

  describe('routes', () => {
    const grants = [
      ...folderGrants(['proxy:view', 'proxy:edit', 'proxy:create'], ROUTE_FOLDER),
      ...folderGrants(['proxy:create'], EMPTY_ROUTE_FOLDER),
    ];
    const host = (id: string, folderId: string | null) => ({
      id,
      slug: id.slice(0, 8),
      type: 'proxy',
      domainNames: [`${id.slice(0, 8)}.example.com`],
      enabled: true,
      nodeId: INGRESS_NODE,
      folderId,
    });

    it('lists and reads routes inside the folder and refuses routes outside it', async () => {
      const proxyService = {
        listProxyHosts: vi.fn().mockResolvedValue({ data: [host(ROUTE_IN, ROUTE_FOLDER)], total: 1 }),
        getProxyHost: vi.fn().mockImplementation((id: string) => Promise.resolve(host(id, ROUTE_FOLDER))),
      };
      const mcp = await connect(grants, { nodesService: {}, proxyService, auditService: auditService() });

      const listed = await mcp.call('list_routes', {});
      expect(listed.error).toBeUndefined();
      expect(proxyService.listProxyHosts).toHaveBeenCalledWith(expect.anything(), { allowedIds: [ROUTE_IN] });

      await expect(mcp.call('get_route', { routeId: ROUTE_IN })).resolves.toMatchObject({ result: { id: ROUTE_IN } });
      const outside = await mcp.call('get_route', { routeId: ROUTE_OUT });
      expect(outside.error).toContain('unavailable for this MCP token');
      expect(proxyService.getProxyHost).toHaveBeenCalledTimes(1);
    });

    it('creates routes in the granted folders only', async () => {
      const createProxyHost = vi.fn().mockResolvedValue(host('ffffffff-0000-4000-8000-000000000001', ROUTE_FOLDER));
      const proxyService = { createProxyHost, assertReferenceAccess: vi.fn().mockResolvedValue(undefined) };
      const mcp = await connect(grants, { nodesService: {}, proxyService, auditService: auditService() });
      const route = { nodeId: INGRESS_NODE, domainNames: ['new.example.com'], forwardHost: 'app', forwardPort: 80 };

      await expect(mcp.call('create_route', { ...route, folderId: ROUTE_FOLDER })).resolves.toMatchObject({
        result: { id: 'ffffffff-0000-4000-8000-000000000001' },
      });
      await expect(mcp.call('create_route', { ...route, folderId: EMPTY_ROUTE_FOLDER })).resolves.toMatchObject({
        result: { id: 'ffffffff-0000-4000-8000-000000000001' },
      });
      const outside = await mcp.call('create_route', route);
      expect(outside.error).toContain('Missing proxy:create permission for the selected destination');
      expect(createProxyHost).toHaveBeenCalledTimes(2);
    });

    it('shows the granted route folders, including an empty one', async () => {
      const getFolderTree = vi.fn().mockResolvedValue([]);
      container.registerInstance(FolderService, { getFolderTree } as never);
      const mcp = await connect(grants, { nodesService: {}, auditService: auditService() });

      await expect(mcp.call('list_resource_folders', { resourceType: 'routes' })).resolves.toEqual({ result: [] });
      expect(getFolderTree).toHaveBeenCalledWith({
        allowedHostIds: [ROUTE_IN],
        allowedFolderIds: expect.arrayContaining([ROUTE_FOLDER, EMPTY_ROUTE_FOLDER]),
      });
    });

    it('lets a creator-only token discover the folders and ingress nodes it may create in', async () => {
      const getFolderTree = vi.fn().mockResolvedValue([]);
      container.registerInstance(FolderService, { getFolderTree } as never);
      const nodesService = {
        list: vi.fn().mockResolvedValue({
          data: [{ id: INGRESS_NODE, type: 'nginx', hostname: 'edge', osInfo: { os: 'linux' }, capabilities: {} }],
          total: 1,
        }),
      };
      const mcp = await connect(folderGrants(['proxy:create'], EMPTY_ROUTE_FOLDER), {
        nodesService,
        auditService: auditService(),
      });

      expect(await mcp.toolNames()).toEqual(
        expect.arrayContaining(['list_nodes', 'list_resource_folders', 'create_route'])
      );
      await mcp.call('list_resource_folders', { resourceType: 'routes' });
      expect(getFolderTree).toHaveBeenCalledWith({ allowedHostIds: [], allowedFolderIds: [EMPTY_ROUTE_FOLDER] });

      const ingress = await mcp.call('list_nodes', { type: 'nginx' });
      expect(ingress.error).toBeUndefined();
      expect(nodesService.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'nginx' }), undefined);
      // Creators receive the destination summary only.
      expect(ingress.result.data).toEqual([expect.not.objectContaining({ osInfo: expect.anything() })]);

      // Without a type, the creator still gets the nodes its grants target instead of a refusal.
      const everything = await mcp.call('list_nodes', {});
      expect(everything.error).toBeUndefined();
      expect(everything.result).toMatchObject({ types: ['nginx'], total: 1 });
      expect(everything.result.data).toEqual([expect.not.objectContaining({ osInfo: expect.anything() })]);
      expect(nodesService.list).toHaveBeenCalledTimes(2);
      expect(nodesService.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'nginx' }), undefined);
    });
  });

  it('lists the nodes of a granted node folder and an empty granted folder without failing', async () => {
    const nodesService = { list: vi.fn().mockResolvedValue({ data: [], total: 0 }) };
    const mcp = await connect(folderGrants(['nodes:details'], NODE_FOLDER), {
      nodesService,
      auditService: auditService(),
    });
    await expect(mcp.call('list_nodes', {})).resolves.toMatchObject({ result: { total: 0 } });
    expect(nodesService.list).toHaveBeenLastCalledWith(expect.anything(), { allowedIds: [NODE] });

    const empty = await connect(folderGrants(['nodes:details'], EMPTY_NODE_FOLDER), {
      nodesService,
      auditService: auditService(),
    });
    await expect(empty.call('list_nodes', {})).resolves.toMatchObject({ result: { total: 0 } });
    expect(nodesService.list).toHaveBeenLastCalledWith(expect.anything(), { allowedIds: [] });
  });

  it('lists logging environments inside the folder only', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 'env-in', name: 'prod' }]);
    container.registerInstance(LoggingEnvironmentService, { list } as never);
    container.registerInstance(LoggingFeatureService, {
      requireEnabled: vi.fn(),
      requireAvailableForStorage: vi.fn(),
    } as unknown as LoggingFeatureService);
    const mcp = await connect(folderGrants(['logs:environments:view'], LOGGING_FOLDER), {
      nodesService: {},
      auditService: auditService(),
    });

    await expect(mcp.call('manage_logging', { resource: 'environment', operation: 'list' })).resolves.toEqual({
      result: [{ id: 'env-in', name: 'prod' }],
    });
    expect(list).toHaveBeenCalledWith({ search: undefined, allowedIds: ['env-in'] });
  });

  it('lists databases and storage connections of their folders with concrete ids only', async () => {
    const databaseService = { list: vi.fn().mockResolvedValue({ data: [{ id: 'database-in' }], total: 1 }) };
    const storageList = vi.fn().mockResolvedValue({ data: [{ id: 'storage-in' }], total: 1 });
    // Stand-in for the commercial executors: both list their rows through the shared runtime helper.
    container.registerInstance(TOKENS.CommercialEdition, {
      requireAvailable: vi.fn(),
      executeDatabaseTool: (
        context: { databaseService: typeof databaseService },
        user: User,
        _name: string,
        _args: unknown,
        runtime: { directResourceIdsForScopes: typeof directResourceIdsForScopes }
      ) =>
        context.databaseService.list(
          { page: 1, limit: 100 },
          { allowedIds: runtime.directResourceIdsForScopes(user.scopes, 'databases:view') }
        ),
      executeStorageTool: (
        user: User,
        _name: string,
        _args: unknown,
        runtime: { directResourceIdsForScopes: typeof directResourceIdsForScopes }
      ) => storageList({ allowedIds: runtime.directResourceIdsForScopes(user.scopes, 'storage:view') }),
    } as never);
    const mcp = await connect(
      [
        ...folderGrants(['databases:view'], DATABASE_FOLDER),
        ...folderGrants(['storage:view', 'storage:create'], STORAGE_FOLDER),
      ],
      { nodesService: {}, databaseService, auditService: auditService() }
    );

    expect(mcp.scopes).toEqual(expect.arrayContaining([`databases:view:folder/${DATABASE_FOLDER}`]));
    expect(directResourceIdsForScopes(mcp.scopes, 'databases:view')).toEqual(['database-in']);
    await expect(mcp.call('list_databases', {})).resolves.toMatchObject({ result: { total: 1 } });
    expect(databaseService.list).toHaveBeenCalledWith({ page: 1, limit: 100 }, { allowedIds: ['database-in'] });
    await expect(mcp.call('list_storage_connections', {})).resolves.toMatchObject({ result: { total: 1 } });
    expect(storageList).toHaveBeenCalledWith({ allowedIds: ['storage-in'] });
  });

  it('shows granted storage folders to storage creators, including an empty one', async () => {
    const getFolderTree = vi.fn().mockResolvedValue([]);
    container.registerInstance(ObjectStorageFolderService, { getFolderTree } as never);
    const mcp = await connect(
      [...folderGrants(['storage:create'], EMPTY_STORAGE_FOLDER), ...folderGrants(['storage:view'], STORAGE_FOLDER)],
      { nodesService: {}, auditService: auditService() }
    );

    await expect(mcp.call('list_resource_folders', { resourceType: 'storage' })).resolves.toEqual({ result: [] });
    expect(getFolderTree).toHaveBeenCalledWith({
      allowedResourceIds: ['storage-in'],
      allowedFolderIds: expect.arrayContaining([STORAGE_FOLDER, EMPTY_STORAGE_FOLDER]),
    });
  });
});
