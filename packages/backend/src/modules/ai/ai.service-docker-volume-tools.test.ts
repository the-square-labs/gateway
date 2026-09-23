import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { assertComposeVolumeMutationAllowed } from '@/modules/docker/compose/compose-child.guard.js';
import { AIService } from './ai.service.js';

vi.mock('@/modules/docker/compose/compose-child.guard.js', () => ({
  assertComposeChildMutationAllowed: vi.fn().mockResolvedValue(undefined),
  assertComposeVolumeMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

const GIB = 1024 * 1024 * 1024;

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

function volumeService() {
  return {
    createVolume: vi.fn().mockResolvedValue({ Name: 'data' }),
    resizeVolume: vi.fn().mockResolvedValue(undefined),
    adoptVolume: vi.fn().mockResolvedValue({ name: 'legacy', managementState: 'managed' }),
    assertUserVolumeVisible: vi.fn().mockResolvedValue(undefined),
  };
}

describe('manage_docker_volume disk-image and adoption operations', () => {
  beforeEach(() => {
    vi.mocked(assertComposeVolumeMutationAllowed).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a disk-image volume through the REST create schema and creation access check', async () => {
    const dockerService = volumeService();

    await expect(
      createService(dockerService).executeTool(
        { ...BASE_USER, scopes: ['docker:volumes:create:node-1'] },
        'manage_docker_volume',
        { operation: 'create', nodeId: 'node-1', name: 'data', storageKind: 'disk-image', capacityBytes: GIB }
      )
    ).resolves.toMatchObject({ result: { Name: 'data' }, invalidateStores: ['volumes'] });
    expect(dockerService.createVolume).toHaveBeenCalledWith(
      'node-1',
      { name: 'data', storageKind: 'disk-image', capacityBytes: GIB },
      'user-1',
      ['docker:volumes:create:node-1']
    );
  });

  it('rejects a disk-image create without capacity before calling the service', async () => {
    const dockerService = volumeService();

    const result = await createService(dockerService).executeTool(
      { ...BASE_USER, scopes: ['docker:volumes:create'] },
      'manage_docker_volume',
      { operation: 'create', nodeId: 'node-1', name: 'data', storageKind: 'disk-image' }
    );

    expect(result.error).toContain('Capacity is required');
    expect(dockerService.createVolume).not.toHaveBeenCalled();
  });

  it('resizes a visible disk-image volume with the per-volume create scope', async () => {
    const dockerService = volumeService();

    await expect(
      createService(dockerService).executeTool(
        { ...BASE_USER, scopes: ['docker:volumes:create:node-1/data'] },
        'manage_docker_volume',
        { operation: 'resize', nodeId: 'node-1', name: 'data', capacityBytes: 2 * GIB }
      )
    ).resolves.toMatchObject({ result: { success: true }, invalidateStores: ['volumes'] });
    expect(dockerService.assertUserVolumeVisible).toHaveBeenCalledWith('node-1', 'data');
    expect(assertComposeVolumeMutationAllowed).toHaveBeenCalledWith('node-1', 'data');
    expect(dockerService.resizeVolume).toHaveBeenCalledWith('node-1', 'data', 2 * GIB, 'user-1');
  });

  it('denies resize outside the scoped volume before any visibility or service call', async () => {
    const dockerService = volumeService();

    const result = await createService(dockerService).executeTool(
      { ...BASE_USER, scopes: ['docker:volumes:create:node-1/other'] },
      'manage_docker_volume',
      { operation: 'resize', nodeId: 'node-1', name: 'data', capacityBytes: 2 * GIB }
    );

    expect(result.error).toBe('Missing required scope: docker:volumes:create:node-1/data');
    expect(dockerService.assertUserVolumeVisible).not.toHaveBeenCalled();
    expect(dockerService.resizeVolume).not.toHaveBeenCalled();
  });

  it('refuses to resize a volume hidden from the user volume list', async () => {
    const dockerService = volumeService();
    dockerService.assertUserVolumeVisible.mockRejectedValue(new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found'));

    const result = await createService(dockerService).executeTool(
      { ...BASE_USER, scopes: ['docker:volumes:create'] },
      'manage_docker_volume',
      { operation: 'resize', nodeId: 'node-1', name: 'gateway-internal', capacityBytes: 2 * GIB }
    );

    expect(result.error).toBe('Volume not found');
    expect(dockerService.resizeVolume).not.toHaveBeenCalled();
  });

  it('rejects a resize below the REST schema minimum', async () => {
    const dockerService = volumeService();

    const result = await createService(dockerService).executeTool(
      { ...BASE_USER, scopes: ['docker:volumes:create'] },
      'manage_docker_volume',
      { operation: 'resize', nodeId: 'node-1', name: 'data', capacityBytes: 1024 }
    );

    expect(result.error).toBeDefined();
    expect(dockerService.resizeVolume).not.toHaveBeenCalled();
  });

  it('adopts a legacy volume only with both create and view scopes', async () => {
    const dockerService = volumeService();
    const service = createService(dockerService);

    const denied = await service.executeTool(
      { ...BASE_USER, scopes: ['docker:volumes:create:node-1'] },
      'manage_docker_volume',
      { operation: 'adopt', nodeId: 'node-1', name: 'legacy' }
    );
    expect(denied.error).toBe('Missing required scope: docker:volumes:view:node-1/legacy');
    expect(dockerService.adoptVolume).not.toHaveBeenCalled();

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['docker:volumes:create:node-1', 'docker:volumes:view:node-1'] },
        'manage_docker_volume',
        { operation: 'adopt', nodeId: 'node-1', name: 'legacy' }
      )
    ).resolves.toMatchObject({ result: { name: 'legacy', managementState: 'managed' } });
    expect(assertComposeVolumeMutationAllowed).toHaveBeenCalledWith('node-1', 'legacy');
    expect(dockerService.adoptVolume).toHaveBeenCalledWith('node-1', 'legacy', 'user-1');
  });

  it('keeps Compose-owned volumes out of resize', async () => {
    const dockerService = volumeService();
    vi.mocked(assertComposeVolumeMutationAllowed).mockRejectedValue(
      new AppError(409, 'COMPOSE_RESOURCE_MANAGED', 'Change this volume through its Compose project')
    );

    const result = await createService(dockerService).executeTool(
      { ...BASE_USER, scopes: ['docker:volumes:create'] },
      'manage_docker_volume',
      { operation: 'resize', nodeId: 'node-1', name: 'db-data', capacityBytes: 2 * GIB }
    );

    expect(result.error).toBe('Change this volume through its Compose project');
    expect(dockerService.resizeVolume).not.toHaveBeenCalled();
  });
});
