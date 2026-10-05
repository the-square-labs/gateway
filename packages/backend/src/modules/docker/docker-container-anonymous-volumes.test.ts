import { describe, expect, it, vi } from 'vitest';
import { dockerManagedVolumes } from '@/db/schema/index.js';
import { DockerManagementService } from './docker.service.js';
import { DOCKER_MANAGED_VOLUME_LABEL } from './docker-managed-volume.constants.js';
import { removeOrphanedAnonymousVolume } from './docker-volume-network-operations.js';

const anonymous = 'a'.repeat(64);
const shared = 'b'.repeat(64);
const adopted = 'c'.repeat(64);
const labelled = 'd'.repeat(64);

/** The volume the code inspected last: a per-name managed lookup always follows its inspect. */
let lastInspected = '';

/**
 * Node lookups return the online docker node. A per-name managed-volume lookup (`.limit(1)`) answers for the volume
 * inspected last; the per-node lookup returns every managed name.
 */
function dbWithOnlineDockerNode(managedNames: string[] = []) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      if (table === dockerManagedVolumes) {
        const rows = managedNames.map((volumeName) => ({ volumeName }));
        const limit = vi.fn(async () => rows.filter((row) => row.volumeName === lastInspected));
        return { where: vi.fn(() => Object.assign(Promise.resolve(rows), { limit })) };
      }
      const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
      const routeWhere = vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) }));
      return { where: vi.fn(() => ({ limit })), innerJoin: vi.fn(() => ({ where: routeWhere })) };
    }),
  }));
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  return { select, delete: vi.fn(() => ({ where: deleteWhere })) };
}

function volumeDispatch(mounts: Array<Record<string, unknown>>, usedBy: Record<string, string[]> = {}) {
  const inspect = {
    success: true,
    detail: JSON.stringify({ Name: '/api', State: { Status: 'exited' }, Config: { Labels: {} }, Mounts: mounts }),
  };
  return {
    sendDockerContainerCommand: vi.fn(async (_node: string, action: string) =>
      action === 'remove' ? { success: true } : inspect
    ),
    sendDockerVolumeCommand: vi.fn(async (_node: string, action: string, options: { name: string }) => {
      if (action === 'inspect') lastInspected = options.name;
      return action === 'inspect'
        ? {
            success: true,
            detail: JSON.stringify({
              Name: options.name,
              UsedBy: usedBy[options.name] ?? [],
              Labels: options.name === labelled ? { [DOCKER_MANAGED_VOLUME_LABEL]: 'true' } : {},
            }),
          }
        : { success: true };
    }),
  };
}

function service(dispatch: ReturnType<typeof volumeDispatch>, managedNames: string[] = []) {
  return new DockerManagementService(
    dbWithOnlineDockerNode(managedNames) as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
}

describe('DockerManagementService.removeContainer anonymous volumes', () => {
  it('removes the anonymous volumes of the removed container and keeps named and shared ones', async () => {
    const dispatch = volumeDispatch(
      [
        { Type: 'volume', Name: anonymous, Destination: '/var/lib/data' },
        { Type: 'volume', Name: shared, Destination: '/cache' },
        { Type: 'volume', Name: 'api-uploads', Destination: '/uploads' },
        { Type: 'bind', Source: '/srv/config', Destination: '/config' },
      ],
      { [shared]: ['other'] }
    );

    await service(dispatch).removeContainer('node-1', 'container-1', false, 'user-1');

    const removed = dispatch.sendDockerVolumeCommand.mock.calls.filter(([, action]) => action === 'remove');
    expect(removed).toEqual([['node-1', 'remove', { name: anonymous, force: false }]]);
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalledWith('node-1', 'inspect', { name: 'api-uploads' });
  });

  it('keeps an adopted or Gateway-labelled anonymous volume', async () => {
    const dispatch = volumeDispatch([
      { Type: 'volume', Name: anonymous, Destination: '/tmp-data' },
      { Type: 'volume', Name: adopted, Destination: '/var/lib/postgresql/data' },
      { Type: 'volume', Name: labelled, Destination: '/images' },
    ]);

    await service(dispatch, [adopted]).removeContainer('node-1', 'container-1', false, 'user-1');

    const removed = dispatch.sendDockerVolumeCommand.mock.calls.filter(([, action]) => action === 'remove');
    expect(removed).toEqual([['node-1', 'remove', { name: anonymous, force: false }]]);
  });
});

describe('housekeeping of orphaned anonymous volumes', () => {
  it('leaves managed volumes out of the housekeeping inventory', async () => {
    const dispatch = volumeDispatch([]);
    dispatch.sendDockerVolumeCommand.mockImplementation(async (_node: string, action: string) =>
      action === 'list'
        ? {
            success: true,
            detail: JSON.stringify([
              { Name: anonymous, Labels: {} },
              { Name: adopted, Labels: {} },
              { Name: labelled, Labels: { [DOCKER_MANAGED_VOLUME_LABEL]: 'true' } },
            ]),
          }
        : { success: true }
    );

    const volumes = await service(dispatch, [adopted]).listHousekeepingVolumes('node-1');

    expect(volumes.map((volume: { Name: string }) => volume.Name)).toEqual([anonymous]);
  });

  it('refuses to remove an adopted anonymous volume', async () => {
    const dispatch = volumeDispatch([]);
    lastInspected = '';
    const remove = removeOrphanedAnonymousVolume(
      {
        db: dbWithOnlineDockerNode([adopted]) as never,
        nodeDispatch: dispatch as never,
        auditService: { log: vi.fn() } as never,
        parseResult: (result: { detail?: string }) => (result.detail ? JSON.parse(result.detail) : undefined),
      },
      'node-1',
      adopted,
      null
    );

    await expect(remove).rejects.toMatchObject({ code: 'VOLUME_MANAGED' });
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalledWith('node-1', 'remove', expect.anything());
  });

  it('refuses to remove a Gateway-labelled anonymous volume', async () => {
    const dispatch = volumeDispatch([]);
    lastInspected = '';
    const remove = removeOrphanedAnonymousVolume(
      {
        db: dbWithOnlineDockerNode() as never,
        nodeDispatch: dispatch as never,
        auditService: { log: vi.fn() } as never,
        parseResult: (result: { detail?: string }) => (result.detail ? JSON.parse(result.detail) : undefined),
      },
      'node-1',
      labelled,
      null
    );

    await expect(remove).rejects.toMatchObject({ code: 'VOLUME_MANAGED' });
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalledWith('node-1', 'remove', expect.anything());
  });
});
