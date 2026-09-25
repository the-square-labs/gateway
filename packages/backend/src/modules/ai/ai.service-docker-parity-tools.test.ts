import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { assertComposeChildMutationAllowed } from '@/modules/docker/compose/compose-child.guard.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import {
  importDockerContainerArchive,
  openDockerContainerArchiveExport,
  planDockerContainerArchiveImport,
} from '@/modules/docker/docker-container-archive-operations.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerImageCleanupService } from '@/modules/docker/docker-image-cleanup.service.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { DockerRegistryService } from '@/modules/docker/docker-registry.service.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import {
  assertDockerSourceTargetOnNode,
  createComposeProjectFromSource,
  createDockerSourceResource,
} from '@/modules/docker/docker-source-resource-creation.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { DockerArchiveTransferStore, dockerArchiveTransferStore } from './ai.docker-archive-transfer.js';
import { AIService } from './ai.service.js';
import { redactArgsForTool } from './ai.service.tool-helpers.js';
import { isImpersonationBlockedToolCall } from './ai-impersonation-policy.js';

vi.mock('@/modules/docker/compose/compose-child.guard.js', () => ({
  assertComposeChildMutationAllowed: vi.fn().mockResolvedValue(undefined),
  assertComposeVolumeMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/modules/docker/docker-container-archive-operations.js', async (importOriginal) => ({
  assertDockerContainerArchiveExportAllowed: (
    await importOriginal<typeof import('@/modules/docker/docker-container-archive-operations.js')>()
  ).assertDockerContainerArchiveExportAllowed,
  importDockerContainerArchive: vi.fn(),
  openDockerContainerArchiveExport: vi.fn(),
  planDockerContainerArchiveImport: vi.fn(),
}));
vi.mock('@/modules/docker/docker-container-observability.js', () => ({
  getDockerContainerProcesses: vi.fn().mockResolvedValue({ data: { Titles: ['PID'], Processes: [['1']] } }),
  getDockerContainerStatsHistory: vi.fn().mockResolvedValue([{ cpu: 1 }]),
  getLatestDockerContainerStats: vi.fn(),
  listDockerGpuUsage: vi.fn().mockResolvedValue([{ deviceId: 'gpu-0', containerCount: 1, containers: [] }]),
}));
vi.mock('@/modules/docker/docker-source-resource-creation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/docker/docker-source-resource-creation.js')>()),
  assertDockerSourceTargetOnNode: vi.fn().mockResolvedValue(undefined),
  createComposeProjectFromSource: vi.fn(),
  createDockerSourceResource: vi.fn(),
}));
vi.mock('@/modules/nodes/service-creation-lock.js', () => ({
  assertNodeAllowsServiceCreation: vi.fn().mockResolvedValue(undefined),
}));

const NODE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_NODE_ID = '66666666-6666-4666-8666-666666666666';
const DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';
const POLICY_ID = '88888888-8888-4888-8888-888888888888';
const MIGRATION_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function userWith(scopes: string[]) {
  return { ...BASE_USER, scopes };
}

function createService(dockerService: Record<string, unknown> = {}) {
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
    dockerService as never
  );
}

function inspectedContainer(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({ Id: 'container-1', Name: '/api', scopeResourceId: 'scope-1', ...overrides });
}

function registerLicense() {
  const requireFeature = vi.fn().mockResolvedValue(undefined);
  container.registerInstance(LicensePolicyService, { requireFeature } as never);
  return requireFeature;
}

afterEach(() => {
  vi.clearAllMocks();
  container.reset();
});

afterAll(() => {
  dockerArchiveTransferStore().dispose();
});

describe('manage_docker_container', () => {
  const recreateScopes = [
    'docker:containers:manage:node-1/scope-1',
    'docker:containers:edit:node-1/scope-1',
    'docker:containers:config:node-1/scope-1',
    'docker:containers:environment:node-1/scope-1',
    'docker:containers:secrets:node-1/scope-1',
    'docker:images:pull:node-1',
  ];

  it('recreates with the full REST recreate configuration and route scopes', async () => {
    const dockerService = {
      inspectContainer: inspectedContainer(),
      recreateWithConfig: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1' }),
    };
    const args = {
      operation: 'recreate',
      nodeId: 'node-1',
      containerId: 'api',
      image: 'nginx:1.27',
      ports: [{ hostPort: 8080, containerPort: 80 }],
      mounts: [{ containerPath: '/data', name: 'data' }],
      entrypoint: ['/entry'],
      command: ['serve'],
      workingDir: '/srv',
      user: 'app',
      hostname: 'api',
      labels: { team: 'core' },
      stopTimeout: 30,
      restartPolicy: 'on-failure',
      maxRetries: 3,
      memoryLimit: 536870912,
      memorySwap: -1,
      nanoCPUs: 1_000_000_000,
      cpuShares: 512,
      pidsLimit: 100,
      gpu: { deviceIds: [] },
      runtimeProfile: 'default',
    };

    await expect(
      createService(dockerService).executeTool(userWith(recreateScopes), 'manage_docker_container', args)
    ).resolves.toMatchObject({ result: { success: true, data: { taskId: 'task-1' } } });
    const { operation: _operation, nodeId: _nodeId, containerId: _containerId, ...config } = args;
    expect(dockerService.recreateWithConfig).toHaveBeenCalledWith(
      'node-1',
      'api',
      {
        ...config,
        ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
        mounts: [{ containerPath: '/data', name: 'data', readOnly: false }],
      },
      'user-1',
      { actorScopes: recreateScopes, backgroundImagePull: true }
    );
    expect(assertComposeChildMutationAllowed).toHaveBeenCalledWith('node-1', 'api');
  });

  it('keeps a plain recreate on manage and edit but requires config, environment, secrets and pull for a new image', async () => {
    const dockerService = {
      inspectContainer: inspectedContainer(),
      recreateWithConfig: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const service = createService(dockerService);
    const plain = ['docker:containers:manage:node-1/scope-1', 'docker:containers:edit:node-1/scope-1'];

    await expect(
      service.executeTool(userWith(plain), 'manage_docker_container', {
        operation: 'recreate',
        nodeId: 'node-1',
        containerId: 'api',
        restartPolicy: 'always',
      })
    ).resolves.toMatchObject({ result: { success: true } });

    await expect(
      service.executeTool(userWith(plain), 'manage_docker_container', {
        operation: 'recreate',
        nodeId: 'node-1',
        containerId: 'api',
        image: 'nginx:2',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('docker:containers:config') });

    await expect(
      service.executeTool(
        userWith(recreateScopes.filter((scope) => !scope.startsWith('docker:images:pull'))),
        'manage_docker_container',
        { operation: 'recreate', nodeId: 'node-1', containerId: 'api', image: 'nginx:2' }
      )
    ).resolves.toMatchObject({ error: 'Missing docker:images:pull for the destination node or folder' });
    expect(dockerService.recreateWithConfig).toHaveBeenCalledTimes(1);
  });

  it('live-updates limits with edit access and rejects values the REST schema rejects', async () => {
    const dockerService = { inspectContainer: inspectedContainer(), liveUpdateContainer: vi.fn() };
    const service = createService(dockerService);
    const user = userWith(['docker:containers:edit:node-1/scope-1']);

    await expect(
      service.executeTool(user, 'manage_docker_container', {
        operation: 'live_update',
        nodeId: 'node-1',
        containerId: 'api',
        memoryLimit: 1024,
        restartPolicy: 'unless-stopped',
      })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(dockerService.liveUpdateContainer).toHaveBeenCalledWith(
      'node-1',
      'api',
      { memoryLimit: 1024, restartPolicy: 'unless-stopped' },
      'user-1'
    );

    expect(
      (
        await service.executeTool(user, 'manage_docker_container', {
          operation: 'live_update',
          nodeId: 'node-1',
          containerId: 'api',
          memoryLimit: -1,
        })
      ).error
    ).toBeDefined();
    expect(
      (
        await service.executeTool(userWith(['docker:containers:view']), 'manage_docker_container', {
          operation: 'live_update',
          nodeId: 'node-1',
          containerId: 'api',
          cpuShares: 2,
        })
      ).error
    ).toContain('docker:containers:edit');
    expect(dockerService.liveUpdateContainer).toHaveBeenCalledTimes(1);
  });

  it('requires environment access when an update changes the environment', async () => {
    const dockerService = {
      inspectContainer: inspectedContainer(),
      updateContainer: vi.fn().mockResolvedValue({ taskId: 'task-2' }),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool(userWith(['docker:containers:edit']), 'manage_docker_container', {
        operation: 'update',
        nodeId: 'node-1',
        containerId: 'api',
        tag: '2.0',
        env: { MODE: 'prod' },
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('docker:containers:environment') });

    const scopes = ['docker:containers:edit', 'docker:containers:environment'];
    await expect(
      service.executeTool(userWith(scopes), 'manage_docker_container', {
        operation: 'update',
        nodeId: 'node-1',
        containerId: 'api',
        tag: '2.0',
        env: { MODE: 'prod' },
      })
    ).resolves.toMatchObject({ result: { taskId: 'task-2' } });
    expect(dockerService.updateContainer).toHaveBeenCalledWith(
      'node-1',
      'api',
      { tag: '2.0', env: { MODE: 'prod' } },
      'user-1',
      scopes
    );
  });

  it('reads processes, stats history and GPU usage with view access', async () => {
    const service = createService({ inspectContainer: inspectedContainer() });
    const user = userWith(['docker:containers:view:node-1']);

    await expect(
      service.executeTool(user, 'manage_docker_container', {
        operation: 'processes',
        nodeId: 'node-1',
        containerId: 'api',
      })
    ).resolves.toMatchObject({ result: { data: { Processes: [['1']] } } });
    await expect(
      service.executeTool(user, 'manage_docker_container', {
        operation: 'stats_history',
        nodeId: 'node-1',
        containerId: 'api',
      })
    ).resolves.toMatchObject({ result: [{ cpu: 1 }] });
    await expect(
      service.executeTool(user, 'manage_docker_container', { operation: 'gpu_usage', nodeId: 'node-1' })
    ).resolves.toMatchObject({ result: [{ deviceId: 'gpu-0' }] });
    expect(
      (await service.executeTool(user, 'manage_docker_container', { operation: 'gpu_usage', nodeId: 'node-2' })).error
    ).toContain('docker:containers:view');
  });

  it('sets deployment image cleanup with edit on the deployment and the REST retention bounds', async () => {
    const upsertForDeployment = vi.fn().mockResolvedValue({ enabled: true, retentionCount: 5 });
    container.registerInstance(DockerImageCleanupService, { upsertForDeployment } as never);
    container.registerInstance(DockerDeploymentService, {
      get: vi.fn().mockResolvedValue({ id: DEPLOYMENT_ID }),
    } as never);
    const service = createService();

    await expect(
      service.executeTool(userWith([`docker:containers:edit:node-1/${DEPLOYMENT_ID}`]), 'manage_docker_container', {
        operation: 'image_cleanup_upsert',
        nodeId: 'node-1',
        targetType: 'deployment',
        deploymentId: DEPLOYMENT_ID,
        retentionCount: 5,
      })
    ).resolves.toMatchObject({ result: { retentionCount: 5 } });
    expect(upsertForDeployment).toHaveBeenCalledWith('node-1', DEPLOYMENT_ID, { retentionCount: 5 });

    expect(
      (
        await service.executeTool(userWith(['docker:containers:edit']), 'manage_docker_container', {
          operation: 'image_cleanup_upsert',
          nodeId: 'node-1',
          targetType: 'deployment',
          deploymentId: DEPLOYMENT_ID,
          retentionCount: 51,
        })
      ).error
    ).toBeDefined();
    expect(
      (
        await service.executeTool(userWith(['docker:containers:view']), 'manage_docker_container', {
          operation: 'image_cleanup_upsert',
          nodeId: 'node-1',
          targetType: 'deployment',
          deploymentId: DEPLOYMENT_ID,
          enabled: false,
        })
      ).error
    ).toContain('docker:containers:edit');
    expect(upsertForDeployment).toHaveBeenCalledTimes(1);
  });

  it('plans an archive import behind the create scope and archive entitlement', async () => {
    const requireFeature = registerLicense();
    vi.mocked(planDockerContainerArchiveImport).mockResolvedValue({ conflictingPorts: [] } as never);
    const manifest = { networks: [], mounts: [], ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }] };

    await expect(
      createService().executeTool(userWith(['docker:containers:create:node-1']), 'manage_docker_container', {
        operation: 'archive_plan_import',
        nodeId: 'node-1',
        archiveManifest: manifest,
      })
    ).resolves.toMatchObject({ result: { conflictingPorts: [] } });
    expect(requireFeature).toHaveBeenCalledWith('container-export');
    expect(planDockerContainerArchiveImport).toHaveBeenCalledWith('node-1', manifest, [
      'docker:containers:create:node-1',
    ]);
  });
});

describe('Docker runtime, registry, and task parity', () => {
  it('installs runsc only with broad admin:update', async () => {
    const dockerService = { manageRunsc: vi.fn().mockResolvedValue({ state: 'installing' }) };
    const service = createService(dockerService);

    await expect(
      service.executeTool(userWith([`admin:update:${NODE_ID}`]), 'manage_docker_runtime', {
        operation: 'install',
        nodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('admin:update') });
    await expect(
      service.executeTool(userWith(['admin:update']), 'manage_docker_runtime', {
        operation: 'install',
        nodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ result: { state: 'installing' } });
    expect(dockerService.manageRunsc).toHaveBeenCalledTimes(1);
    expect(dockerService.manageRunsc).toHaveBeenCalledWith(NODE_ID, 'install');
  });

  it('runs internal registry garbage collection with the housekeeping retention', async () => {
    const runGarbageCollection = vi.fn().mockResolvedValue({ id: RUN_ID, status: 'running' });
    const updateSettings = vi.fn();
    container.registerInstance(DockerRegistryService, {} as never);
    container.registerInstance(DockerInternalRegistryService, { runGarbageCollection, updateSettings } as never);
    container.registerInstance(HousekeepingService, {
      getConfig: vi.fn().mockResolvedValue({ internalRegistry: { retentionSuccessfulArtifacts: 7 } }),
    } as never);
    const service = createService();

    await expect(
      service.executeTool(userWith(['docker:registries:view']), 'manage_docker_registry', { operation: 'internal_gc' })
    ).resolves.toMatchObject({ error: expect.stringContaining('docker:registries:edit') });
    await expect(
      service.executeTool(userWith(['docker:registries:edit']), 'manage_docker_registry', {
        operation: 'internal_gc',
        dryRun: true,
      })
    ).resolves.toMatchObject({ result: { id: RUN_ID } });
    expect(runGarbageCollection).toHaveBeenCalledWith({ dryRun: true, requestedById: 'user-1', retentionCount: 7 });

    const invalid = await service.executeTool(userWith(['docker:registries:edit']), 'manage_docker_registry', {
      operation: 'internal_update_settings',
      externalAccessEnabled: true,
    });
    expect(invalid.error).toBeDefined();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('lists internal registry repositories with registry view', async () => {
    const listInternalRegistryRepositories = vi.fn().mockResolvedValue(['builds/api']);
    container.registerInstance(DockerRegistryService, {} as never);
    container.registerInstance(DockerBuildService, { listInternalRegistryRepositories } as never);
    await expect(
      createService().executeTool(userWith(['docker:registries:view']), 'manage_docker_registry', {
        operation: 'internal_repositories',
      })
    ).resolves.toMatchObject({ result: ['builds/api'] });
  });

  it('narrows task lists and reads to the task nodes the caller holds', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const get = vi.fn().mockResolvedValue({ id: 'task-1', nodeId: OTHER_NODE_ID });
    container.registerInstance(DockerTaskService, { list, get } as never);
    const service = createService();
    const user = userWith([`docker:tasks:${NODE_ID}`]);

    await expect(service.executeTool(user, 'manage_docker_task', { operation: 'list' })).resolves.toMatchObject({
      result: [],
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ allowedNodeIds: [NODE_ID] }));
    await expect(
      service.executeTool(user, 'manage_docker_task', { operation: 'get', taskId: 'task-1' })
    ).resolves.toMatchObject({ error: expect.stringContaining(`docker:tasks:${OTHER_NODE_ID}`) });
  });
});

describe('manage_docker_volume file and metadata operations', () => {
  it('renames only with create and delete on a visible volume', async () => {
    const dockerService = { assertUserVolumeVisible: vi.fn(), renameVolume: vi.fn() };
    const service = createService(dockerService);

    await expect(
      service.executeTool(userWith(['docker:volumes:create:node-1/data']), 'manage_docker_volume', {
        operation: 'rename',
        nodeId: 'node-1',
        name: 'data',
        newName: 'data-2',
      })
    ).resolves.toMatchObject({ error: 'Missing required scope: docker:volumes:delete:node-1/data' });
    await expect(
      service.executeTool(
        userWith(['docker:volumes:create:node-1/data', 'docker:volumes:delete:node-1/data']),
        'manage_docker_volume',
        { operation: 'rename', nodeId: 'node-1', name: 'data', newName: 'data-2' }
      )
    ).resolves.toMatchObject({ result: { success: true } });
    expect(dockerService.renameVolume).toHaveBeenCalledTimes(1);
    expect(dockerService.renameVolume).toHaveBeenCalledWith('node-1', 'data', 'data-2', 'user-1');
  });

  it('reads binary volume files as base64 and writes binary uploads', async () => {
    const dockerService = {
      assertUserVolumeVisible: vi.fn(),
      readVolumeFile: vi.fn().mockResolvedValue(Buffer.from([0, 1, 2, 3])),
      appendVolumeFileUploadChunk: vi.fn().mockResolvedValue({ offset: 3 }),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool(userWith(['docker:volumes:files:read:node-1/data']), 'manage_docker_volume', {
        operation: 'read_file',
        nodeId: 'node-1',
        name: 'data',
        path: '/blob.bin',
        encoding: 'base64',
        offsetBytes: 1,
      })
    ).resolves.toMatchObject({ result: { encoding: 'base64', content: 'AQID', sizeBytes: 4, returnedBytes: 3 } });

    await expect(
      service.executeTool(userWith(['docker:volumes:files:read:node-1/data']), 'manage_docker_volume', {
        operation: 'upload_chunk',
        nodeId: 'node-1',
        name: 'data',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: 'AAEC',
      })
    ).resolves.toMatchObject({ error: 'Missing required scope: docker:volumes:files:write:node-1/data' });
    await expect(
      service.executeTool(userWith(['docker:volumes:files:write:node-1/data']), 'manage_docker_volume', {
        operation: 'upload_chunk',
        nodeId: 'node-1',
        name: 'data',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: 'AAEC',
      })
    ).resolves.toMatchObject({ result: { offset: 3 } });
    expect(dockerService.appendVolumeFileUploadChunk).toHaveBeenCalledWith(
      'node-1',
      'data',
      'upload-1',
      0,
      Buffer.from([0, 1, 2])
    );
  });
});

describe('manage_docker_container_config file operations', () => {
  it('moves container files with files:write and validates both paths', async () => {
    const dockerService = { inspectContainer: inspectedContainer(), moveFile: vi.fn() };
    const service = createService(dockerService);
    const user = userWith(['docker:containers:files:write:node-1']);

    await expect(
      service.executeTool(user, 'manage_docker_container_config', {
        operation: 'move_file',
        nodeId: 'node-1',
        containerId: 'container-1',
        fromPath: '/a.txt',
        toPath: '/b.txt',
      })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(dockerService.moveFile).toHaveBeenCalledWith('node-1', 'container-1', '/a.txt', '/b.txt', 'user-1');

    expect(
      (
        await service.executeTool(user, 'manage_docker_container_config', {
          operation: 'move_file',
          nodeId: 'node-1',
          containerId: 'container-1',
          fromPath: '/a.txt',
          toPath: '../b.txt',
        })
      ).error
    ).toBeDefined();
    expect(
      (
        await service.executeTool(userWith(['docker:containers:files:read']), 'manage_docker_container_config', {
          operation: 'delete_file',
          nodeId: 'node-1',
          containerId: 'container-1',
          path: '/a.txt',
        })
      ).error
    ).toContain('docker:containers:files:write');
    expect(dockerService.moveFile).toHaveBeenCalledTimes(1);
  });
});

describe('manage_docker_compose logs', () => {
  it('reads recent logs of every service container with Compose view', async () => {
    container.registerInstance(DockerComposeService, {
      get: vi.fn().mockResolvedValue({
        services: [
          { name: 'web', containerIds: ['c-web'] },
          { name: 'db', containerIds: ['c-db'] },
        ],
      }),
    } as never);
    const dockerService = { getContainerLogs: vi.fn().mockResolvedValue(['ready']) };

    await expect(
      createService(dockerService).executeTool(
        userWith(['docker:compose:view:node-1/project-1']),
        'manage_docker_compose',
        { operation: 'logs', nodeId: 'node-1', projectId: 'project-1', serviceName: 'web', tail: 20 }
      )
    ).resolves.toMatchObject({
      result: { projectId: 'project-1', services: [{ service: 'web', containerId: 'c-web', lines: ['ready'] }] },
    });
    expect(dockerService.getContainerLogs).toHaveBeenCalledWith('node-1', 'c-web', 20, false);
  });
});

describe('manage_docker_source parity', () => {
  it('creates a Git-source container through the shared route flow behind git-push-to-deploy', async () => {
    const requireFeature = registerLicense();
    vi.mocked(createDockerSourceResource).mockResolvedValue({ build: { id: 'build-1' } } as never);
    const user = userWith(['docker:containers:create:node-1']);

    await expect(
      createService().executeTool(user, 'manage_docker_source', {
        operation: 'create',
        targetType: 'container',
        nodeId: 'node-1',
        resourceName: 'api',
        connectorId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        branch: 'main',
      })
    ).resolves.toMatchObject({ result: { build: { id: 'build-1' } } });
    expect(requireFeature).toHaveBeenCalledWith('git-push-to-deploy');
    expect(createDockerSourceResource).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ resource: expect.objectContaining({ kind: 'container', name: 'api' }) }),
      user
    );
    expect(createComposeProjectFromSource).not.toHaveBeenCalled();
  });

  it('checks the Compose project node before touching a source', async () => {
    const get = vi.fn();
    container.registerInstance(DockerSourceService, { get } as never);
    vi.mocked(assertDockerSourceTargetOnNode).mockRejectedValueOnce(new Error('Compose project not found'));

    await expect(
      createService().executeTool(userWith(['docker:compose:view']), 'manage_docker_source', {
        operation: 'get',
        targetType: 'compose',
        nodeId: 'node-2',
        composeProjectId: 'project-1',
      })
    ).resolves.toMatchObject({ error: 'Compose project not found' });
    expect(assertDockerSourceTargetOnNode).toHaveBeenCalledWith('node-2', {
      kind: 'compose_project',
      composeProjectId: 'project-1',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('authorizes a pending source container through its persisted identity', async () => {
    const pending = { name: 'api', scopeResourceId: 'pending-1' };
    container.registerInstance(DockerSourceService, {
      getPendingContainer: vi.fn().mockResolvedValue(pending),
    } as never);
    const dockerService = { inspectContainer: vi.fn() };
    const service = createService(dockerService);

    await expect(
      service.executeTool(userWith(['docker:containers:view:node-1/pending-1']), 'manage_docker_source', {
        operation: 'pending',
        nodeId: 'node-1',
        containerName: 'api',
      })
    ).resolves.toMatchObject({ result: pending });
    await expect(
      service.executeTool(userWith(['docker:containers:view:node-1/other']), 'manage_docker_source', {
        operation: 'pending',
        nodeId: 'node-1',
        containerName: 'api',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('PERMISSION_DENIED') });
    expect(dockerService.inspectContainer).not.toHaveBeenCalled();
  });
});

describe('manage_docker_migration and manage_docker_availability', () => {
  it('resolves a needs_attention migration with docker:tasks:manage only', async () => {
    const resolve = vi.fn().mockResolvedValue({ id: MIGRATION_ID, status: 'completed' });
    const list = vi.fn().mockResolvedValue([]);
    container.registerInstance(DockerMigrationService, { resolve, list } as never);
    const service = createService();

    await expect(
      service.executeTool(userWith(['docker:tasks']), 'manage_docker_migration', {
        operation: 'resolve',
        migrationId: MIGRATION_ID,
        authoritativeSide: 'target',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('docker:tasks:manage') });
    await expect(
      service.executeTool(userWith([`docker:tasks:manage:${NODE_ID}`]), 'manage_docker_migration', {
        operation: 'resolve',
        migrationId: MIGRATION_ID,
        authoritativeSide: 'target',
      })
    ).resolves.toMatchObject({ result: { status: 'completed' } });
    expect(resolve).toHaveBeenCalledWith(MIGRATION_ID, { authoritativeSide: 'target' }, 'user-1', [
      `docker:tasks:manage:${NODE_ID}`,
    ]);

    await service.executeTool(userWith([`docker:tasks:${NODE_ID}`]), 'manage_docker_migration', {
      operation: 'list',
      status: 'needs_attention',
    });
    expect(list).toHaveBeenCalledWith([`docker:tasks:${NODE_ID}`], { status: 'needs_attention', limit: 50 });
  });

  it('enables availability only with docker:availability:manage and passes caller scopes', async () => {
    const enable = vi.fn().mockResolvedValue({ id: POLICY_ID });
    const preflight = vi.fn().mockResolvedValue({ eligible: true });
    container.registerInstance(DockerAvailabilityService, { enable, preflight } as never);
    const service = createService();
    const args = {
      resource: { type: 'deployment', deploymentId: DEPLOYMENT_ID },
      mode: 'replicated',
      desiredReplicaCount: 2,
      nodeSelectionMode: 'all_compatible',
    };

    await expect(
      service.executeTool(userWith(['docker:containers:view']), 'manage_docker_availability', {
        operation: 'preflight',
        ...args,
      })
    ).resolves.toMatchObject({ result: { eligible: true } });
    await expect(
      service.executeTool(userWith(['docker:containers:view']), 'manage_docker_availability', {
        operation: 'enable',
        ...args,
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('docker:availability:manage') });
    const scopes = ['docker:containers:view', `docker:availability:manage:node-1/${DEPLOYMENT_ID}`];
    await expect(
      service.executeTool(userWith(scopes), 'manage_docker_availability', { operation: 'enable', ...args })
    ).resolves.toMatchObject({ result: { id: POLICY_ID } });
    expect(enable).toHaveBeenCalledWith(
      expect.objectContaining({ resource: args.resource, mode: 'replicated', desiredReplicaCount: 2 }),
      'user-1',
      scopes
    );
    expect(
      (
        await service.executeTool(userWith(scopes), 'manage_docker_availability', {
          operation: 'enable',
          ...args,
          desiredReplicaCount: 1,
        })
      ).error
    ).toBeDefined();
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe('manage_pages route parity', () => {
  function registerPages(project: Record<string, unknown>) {
    registerLicense();
    container.registerInstance(PageProfileService, { requireEnabled: vi.fn() } as never);
    const projects = { get: vi.fn().mockResolvedValue(project), migrate: vi.fn().mockResolvedValue(project) };
    container.registerInstance(PageProjectService, projects as never);
    return projects;
  }

  it('requires pages:create for the target node before migrating a Project', async () => {
    const projects = registerPages({ id: PROJECT_ID, folderId: null });
    const service = createService();

    await expect(
      service.executeTool(userWith([`pages:edit:${PROJECT_ID}`]), 'manage_pages', {
        operation: 'project_migrate',
        projectId: PROJECT_ID,
        targetNodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ error: 'Missing pages:create permission for the target node' });
    expect(projects.migrate).not.toHaveBeenCalled();

    await expect(
      service.executeTool(userWith([`pages:edit:${PROJECT_ID}`, `pages:create:${NODE_ID}`]), 'manage_pages', {
        operation: 'project_migrate',
        projectId: PROJECT_ID,
        targetNodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ result: { id: PROJECT_ID } });
    expect(projects.migrate).toHaveBeenCalledWith(PROJECT_ID, { targetNodeId: NODE_ID }, 'user-1');
  });

  it('requires pages:deploy in addition to pages:edit to attach a Git source', async () => {
    registerPages({ id: PROJECT_ID });
    const upsert = vi.fn();
    container.registerInstance(DockerSourceService, { upsert } as never);

    await expect(
      createService().executeTool(userWith([`pages:edit:${PROJECT_ID}`]), 'manage_pages', {
        operation: 'source_upsert',
        projectId: PROJECT_ID,
      })
    ).resolves.toMatchObject({ error: `Missing required scope: pages:deploy:${PROJECT_ID}` });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('Docker archive transfer over MCP', () => {
  const archive = Buffer.from('gwca-archive-bytes');
  const sha256 = createHash('sha256').update(archive).digest('hex');

  it('is refused outside remote MCP', async () => {
    const result = await createService().executeTool(
      userWith(['docker:containers:create']),
      'upload_docker_container_archive',
      { operation: 'status', uploadId: 'upload-1' }
    );
    expect(result.error).toBe('Tool upload_docker_container_archive is available only through remote MCP');
  });

  it('spools a verified archive and imports it with the route checks re-run at finalize', async () => {
    const requireFeature = registerLicense();
    container.registerInstance(TOKENS.DrizzleClient, {} as never);
    let imported = Buffer.alloc(0);
    vi.mocked(importDockerContainerArchive).mockImplementation(async (args) => {
      const chunks: Buffer[] = [];
      for await (const chunk of args.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      imported = Buffer.concat(chunks);
      return { containerId: 'new-1', containerName: args.name, imageId: 'sha256:1' };
    });
    const service = createService();
    const user = userWith([`docker:containers:create:${NODE_ID}`, `docker:volumes:create:${NODE_ID}`]);
    const mcp = { source: 'mcp' as const, scopes: user.scopes };

    const begin = await service.executeTool(
      user,
      'upload_docker_container_archive',
      {
        operation: 'begin',
        nodeId: NODE_ID,
        name: 'restored-api',
        resolution: { ports: { '80/tcp': 8081 } },
        declaredSizeBytes: archive.byteLength,
        sha256,
      },
      mcp
    );
    const uploadId = (begin.result as { uploadId: string }).uploadId;
    expect(begin.result).toMatchObject({ status: 'open', offset: 0 });
    expect(assertNodeAllowsServiceCreation).toHaveBeenCalledWith(expect.anything(), NODE_ID, 'docker');

    await expect(
      service.executeTool(
        userWith(['docker:containers:create']),
        'upload_docker_container_archive',
        { operation: 'status', uploadId },
        { source: 'mcp', scopes: ['docker:containers:create'] }
      )
    ).resolves.toMatchObject({ result: { status: 'open' } });

    const mismatch = await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'chunk', uploadId, offset: 4, contentBase64: archive.subarray(0, 4).toString('base64') },
      mcp
    );
    expect(mismatch.error).toBe('Upload offset does not match');

    await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'chunk', uploadId, offset: 0, contentBase64: archive.subarray(0, 5).toString('base64') },
      mcp
    );
    await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'chunk', uploadId, offset: 5, contentBase64: archive.subarray(5).toString('base64') },
      mcp
    );
    const finalized = await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'finalize', uploadId },
      mcp
    );

    expect(finalized.result).toMatchObject({
      status: 'completed',
      container: { containerId: 'new-1', containerName: 'restored-api' },
    });
    expect(imported.equals(archive)).toBe(true);
    expect(importDockerContainerArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        name: 'restored-api',
        resolution: { ports: { '80/tcp': 8081 } },
        actorScopes: user.scopes,
        userId: 'user-1',
      })
    );
    expect(requireFeature).toHaveBeenCalledWith('container-export');
    expect(requireFeature).toHaveBeenCalledTimes(2);
  });

  it('rejects an archive whose SHA-256 does not match before importing', async () => {
    registerLicense();
    container.registerInstance(TOKENS.DrizzleClient, {} as never);
    const service = createService();
    const user = userWith(['docker:containers:create']);
    const mcp = { source: 'mcp' as const, scopes: user.scopes };
    const begin = await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'begin', nodeId: NODE_ID, name: 'api', declaredSizeBytes: 3, sha256: 'a'.repeat(64) },
      mcp
    );
    const uploadId = (begin.result as { uploadId: string }).uploadId;
    await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'chunk', uploadId, offset: 0, contentBase64: 'AAEC' },
      mcp
    );

    const result = await service.executeTool(
      user,
      'upload_docker_container_archive',
      { operation: 'finalize', uploadId },
      mcp
    );
    expect(result.error).toBe('Archive SHA-256 does not match');
    expect(importDockerContainerArchive).not.toHaveBeenCalled();
    await service.executeTool(user, 'upload_docker_container_archive', { operation: 'abort', uploadId }, mcp);
  });

  it('prepares a volume export, serves it in chunks to its owner, and deletes it on close', async () => {
    const volumeArchive = Buffer.from('volume-tar-gz');
    const dockerService = {
      assertUserVolumeVisible: vi.fn(),
      exportVolume: vi.fn().mockResolvedValue(volumeArchive),
    };
    const service = createService(dockerService);
    const user = userWith(['docker:volumes:export:node-1/data']);
    const mcp = { source: 'mcp' as const, scopes: user.scopes };

    const denied = await service.executeTool(
      userWith(['docker:volumes:export:node-1/other']),
      'download_docker_archive',
      { operation: 'begin', kind: 'volume', nodeId: 'node-1', volumeName: 'data' },
      { source: 'mcp', scopes: ['docker:volumes:export:node-1/other'] }
    );
    expect(denied.error).toBe('Missing required scope: docker:volumes:export:node-1/data');

    const begin = await service.executeTool(
      user,
      'download_docker_archive',
      { operation: 'begin', kind: 'volume', nodeId: 'node-1', volumeName: 'data' },
      mcp
    );
    const downloadId = (begin.result as { downloadId: string }).downloadId;
    expect(begin.result).toMatchObject({ filename: 'data.tar.gz' });
    expect(dockerService.assertUserVolumeVisible).toHaveBeenCalledWith('node-1', 'data');

    await vi.waitFor(async () => {
      const status = await service.executeTool(
        user,
        'download_docker_archive',
        { operation: 'status', downloadId },
        mcp
      );
      expect(status.result).toMatchObject({ status: 'ready', sizeBytes: volumeArchive.byteLength });
    });

    const stranger = await service.executeTool(
      { ...user, id: 'user-2' },
      'download_docker_archive',
      { operation: 'chunk', downloadId, offset: 0 },
      mcp
    );
    expect(stranger.error).toBe('Archive transfer session not found');

    const first = await service.executeTool(
      user,
      'download_docker_archive',
      { operation: 'chunk', downloadId, offset: 0, length: 6 },
      mcp
    );
    const second = await service.executeTool(
      user,
      'download_docker_archive',
      { operation: 'chunk', downloadId, offset: 6 },
      mcp
    );
    const bytes = Buffer.concat([
      Buffer.from((first.result as { contentBase64: string }).contentBase64, 'base64'),
      Buffer.from((second.result as { contentBase64: string }).contentBase64, 'base64'),
    ]);
    expect(bytes.equals(volumeArchive)).toBe(true);
    expect(second.result).toMatchObject({ eof: true, nextOffset: volumeArchive.byteLength });

    await expect(
      service.executeTool(user, 'download_docker_archive', { operation: 'close', downloadId }, mcp)
    ).resolves.toMatchObject({ result: { status: 'closed' } });
    const afterClose = await service.executeTool(
      user,
      'download_docker_archive',
      { operation: 'status', downloadId },
      mcp
    );
    expect(afterClose.error).toBe('Archive transfer session not found');
  });

  it('opens a container export with the export route checks', async () => {
    registerLicense();
    vi.mocked(openDockerContainerArchiveExport).mockResolvedValue({
      filename: 'api.gwca',
      stream: new Blob([Buffer.from('gwca')]).stream() as ReadableStream<Uint8Array>,
    });
    const service = createService({ inspectContainer: inspectedContainer() });
    const scopes = ['docker:containers:export:node-1/scope-1'];

    const begin = await service.executeTool(
      userWith(scopes),
      'download_docker_archive',
      {
        operation: 'begin',
        kind: 'container',
        nodeId: 'node-1',
        containerId: 'api',
        imageMode: 'registry',
        includeEnvironment: false,
      },
      { source: 'mcp', scopes }
    );
    expect(begin.result).toMatchObject({ filename: 'api.gwca', status: 'preparing' });
    expect(openDockerContainerArchiveExport).toHaveBeenCalledWith({
      nodeId: 'node-1',
      containerId: 'api',
      query: { imageMode: 'registry', includeWritableLayer: false, includeEnvironment: false, includeSecrets: false },
      actorScopes: scopes,
      userId: 'user-1',
    });
    await service.executeTool(
      userWith(scopes),
      'download_docker_archive',
      { operation: 'close', downloadId: (begin.result as { downloadId: string }).downloadId },
      { source: 'mcp', scopes }
    );
  });

  it('refuses a Compose container export before a transfer or spool exists', async () => {
    registerLicense();
    const composeContainer = inspectedContainer({
      Config: { Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'api' } },
    });
    const scopes = ['docker:containers:export:node-1/scope-1'];
    const args = {
      operation: 'begin',
      kind: 'container',
      nodeId: 'node-1',
      containerId: 'api',
      imageMode: 'registry',
      includeEnvironment: false,
    };

    const result = await createService({ inspectContainer: composeContainer }).executeTool(
      userWith(scopes),
      'download_docker_archive',
      args,
      { source: 'mcp', scopes }
    );
    expect(result.error).toBe(
      'This container belongs to Compose project shop and cannot be exported as a container archive; manage it through the Compose project instead'
    );

    const root = await mkdtemp(join(tmpdir(), 'gwca-compose-export-'));
    const store = new DockerArchiveTransferStore(join(root, 'spool'));
    try {
      await expect(
        store.download({ inspectContainer: composeContainer } as never, userWith(scopes), args)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'DOCKER_ARCHIVE_COMPOSE_CONTAINER',
        details: { nodeId: 'node-1', containerId: 'api', projectName: 'shop', projectId: null },
      });
      expect(existsSync(join(root, 'spool'))).toBe(false);
      expect((store as unknown as { downloads: Map<string, unknown> }).downloads.size).toBe(0);
    } finally {
      store.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(openDockerContainerArchiveExport).not.toHaveBeenCalled();
  });
});

describe('Docker credential and secret handling', () => {
  it('refuses a secret-bearing archive export while impersonating and redacts secret values from audit', () => {
    expect(
      isImpersonationBlockedToolCall('download_docker_archive', {
        operation: 'begin',
        kind: 'container',
        includeSecrets: true,
      })
    ).toBe(true);
    expect(isImpersonationBlockedToolCall('download_docker_archive', { operation: 'begin', kind: 'volume' })).toBe(
      false
    );
    expect(
      redactArgsForTool('manage_docker_compose', {
        operation: 'secret_create',
        key: 'TOKEN',
        value: 'super-secret',
      })
    ).toEqual({ operation: 'secret_create', key: 'TOKEN', value: '[REDACTED]' });
  });
});

describe('Docker archive transfer spool budget', () => {
  it('counts bytes already spooled for downloads against the shared disk budget', () => {
    const store = new DockerArchiveTransferStore() as any;
    const gib = 1024 ** 3;
    store.downloads.set('download-1', { id: 'download-1', userId: 'user-1', sizeBytes: 60 * gib });

    // A new upload reservation must fit next to the bytes downloads already wrote.
    expect(() => store.reserveSlot('user-2', 8 * gib)).toThrow('Too many archive transfers in progress');
    expect(() => store.reserveSlot('user-2', 2 * gib)).not.toThrow();
    // A download that keeps spooling fails once the budget is used up.
    expect(() => store.assertSpoolCapacity(5 * gib)).toThrow('archive transfer spool is full');

    store.downloads.get('download-1').sizeBytes = 64 * gib;
    expect(() => store.reserveSlot('user-2')).toThrow('Too many archive transfers in progress');
  });
});
