import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

const anonymous = 'a'.repeat(64);
const shared = 'b'.repeat(64);

function dbWithOnlineDockerNode() {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
  const routeLimit = vi.fn().mockResolvedValue([]);
  const routeWhere = vi.fn(() => ({ limit: routeLimit }));
  const innerJoin = vi.fn(() => ({ where: routeWhere }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where, innerJoin }));
  const select = vi.fn(() => ({ from }));
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  return { select, delete: vi.fn(() => ({ where: deleteWhere })) };
}

describe('DockerManagementService.removeContainer anonymous volumes', () => {
  it('removes the anonymous volumes of the removed container and keeps named and shared ones', async () => {
    const inspect = {
      success: true,
      detail: JSON.stringify({
        Name: '/api',
        State: { Status: 'exited' },
        Config: { Labels: {} },
        Mounts: [
          { Type: 'volume', Name: anonymous, Destination: '/var/lib/data' },
          { Type: 'volume', Name: shared, Destination: '/cache' },
          { Type: 'volume', Name: 'api-uploads', Destination: '/uploads' },
          { Type: 'bind', Source: '/srv/config', Destination: '/config' },
        ],
      }),
    };
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_node: string, action: string) =>
        action === 'remove' ? { success: true } : inspect
      ),
      sendDockerVolumeCommand: vi.fn(async (_node: string, action: string, options: { name: string }) =>
        action === 'inspect'
          ? {
              success: true,
              detail: JSON.stringify({ Name: options.name, UsedBy: options.name === shared ? ['other'] : [] }),
            }
          : { success: true }
      ),
    };
    const service = new DockerManagementService(
      dbWithOnlineDockerNode() as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      dispatch as never,
      { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
    );

    await service.removeContainer('node-1', 'container-1', false, 'user-1');

    const removed = dispatch.sendDockerVolumeCommand.mock.calls.filter(([, action]) => action === 'remove');
    expect(removed).toEqual([['node-1', 'remove', { name: anonymous, force: false }]]);
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalledWith('node-1', 'inspect', { name: 'api-uploads' });
  });
});
