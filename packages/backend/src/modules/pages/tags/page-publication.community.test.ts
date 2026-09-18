import { describe, expect, it, vi } from 'vitest';
import { PagePublicationService } from './page-publication.service.js';

describe('Community Pages publication boundary', () => {
  it('permits bootstrap wiring while denying publication without invoking adapters', async () => {
    const service = new PagePublicationService({} as never, {} as never, {} as never);
    const stage = vi.fn();
    const publish = vi.fn();
    expect(() => service.setEventBus({} as never)).not.toThrow();
    expect(() => service.setAdapter({ stage })).not.toThrow();
    expect(() => service.setDeploymentAdapter({ publish })).not.toThrow();
    await expect(service.markDeploymentReady('deployment-1')).rejects.toMatchObject({
      code: 'COMMERCIAL_MODULE_UNAVAILABLE',
    });
    await expect(service.moveUserTag('project-1', 'latest', 'deployment-1', 'user-1')).rejects.toMatchObject({
      code: 'COMMERCIAL_MODULE_UNAVAILABLE',
    });
    expect(stage).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
