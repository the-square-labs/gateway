import { describe, expect, it, vi } from 'vitest';
import { DockerImageCleanupService } from './docker-image-cleanup.service.js';

describe('DockerImageCleanupService', () => {
  it('removes old image versions after manual or webhook updates', async () => {
    vi.useFakeTimers();
    try {
      const docker = {
        listImages: vi.fn().mockResolvedValue([
          {
            Id: 'sha-new',
            RepoTags: ['registry.example.com/team/app:new'],
            Created: 300,
          },
          {
            Id: 'sha-previous',
            RepoTags: ['registry.example.com/team/app:previous'],
            Created: 200,
          },
          {
            Id: 'sha-old',
            RepoTags: ['registry.example.com/team/app:old'],
            Created: 100,
          },
        ]),
        listAllContainers: vi.fn().mockResolvedValue([{ ImageID: 'sha-new' }]),
        removeImage: vi.fn().mockResolvedValue(undefined),
      };
      const service = new DockerImageCleanupService({} as never, docker as never);
      vi.spyOn(service, 'getForContainer').mockResolvedValue({
        id: null,
        nodeId: 'node-1',
        targetType: 'container',
        containerName: 'app',
        deploymentId: null,
        enabled: true,
        retentionCount: 2,
        createdAt: null,
        updatedAt: null,
      });

      const cleanup = service.scheduleCleanupForContainer('node-1', 'app', 'registry.example.com/team/app:new');
      await vi.advanceTimersByTimeAsync(5000);
      await cleanup;

      expect(docker.removeImage).toHaveBeenCalledWith('node-1', 'sha-old', false, 'system');
      expect(docker.removeImage).not.toHaveBeenCalledWith('node-1', 'sha-previous', false, 'system');
      expect(docker.removeImage).not.toHaveBeenCalledWith('node-1', 'sha-new', false, 'system');
    } finally {
      vi.useRealTimers();
    }
  });
});
