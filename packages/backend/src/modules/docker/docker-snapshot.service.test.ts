import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const envelope = (data: unknown, observedAt: string) => ({
  data,
  revision: 1,
  observedAt,
  lastAttemptAt: observedAt,
  lastError: null,
  refreshStatus: 'success',
});

function snapshots(list: unknown, details: Record<string, unknown>) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ id: NODE, type: 'docker' }],
  };
  const cache = {
    get: async () => list,
    getClient: () => ({
      hget: async (_key: string, field: string) =>
        details[field] === undefined ? null : JSON.stringify(details[field]),
    }),
  };
  return new DockerSnapshotService({ select: () => chain } as never, cache as never, {} as never, {} as never);
}

describe('container detail snapshot after a recreate', () => {
  it('answers with the inspect refreshed under the name while the list still names the replaced runtime', async () => {
    const service = snapshots(envelope([{ id: 'old-runtime', name: 'api' }], '2026-10-01T20:00:00.000Z'), {
      api: envelope({ Id: 'new-runtime', Name: '/api' }, '2026-10-01T20:00:05.000Z'),
    });

    await expect(service.getContainerDetail(NODE, 'api')).resolves.toMatchObject({ Id: 'new-runtime' });
  });

  it('follows the list to the new runtime when the inspect under the name is the older one', async () => {
    const service = snapshots(envelope([{ id: 'new-runtime', name: 'api' }], '2026-10-01T20:00:05.000Z'), {
      api: envelope({ Id: 'old-runtime', Name: '/api' }, '2026-10-01T20:00:00.000Z'),
      'new-runtime': envelope({ Id: 'new-runtime', Name: '/api' }, '2026-10-01T20:00:06.000Z'),
    });

    await expect(service.getContainerDetail(NODE, 'api')).resolves.toMatchObject({ Id: 'new-runtime' });
  });

  it('answers 404 for a removed container whose inspect is still cached', async () => {
    const service = snapshots(envelope([{ id: 'other', name: 'web' }], '2026-10-01T21:51:00.000Z'), {
      api: envelope(
        { Id: 'removed-runtime', Name: '/api', State: { Status: 'restarting' } },
        '2026-10-01T20:44:00.000Z'
      ),
    });

    await expect(service.getContainerDetail(NODE, 'api')).rejects.toMatchObject({
      statusCode: 404,
      code: 'CONTAINER_NOT_FOUND',
    });
  });

  it('answers with the inspect of a container created after the list was read', async () => {
    const service = snapshots(envelope([{ id: 'other', name: 'web' }], '2026-10-01T20:00:00.000Z'), {
      api: envelope({ Id: 'new-container', Name: '/api' }, '2026-10-01T20:00:02.000Z'),
    });

    await expect(service.getContainerDetail(NODE, 'api')).resolves.toMatchObject({ Id: 'new-container' });
  });
});
