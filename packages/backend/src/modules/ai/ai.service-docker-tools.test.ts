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

function createService(dockerService: Record<string, unknown>) {
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

describe('AIService Docker tool routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a canonical container name for reference-only console results', async () => {
    const dockerService = {
      inspectContainer: vi.fn().mockResolvedValue({
        Id: '527b02985e9b37cf9252b29f01de321f',
        Name: '/ai-e2e-restart',
      }),
    };
    const service = createService(dockerService);

    const references = await (
      service as unknown as {
        toolResourceReferences(
          toolName: string,
          args: Record<string, unknown>,
          result: unknown
        ): Promise<Array<{ type: string; label: string }>>;
      }
    ).toolResourceReferences(
      'execute_docker_container_console_command',
      {
        nodeId: 'node-1',
        containerId: '527b02985e9b37cf9252b29f01de321f',
      },
      { stdout: 'ok' }
    );

    expect(references[0]).toMatchObject({
      type: 'docker_container',
      label: 'ai-e2e-restart',
    });
    expect(dockerService.inspectContainer).toHaveBeenCalledWith('node-1', '527b02985e9b37cf9252b29f01de321f');
  });

  it('creates, attaches additional networks, starts, and returns canonical Docker identity', async () => {
    const dockerService = {
      createContainer: vi.fn().mockResolvedValue({ Id: 'container-1', id: 'container-1', name: 'generated-name' }),
      connectContainerToNetwork: vi.fn().mockResolvedValue(undefined),
      startContainer: vi.fn().mockResolvedValue(undefined),
      inspectContainer: vi.fn().mockResolvedValue({ Name: '/generated-name', State: { Status: 'running' } }),
      rollbackCreatedContainer: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dockerService);
    const user = {
      ...BASE_USER,
      scopes: ['docker:containers:create:node-1', 'docker:networks:edit:node-1'],
    };

    await expect(
      service.executeTool(user, 'create_docker_container', {
        nodeId: 'node-1',
        image: 'nginx:alpine',
        env: { APP_ENV: 'stage' },
        volumes: [{ name: 'cache', containerPath: '/cache' }],
        networks: ['frontend', 'metrics'],
        command: ['nginx', '-g', 'daemon off;'],
      })
    ).resolves.toMatchObject({
      result: {
        success: true,
        message: 'Container created and started',
        data: { id: 'container-1', name: 'generated-name', state: 'running' },
      },
      invalidateStores: ['containers'],
    });
    expect(dockerService.connectContainerToNetwork).toHaveBeenCalledWith('node-1', 'metrics', 'container-1', 'user-1');
    expect(dockerService.startContainer).toHaveBeenCalledWith('node-1', 'container-1', 'user-1');
    expect(dockerService.rollbackCreatedContainer).not.toHaveBeenCalled();
  });

  it('removes a newly created container when assistant start orchestration fails', async () => {
    const dockerService = {
      createContainer: vi.fn().mockResolvedValue({ id: 'container-1', name: 'generated-name' }),
      connectContainerToNetwork: vi.fn().mockResolvedValue(undefined),
      startContainer: vi.fn().mockRejectedValue(new Error('start failed')),
      inspectContainer: vi.fn(),
      rollbackCreatedContainer: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:containers:create:node-1'] }, 'create_docker_container', {
        nodeId: 'node-1',
        image: 'nginx:alpine',
      })
    ).resolves.toMatchObject({ error: 'start failed' });
    expect(dockerService.rollbackCreatedContainer).toHaveBeenCalledWith(
      'node-1',
      'container-1',
      'generated-name',
      'user-1'
    );
  });

  it('force-rolls back a running container when post-start identity inspection fails', async () => {
    const dockerService = {
      createContainer: vi.fn().mockResolvedValue({ id: 'container-1', name: 'generated-name' }),
      connectContainerToNetwork: vi.fn().mockResolvedValue(undefined),
      startContainer: vi.fn().mockResolvedValue(undefined),
      inspectContainer: vi.fn().mockRejectedValue(new Error('inspect failed')),
      rollbackCreatedContainer: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:containers:create:node-1'] }, 'create_docker_container', {
        nodeId: 'node-1',
        image: 'nginx:alpine',
      })
    ).resolves.toMatchObject({ error: 'inspect failed' });
    expect(dockerService.startContainer).toHaveBeenCalled();
    expect(dockerService.rollbackCreatedContainer).toHaveBeenCalledWith(
      'node-1',
      'container-1',
      'generated-name',
      'user-1'
    );
  });

  it('returns the lifecycle task identity for asynchronous stop operations', async () => {
    const dockerService = {
      inspectContainer: vi.fn().mockResolvedValue({ scopeResourceId: 'scope-1' }),
      stopContainer: vi.fn().mockResolvedValue({ taskId: 'task-1', containerId: 'container-1', name: 'api' }),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:containers:manage:node-1'] }, 'stop_docker_container', {
        nodeId: 'node-1',
        containerId: 'container-1',
      })
    ).resolves.toMatchObject({
      result: {
        success: true,
        message: 'Container stopping',
        data: { taskId: 'task-1', containerId: 'container-1', name: 'api' },
      },
    });
  });

  it('requires source view, environment, and secret scopes before duplication', async () => {
    const dockerService = {
      inspectContainer: vi.fn(),
      duplicateContainer: vi.fn(),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool(
        {
          ...BASE_USER,
          scopes: [
            'docker:containers:create:node-1',
            'docker:containers:view:node-1',
            'docker:containers:environment:node-1',
          ],
        },
        'duplicate_docker_container',
        { nodeId: 'node-1', containerId: 'container-1', name: 'copy' }
      )
    ).resolves.toMatchObject({ error: expect.stringContaining('docker:containers:create') });
    expect(dockerService.inspectContainer).not.toHaveBeenCalled();
    expect(dockerService.duplicateContainer).not.toHaveBeenCalled();
  });

  it('lists Docker containers with search filtering and compact agent payloads', async () => {
    const dockerService = {
      listContainers: vi.fn().mockResolvedValue([
        {
          Id: 'container-1',
          Name: '/api',
          Image: 'registry.example.com/team/api:latest',
          State: 'running',
          Status: 'Up 1 hour',
          Ports: [{ privatePort: 3000, publicPort: 8080, type: 'tcp' }],
        },
        {
          Id: 'container-2',
          Name: '/worker',
          Image: 'registry.example.com/team/worker:latest',
          State: 'exited',
          Status: 'Exited',
          Ports: [],
        },
      ]),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:containers:view:node-1'] }, 'list_docker_containers', {
        nodeId: 'node-1',
        search: 'api',
      })
    ).resolves.toEqual({
      result: {
        data: [
          {
            id: 'container-1',
            name: 'api',
            image: 'registry.example.com/team/api:latest',
            state: 'running',
            status: 'Up 1 hour',
            created: undefined,
            ports: [{ privatePort: 3000, publicPort: 8080, type: 'tcp' }],
            portsCount: 1,
            portsTruncated: false,
            kind: 'container',
            deploymentId: undefined,
            activeSlot: undefined,
            healthCheckId: undefined,
            healthCheckEnabled: undefined,
            healthStatus: undefined,
            lastHealthCheckAt: undefined,
            folderId: undefined,
            folderIsSystem: undefined,
            folderSortOrder: undefined,
            _transition: undefined,
          },
        ],
        total: 1,
        limit: 1000,
        truncated: false,
      },
      invalidateStores: [],
    });
    expect(dockerService.listContainers).toHaveBeenCalledWith('node-1');
  });

  it('pulls Docker images with resolved registry auth and registry host prefixing', async () => {
    const dockerService = {
      pullImage: vi.fn().mockResolvedValue({ taskId: 'task-1' }),
    };
    const registryService = {
      resolveAuthForImagePull: vi.fn().mockResolvedValue({
        url: 'registry.example.com',
        authJson: { username: 'robot', password: 'secret' },
        registryId: '11111111-1111-4111-8111-111111111111',
      }),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(registryService as never);
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:images:pull:node-1'] }, 'pull_docker_image', {
        nodeId: 'node-1',
        imageRef: 'team/api:next',
        registryId: '11111111-1111-4111-8111-111111111111',
      })
    ).resolves.toEqual({
      result: {
        success: true,
        message: 'Pulling registry.example.com/team/api:next',
        data: { taskId: 'task-1' },
      },
      invalidateStores: ['images'],
    });
    expect(registryService.resolveAuthForImagePull).toHaveBeenCalledWith(
      'node-1',
      'team/api:next',
      '11111111-1111-4111-8111-111111111111',
      { actorScopes: ['docker:images:pull:node-1'] }
    );
    expect(dockerService.pullImage).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/api:next',
      { username: 'robot', password: 'secret' },
      'user-1',
      '11111111-1111-4111-8111-111111111111'
    );
  });

  it('pulls public Docker Hub images when the model sends an empty optional registryId', async () => {
    const dockerService = {
      pullImage: vi.fn().mockResolvedValue({ taskId: 'task-public' }),
    };
    const registryService = {
      resolveAuthForImagePull: vi.fn().mockResolvedValue(null),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(registryService as never);
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:images:pull:node-1'] }, 'pull_docker_image', {
        nodeId: 'node-1',
        imageRef: 'nginx:alpine',
        registryId: '',
      })
    ).resolves.toEqual({
      result: {
        success: true,
        message: 'Pulling nginx:alpine',
        data: { taskId: 'task-public' },
      },
      invalidateStores: ['images'],
    });
    expect(registryService.resolveAuthForImagePull).toHaveBeenCalledWith('node-1', 'nginx:alpine', undefined, {
      actorScopes: ['docker:images:pull:node-1'],
    });
    expect(dockerService.pullImage).toHaveBeenCalledWith('node-1', 'nginx:alpine', undefined, 'user-1', undefined);
  });

  it('refuses to create an unauthenticated saved registry for public Docker Hub', async () => {
    const registryService = { create: vi.fn() };
    vi.spyOn(container, 'resolve').mockReturnValue(registryService as never);
    const service = createService({});

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['docker:registries:view', 'docker:registries:create'] },
        'manage_docker_registry',
        {
          operation: 'create',
          name: 'Docker Hub',
          url: 'https://registry-1.docker.io',
          username: '',
          password: '',
          scope: 'global',
          nodeId: '',
        }
      )
    ).resolves.toMatchObject({ error: expect.stringContaining('PUBLIC_DOCKER_HUB_REGISTRY_NOT_REQUIRED') });
    expect(registryService.create).not.toHaveBeenCalled();
  });

  it('enforces registry-scoped authorization against the requested registry identity', async () => {
    const registryService = { get: vi.fn() };
    vi.spyOn(container, 'resolve').mockReturnValue(registryService as never);
    const service = createService({});

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:registries:view:registry-1'] }, 'manage_docker_registry', {
        operation: 'get',
        registryId: 'registry-2',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('PERMISSION_DENIED') });
    expect(registryService.get).not.toHaveBeenCalled();
  });

  it('routes Docker volume create and delete with operation-specific node scopes', async () => {
    const dockerService = {
      createVolume: vi.fn().mockResolvedValue({ Name: 'cache' }),
      removeVolume: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:volumes:create:node-1'] }, 'manage_docker_volume', {
        operation: 'create',
        nodeId: 'node-1',
        name: 'cache',
      })
    ).resolves.toMatchObject({
      result: { Name: 'cache' },
      invalidateStores: [],
    });
    expect(dockerService.createVolume).toHaveBeenCalledWith('node-1', { name: 'cache' }, 'user-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:volumes:delete:node-1'] }, 'manage_docker_volume', {
        operation: 'delete',
        nodeId: 'node-1',
        name: 'cache',
        force: true,
      })
    ).resolves.toMatchObject({
      result: { success: true },
      invalidateStores: [],
    });
    expect(dockerService.removeVolume).toHaveBeenCalledWith('node-1', 'cache', true, 'user-1');
  });

  it('routes Docker network connect through edit scope and parsed container payload', async () => {
    const dockerService = {
      connectContainerToNetwork: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dockerService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:networks:edit:node-1'] }, 'manage_docker_network', {
        operation: 'connect',
        nodeId: 'node-1',
        networkId: 'frontend',
        containerId: 'container-1',
      })
    ).resolves.toMatchObject({
      result: { success: true },
      invalidateStores: [],
    });
    expect(dockerService.connectContainerToNetwork).toHaveBeenCalledWith('node-1', 'frontend', 'container-1', 'user-1');
  });

  it('routes deployment lifecycle actions through the deployment service resolver', async () => {
    const deploymentService = {
      start: vi.fn().mockResolvedValue({ id: 'deployment-1', status: 'starting' }),
    };
    vi.spyOn(container, 'resolve').mockReturnValue(deploymentService as never);
    const service = createService({});

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['docker:containers:manage:node-1'] }, 'start_docker_deployment', {
        nodeId: 'node-1',
        deploymentId: 'deployment-1',
      })
    ).resolves.toMatchObject({
      result: {
        success: true,
        message: 'Deployment started',
        data: { id: 'deployment-1', status: 'starting' },
      },
      invalidateStores: ['containers'],
    });
    expect(deploymentService.start).toHaveBeenCalledWith('node-1', 'deployment-1', 'user-1');
  });
});
