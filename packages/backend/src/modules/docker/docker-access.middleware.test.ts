import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
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

  it('never falls back to persisted identity for a Gateway-owned internal container', async () => {
    const inspect = vi.fn().mockRejectedValue(new AppError(404, 'GATEWAY_INTERNAL_CONTAINER', 'Container not found'));
    const resolvePersisted = vi.fn().mockResolvedValue('resource-1');

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => true,
        resolvePersisted,
      })
    ).rejects.toMatchObject({ code: 'GATEWAY_INTERNAL_CONTAINER' });
    expect(resolvePersisted).not.toHaveBeenCalled();
  });
});
