import { describe, expect, it, vi } from 'vitest';
import { kill } from './docker-deployment-operations.js';

describe('deployment emergency kill', () => {
  it('bypasses the deployment idle guard and sends the kill command', async () => {
    const deployment = {
      id: 'deployment-1',
      nodeId: 'node-1',
      name: 'app',
      status: 'updating',
      activeSlot: 'blue',
      slots: [{ slot: 'blue', containerId: 'container-1', image: 'app:latest' }],
    };
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const transaction = vi.fn(async (fn: (tx: { update: typeof update }) => Promise<void>) => fn({ update }));
    const sendDockerDeploymentCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const ctx = {
      db: { transaction },
      audit: { log: vi.fn().mockResolvedValue(undefined) },
      dispatch: { sendDockerDeploymentCommand },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      loadDeployment: vi.fn().mockResolvedValue(deployment),
      requireDeploymentIdle: vi.fn(() => {
        throw new Error('must not run');
      }),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      parseResult: vi.fn(),
      emit: vi.fn(),
    };

    await kill(ctx as never, 'node-1', 'deployment-1', 'user-1');

    expect(ctx.requireDeploymentIdle).not.toHaveBeenCalled();
    expect(sendDockerDeploymentCommand).toHaveBeenCalledWith('node-1', 'kill', {
      deploymentId: 'deployment-1',
      configJson: JSON.stringify({ deployment }),
    });
  });
});
