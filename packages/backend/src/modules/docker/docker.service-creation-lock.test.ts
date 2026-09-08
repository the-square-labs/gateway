import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function dbWithLockedDockerNode() {
  const limit = vi.fn().mockResolvedValue([
    {
      id: 'node-1',
      type: 'docker',
      serviceCreationLocked: true,
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function createDockerService(db: any, dispatch: any) {
  return new DockerManagementService(db, { log: vi.fn().mockResolvedValue(undefined) } as never, dispatch, {
    getNode: vi.fn().mockReturnValue({ id: 'node-1' }),
  } as never);
}

describe('DockerManagementService service creation lock', () => {
  it('rejects container creation on a locked Docker node before dispatching', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const service = createDockerService(dbWithLockedDockerNode(), dispatch);

    await expect(
      service.createContainer('node-1', { name: 'app', image: 'nginx:latest' }, 'user-1', ['docker:containers:create'])
    ).rejects.toMatchObject({ statusCode: 409, code: 'NODE_SERVICE_CREATION_LOCKED' });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('rejects container duplication on a locked Docker node before dispatching', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const service = createDockerService(dbWithLockedDockerNode(), dispatch);

    await expect(
      service.duplicateContainer('node-1', 'container-1', 'app-copy', 'user-1', ['docker:containers:create'])
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NODE_SERVICE_CREATION_LOCKED',
    });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });
});
