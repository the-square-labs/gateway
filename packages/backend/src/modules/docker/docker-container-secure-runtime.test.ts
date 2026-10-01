import { describe, expect, it, vi } from 'vitest';
import { type DockerContainerMutationContext, recreateWithConfig } from './docker-container-mutation-operations.js';

function context(runtime: string) {
  const dispatch = vi.fn().mockResolvedValue({ success: true });
  const ctx = {
    db: {},
    nodeDispatch: { sendDockerContainerCommand: dispatch },
    validateDockerNode: vi.fn().mockResolvedValue({}),
    assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
    assertDockerGpuCapability: vi.fn().mockResolvedValue(undefined),
    assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
    resolveContainerName: vi.fn().mockResolvedValue('sec1'),
    resolveExpectedRecreateState: vi.fn().mockResolvedValue('running'),
    requireNoTransition: vi.fn(),
    setTransition: vi.fn(),
    runtimeOperationContext: () => ({}),
    inspectContainer: vi.fn().mockResolvedValue({
      Id: 'a'.repeat(64),
      Name: '/sec1',
      Config: { Labels: {} },
      HostConfig: { Runtime: runtime, NetworkMode: 'bridge' },
    }),
  } as unknown as DockerContainerMutationContext;
  return { ctx, dispatch };
}

describe('recreate of a Secure Runtime container', () => {
  it('refuses a GPU when the request keeps the runtime profile', async () => {
    const { ctx, dispatch } = context('runsc');

    await expect(
      recreateWithConfig(ctx, 'node-1', 'sec1', { gpu: { deviceIds: ['0'] } }, 'user-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'SECURE_RUNTIME_GPU_UNSUPPORTED' });

    expect(ctx.setTransition).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
