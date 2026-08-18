import { describe, expect, it, vi } from 'vitest';
import { resolveDockerContainerScopeResourceId } from './docker-access.middleware.js';

describe('Docker container emergency scope identity', () => {
  it('uses persisted identity only while the stable name has an active transition', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('container temporarily absent'));
    const resolvePersisted = vi.fn().mockResolvedValue('resource-1');

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => true,
        resolvePersisted,
      })
    ).resolves.toBe('resource-1');
    expect(resolvePersisted).toHaveBeenCalledOnce();
  });

  it('does not trust persisted identity when no transition is active', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('container absent'));
    const resolvePersisted = vi.fn();

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => false,
        resolvePersisted,
      })
    ).rejects.toThrow('container absent');
    expect(resolvePersisted).not.toHaveBeenCalled();
  });
});
