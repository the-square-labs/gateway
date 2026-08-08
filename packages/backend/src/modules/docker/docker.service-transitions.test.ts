import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function createService() {
  return new DockerManagementService(
    {} as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    { getNode: vi.fn() } as never
  );
}

describe('DockerManagementService container transitions', () => {
  it('blocks actions for a container name while a transition is active', () => {
    const service = createService();

    service.setTransition('node-1', 'api', 'recreating');

    expect(() => service.requireNoTransition('node-1', 'api')).toThrow('Container is currently recreating');
  });

  it('uses migrating as a global busy transition', () => {
    const service = createService();

    service.setTransition('node-1', 'api', 'migrating');

    expect(() => service.requireNoTransition('node-1', 'api')).toThrow('Container is currently migrating');
  });

  it('allows actions again after clearing the matching transition', () => {
    const service = createService();

    service.setTransition('node-1', 'api', 'updating');
    service.clearTransition('node-1', 'api');

    expect(() => service.requireNoTransition('node-1', 'api')).not.toThrow();
  });

  it('keeps transition state isolated by node and container name', () => {
    const service = createService();

    service.setTransition('node-1', 'api', 'stopping');

    expect(() => service.requireNoTransition('node-2', 'api')).not.toThrow();
    expect(() => service.requireNoTransition('node-1', 'worker')).not.toThrow();
  });

  it('removes a stale transition from a cached detail after it is cleared', async () => {
    const service = createService();
    const detail = { Name: '/api', _transition: 'migrating' };

    await service.decorateContainerDetailSnapshot('node-1', detail);

    expect(detail).toEqual({ Name: '/api', gpuAttachment: { mode: 'none', deviceIds: [] } });
  });
});
