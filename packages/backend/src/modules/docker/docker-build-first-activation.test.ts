import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';
import { DockerBuildRolloutService } from './docker-build-rollout.service.js';
import { startContainer } from './docker-container-mutation-operations.js';

describe('first source activation through container creation and startup', () => {
  it('uses current folder permissions, preserves reservation identity, dispatches create/start and verifies readiness', async () => {
    const image = `127.0.0.1:5443/gateway/builds/app@sha256:${'a'.repeat(64)}`;
    const scopes = ['docker:containers:create:folder/folder-1'];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'folder-1',
                isSystem: false,
                type: 'docker',
                serviceCreationLocked: false,
              },
            ],
          }),
        }),
      }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })) })),
    };
    let created = false;
    let running = false;
    const dispatch = vi.fn(async (_node: string, action: string) => {
      if (action === 'create') {
        created = true;
        return { id: 'runtime-1' };
      }
      if (action === 'start') {
        running = true;
        return {};
      }
      throw new Error(`unexpected action ${action}`);
    });
    const accessResourceService = {
      resolveContainer: vi.fn().mockResolvedValue('reservation-1'),
      ensureContainer: vi.fn().mockResolvedValue('reservation-1'),
    };
    const ctx = {
      db,
      nodeDispatch: { sendDockerContainerCommand: dispatch },
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      accessResourceService,
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('app'),
      requireNoTransition: vi.fn(),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      parseResult: (result: unknown) => result,
    };
    const docker = {
      db,
      containerMutationContext: () => ctx,
      listAllContainers: vi.fn(async () => (created ? [{ id: 'runtime-1', name: 'app' }] : [])),
      pullImageImmediate: vi.fn().mockResolvedValue(undefined),
      createContainer: DockerManagementService.prototype.createContainer,
      startContainer: (_node: string, id: string, actor: string) => startContainer(ctx as never, _node, id, actor),
      getContainerTransition: () => undefined,
      inspectContainer: vi.fn(async () => ({
        Config: { Image: image },
        State: { Running: running, Health: { Status: 'healthy' } },
      })),
    };
    const service = new DockerBuildRolloutService(
      db as never,
      docker as never,
      {} as never,
      { ensureBinding: vi.fn().mockResolvedValue(undefined) } as never,
      undefined,
      { getUserById: vi.fn().mockResolvedValue({ id: 'actor', scopes, isBlocked: false }) }
    );
    await expect(
      (service as any).deployTarget(
        {
          targetKind: 'container',
          nodeId: 'node-1',
          containerName: 'app',
          initialConfig: { folderId: 'folder-1', runtimeProfile: 'default', restartPolicy: 'unless-stopped' },
        },
        image,
        'actor'
      )
    ).resolves.toBe('container:node-1:app');
    expect(dispatch.mock.calls.map((call) => call[1])).toEqual(['create', 'start']);
    expect(accessResourceService.ensureContainer).toHaveBeenCalledWith('node-1', 'app', 'runtime-1', false);
    expect(db.insert).toHaveBeenCalled();
    expect(docker.inspectContainer).toHaveBeenCalledWith('node-1', 'runtime-1');
    expect(running).toBe(true);
  });
});
