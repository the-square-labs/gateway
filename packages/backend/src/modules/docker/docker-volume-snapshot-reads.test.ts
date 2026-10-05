import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerManagementService } from './docker.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { inspectDockerVolumeSnapshot } from './docker-volume-snapshot-reads.js';

const hidden = 'a'.repeat(64);

describe('inspectDockerVolumeSnapshot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers 404 for a hidden volume instead of an unrelated managed one', async () => {
    const snapshots = {
      getDetail: vi.fn().mockResolvedValue({ data: { Name: hidden, Driver: 'local', UsedBy: [] } }),
      getList: vi.fn().mockResolvedValue({ data: [] }),
      availability: vi.fn().mockReturnValue('available'),
    };
    const management = {
      // A hidden volume is filtered out, and the managed rows not given are appended.
      decoratePublicVolumeSnapshot: vi.fn().mockResolvedValue([{ Name: 'codex-discord-agent-data' }]),
    };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) =>
      token === DockerSnapshotService
        ? snapshots
        : token === DockerManagementService
          ? management
          : undefined) as never);

    await expect(inspectDockerVolumeSnapshot('node-1', hidden)).rejects.toMatchObject({ status: 404 });
  });

  it('returns the requested volume when it is listed after other managed rows', async () => {
    const snapshots = {
      getDetail: vi.fn().mockResolvedValue({ data: { Name: 'app-data' } }),
      getList: vi.fn().mockResolvedValue({ data: [] }),
      availability: vi.fn().mockReturnValue('available'),
    };
    const management = {
      decoratePublicVolumeSnapshot: vi.fn().mockResolvedValue([{ Name: 'other-data' }, { Name: 'app-data' }]),
    };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) =>
      token === DockerSnapshotService
        ? snapshots
        : token === DockerManagementService
          ? management
          : undefined) as never);

    await expect(inspectDockerVolumeSnapshot('node-1', 'app-data')).resolves.toMatchObject({ name: 'app-data' });
  });
});
