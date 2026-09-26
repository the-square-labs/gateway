import 'reflect-metadata';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
} from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { boundScopes } from '@/lib/permissions.js';
import { canonicalizeScopes, isMcpTokenScope, SYSTEM_ADMIN_SCOPES } from '@/lib/scopes.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DockerAccessResourceService } from '@/modules/docker/docker-access-resource.service.js';
import { assertDockerCreationAccess } from '@/modules/docker/docker-creation-access.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';
import { AIService, container, createFolderScopeTestDb, createService, USER } from './mcp-ai-audit.test-helpers.js';
import { registerMcpToolHandlers } from './mcp-tools.js';

vi.mock('@/modules/docker/compose/compose-child.guard.js', () => ({
  assertComposeChildMutationAllowed: vi.fn().mockResolvedValue(undefined),
  assertComposeVolumeMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

const sourceCreation = vi.hoisted(() => ({ createDockerSourceResource: vi.fn() }));
vi.mock('@/modules/docker/docker-source-resource-creation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/docker/docker-source-resource-creation.js')>()),
  createDockerSourceResource: sourceCreation.createDockerSourceResource,
}));

/**
 * rc.10 report: an OAuth/MCP grant restricted to one Docker folder, owned by an administrator with broad
 * scopes, must not create containers at the node root (or in another folder) nor read containers outside
 * the folder. The grant is expanded and bounded exactly like OAuthTokenLifecycle.validateAccessToken, and
 * AIService.executeTool bounds it again by the owner's live scopes.
 */

const NODE = '44444444-4444-4444-8444-444444444444';
const FOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_FOLDER = 'aaaaaaaa-0000-4000-8000-000000000002';

function rows() {
  return new Map<unknown, Array<Record<string, unknown>>>([
    [
      dockerContainerFolders,
      [
        { id: FOLDER, parentId: null, resourceType: 'container', isSystem: false },
        { id: OTHER_FOLDER, parentId: null, resourceType: 'container', isSystem: false },
      ],
    ],
    [
      dockerContainerFolderAssignments,
      [{ folderId: FOLDER, nodeId: NODE, resourceType: 'container', resourceKey: 'app' }],
    ],
    [
      dockerAccessResources,
      [
        { id: 'access-app', nodeId: NODE, resourceKey: 'app' },
        { id: 'access-root', nodeId: NODE, resourceKey: 'root-app' },
      ],
    ],
    [dockerDeployments, []],
    [dockerComposeProjects, []],
  ]);
}

/** The Drizzle subset `assertDockerCreationAccess` uses to confirm a destination folder exists. */
function destinationDb() {
  const folders = rows().get(dockerContainerFolders)!;
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => folders.filter((folder) => folder.id === pendingFolderId) }),
      }),
    }),
  };
}
let pendingFolderId: unknown;

/** The owner is a system administrator who also created a container at the node root. */
const OWNER_SCOPES = canonicalizeScopes([
  ...SYSTEM_ADMIN_SCOPES,
  `docker:containers:view:${NODE}/access-root`,
  `docker:containers:manage:${NODE}/access-root`,
]);

const GRANT = [
  `docker:containers:view:folder/${FOLDER}`,
  `docker:containers:create:folder/${FOLDER}`,
  `docker:containers:manage:folder/${FOLDER}`,
];

async function tokenScopes(grant: string[]) {
  const expanded = await expandFolderScopes(createFolderScopeTestDb(rows()) as never, grant);
  return canonicalizeScopes(boundScopes(expanded, OWNER_SCOPES)).filter(isMcpTokenScope);
}

const containerRows = [
  { id: 'runtime-app', name: 'app', state: 'running', scopeResourceId: 'access-app' },
  { id: 'runtime-root', name: 'root-app', state: 'running', scopeResourceId: 'access-root' },
];

function dockerService() {
  return {
    listContainers: vi.fn().mockResolvedValue(containerRows),
    inspectContainer: vi.fn(async (_nodeId: string, containerId: string) => {
      const row = containerRows.find((item) => item.name === containerId || item.id === containerId);
      return {
        Id: row?.id ?? containerId,
        Name: `/${row?.name ?? containerId}`,
        Config: { Labels: {}, Env: [] },
        State: { Status: 'running' },
        scopeResourceId: row?.scopeResourceId ?? '',
      };
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    // The first statement of DockerManagementService.createContainer / duplicateContainer.
    createContainer: vi.fn(async (nodeId: string, input: { folderId?: string | null }, _userId: string, scopes) => {
      pendingFolderId = input.folderId;
      await assertDockerCreationAccess(
        destinationDb() as never,
        scopes,
        'docker:containers:create',
        nodeId,
        input.folderId
      );
      return { id: 'runtime-created', name: 'created' };
    }),
    duplicateContainer: vi.fn(
      async (
        nodeId: string,
        _id: string,
        _name: string,
        _userId: string,
        scopes: string[],
        folderId?: string | null
      ) => {
        pendingFolderId = folderId;
        await assertDockerCreationAccess(
          destinationDb() as never,
          scopes,
          'docker:containers:create',
          nodeId,
          folderId
        );
        return { id: 'runtime-duplicate' };
      }
    ),
  };
}

async function connect(scopes: string[], docker: ReturnType<typeof dockerService>) {
  const account: User = { ...USER, scopes: OWNER_SCOPES };
  const service = createService({
    nodesService: {},
    dockerService: docker,
    auditService: { log: vi.fn().mockResolvedValue(undefined) },
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
      tokenId: 'token',
      tokenPrefix: 'gwo_x',
      authType: 'oauth',
      eagerToolListing: true,
    },
    account
  );
  return async (name: string, args: Record<string, unknown>) => {
    const result = (await handlers.get(CallToolRequestSchema)!(
      { params: { name, arguments: args } },
      { sendNotification: vi.fn() }
    )) as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content[0]?.text ?? '';
    return result.isError ? { error: text } : { result: JSON.parse(text) };
  };
}

describe('folder-restricted MCP grant owned by an administrator', () => {
  beforeEach(() => {
    pendingFolderId = undefined;
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as never);
    container.registerInstance(LicensePolicyService, {
      requireFeature: vi.fn().mockResolvedValue(undefined),
      requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
    } as unknown as LicensePolicyService);
  });

  it('bounds the grant to the folder, never to the administrator', async () => {
    const scopes = await tokenScopes(GRANT);
    expect(scopes).toEqual(
      expect.arrayContaining([`docker:containers:view:${NODE}/access-app`, `docker:containers:create:folder/${FOLDER}`])
    );
    expect(scopes.some((scope) => scope.includes('access-root'))).toBe(false);
    expect(scopes).not.toContain('docker:containers:create');
    expect(scopes).not.toContain(`docker:containers:create:${NODE}`);
  });

  it('create_docker_container: only into the granted folder', async () => {
    const docker = dockerService();
    const call = await connect(await tokenScopes(GRANT), docker);

    const root = await call('create_docker_container', { nodeId: NODE, image: 'nginx:alpine', name: 'x1' });
    expect(root.error).toContain('Missing docker:containers:create');
    const other = await call('create_docker_container', {
      nodeId: NODE,
      folderId: OTHER_FOLDER,
      image: 'nginx:alpine',
      name: 'x2',
    });
    expect(other.error).toContain('Missing docker:containers:create');
    const inside = await call('create_docker_container', {
      nodeId: NODE,
      folderId: FOLDER,
      image: 'nginx:alpine',
      name: 'x3',
    });
    expect(inside.error).toBeUndefined();
    // The folder's manage grant covers the new container too, although the request's expanded scopes
    // predate it: it is started like any other container in the folder.
    expect(inside.result).toMatchObject({ message: 'Container created and started' });
    expect(docker.startContainer).toHaveBeenCalledWith(NODE, 'runtime-created', USER.id);
  });

  it('create_docker_container: refuses a Compose label that would re-home the container at the root', async () => {
    const docker = dockerService();
    const call = await connect(await tokenScopes(GRANT), docker);
    const relabelled = await call('create_docker_container', {
      nodeId: NODE,
      folderId: FOLDER,
      image: 'nginx:alpine',
      name: 'x4',
      labels: { 'com.docker.compose.project': 'escape' },
    });
    expect(relabelled.error).toContain('reserved');
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('duplicate_docker_container: never to the root', async () => {
    const docker = dockerService();
    const call = await connect(
      await tokenScopes([
        ...GRANT,
        `docker:containers:environment:folder/${FOLDER}`,
        `docker:containers:secrets:folder/${FOLDER}`,
      ]),
      docker
    );
    const root = await call('duplicate_docker_container', { nodeId: NODE, containerId: 'app', name: 'copy' });
    expect(root.error).toContain('Missing docker:containers:create');
    const inside = await call('duplicate_docker_container', {
      nodeId: NODE,
      containerId: 'app',
      name: 'copy',
      folderId: FOLDER,
    });
    expect(inside.error).toBeUndefined();
  });

  it('assistant (in-app AI) for a folder-restricted account: same boundaries as MCP', async () => {
    const docker = dockerService();
    const scopes = await expandFolderScopes(createFolderScopeTestDb(rows()) as never, GRANT);
    const account: User = { ...USER, scopes };
    const service = createService({
      nodesService: {},
      dockerService: docker,
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      authService: { getUserById: vi.fn().mockResolvedValue(account) },
    });
    const root = await service.executeTool(account, 'create_docker_container', { nodeId: NODE, image: 'nginx:alpine' });
    expect(root.error).toContain('Missing docker:containers:create');
    const inside = await service.executeTool(account, 'create_docker_container', {
      nodeId: NODE,
      folderId: FOLDER,
      image: 'nginx:alpine',
    });
    expect(inside.error).toBeUndefined();
    const read = await service.executeTool(account, 'get_docker_container', { nodeId: NODE, containerId: 'root-app' });
    expect(read.error).toContain('PERMISSION_DENIED');
  });

  it('manage_docker_source create: a container or deployment from a Git source goes into the folder', async () => {
    // The first statement of createDockerSourceResource: the destination check on the chosen folder.
    sourceCreation.createDockerSourceResource.mockImplementation(
      async (nodeId: string, input: { resource: { folderId?: string | null } }, actor: User) => {
        pendingFolderId = input.resource.folderId;
        await assertDockerCreationAccess(
          destinationDb() as never,
          actor.scopes,
          'docker:containers:create',
          nodeId,
          input.resource.folderId
        );
        return { target: { kind: 'container' } };
      }
    );
    const call = await connect(await tokenScopes(GRANT), dockerService());
    const source = {
      operation: 'create',
      nodeId: NODE,
      connectorId: '55555555-5555-4555-8555-555555555555',
      projectId: '66666666-6666-4666-8666-666666666666',
      branch: 'main',
      resourceName: 'from-git',
    };

    const inside = await call('manage_docker_source', { ...source, targetType: 'container', folderId: FOLDER });
    expect(inside.error).toBeUndefined();
    expect(sourceCreation.createDockerSourceResource).toHaveBeenLastCalledWith(
      NODE,
      expect.objectContaining({ resource: expect.objectContaining({ kind: 'container', folderId: FOLDER }) }),
      expect.anything()
    );
    const deployment = await call('manage_docker_source', {
      ...source,
      targetType: 'deployment',
      folderId: FOLDER,
      routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }],
    });
    expect(deployment.error).toBeUndefined();
    expect(sourceCreation.createDockerSourceResource).toHaveBeenLastCalledWith(
      NODE,
      expect.objectContaining({ resource: expect.objectContaining({ kind: 'deployment', folderId: FOLDER }) }),
      expect.anything()
    );
    const root = await call('manage_docker_source', { ...source, targetType: 'container' });
    expect(root.error).toContain('pass folderId');
  });

  it('manage_resource_folder move_resources: moves a pending source container between granted folders only', async () => {
    const moveResourcesToFolder = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(DockerFolderService, { moveResourcesToFolder } as never);
    // A container waiting for its first build is known by its reserved access identity only.
    container.registerInstance(DockerAccessResourceService, {
      resolveResourceByName: vi.fn(async (_nodeId: string, name: string) =>
        name === 'pending-app' ? 'access-app' : null
      ),
    } as never);
    const grant = [
      'docker:folders:manage',
      `docker:containers:edit:folder/${FOLDER}`,
      `docker:containers:edit:folder/${OTHER_FOLDER}`,
      `docker:containers:edit:${NODE}/access-app`,
    ];
    const call = await connect(canonicalizeScopes(boundScopes(grant, OWNER_SCOPES)), dockerService());
    const move = (folderId?: string) =>
      call('manage_resource_folder', {
        resourceType: 'docker',
        operation: 'move_resources',
        dockerResourceType: 'container',
        ...(folderId ? { folderId } : {}),
        items: [{ nodeId: NODE, resourceKey: 'pending-app' }],
      });

    expect((await move(OTHER_FOLDER)).error).toBeUndefined();
    expect(moveResourcesToFolder).toHaveBeenCalledWith(
      { resourceType: 'container', folderId: OTHER_FOLDER, items: [{ nodeId: NODE, resourceKey: 'pending-app' }] },
      USER.id
    );
    // Omitting folderId moves to the root, which a folder-only grant may not do.
    expect((await move()).error).toContain('destination');
    expect(moveResourcesToFolder).toHaveBeenCalledTimes(1);
  });

  it('list_docker_containers and get_docker_container: nothing outside the folder', async () => {
    const docker = dockerService();
    const call = await connect(await tokenScopes(GRANT), docker);

    const listed = await call('list_docker_containers', { nodeId: NODE });
    expect(listed.result.data.map((item: { name: string }) => item.name)).toEqual(['app']);
    const inside = await call('get_docker_container', { nodeId: NODE, containerId: 'app' });
    expect(inside.error).toBeUndefined();
    const root = await call('get_docker_container', { nodeId: NODE, containerId: 'root-app' });
    expect(root.error).toContain('PERMISSION_DENIED');
  });
});
