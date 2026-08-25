import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { EventBusService } from '@/services/event-bus.service.js';
import { DockerSnapshotService, sanitizeContainerInspect, sanitizeVolumeSnapshot } from './docker-snapshot.service.js';

class MemoryCache {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  hashes = new Map<string, Map<string, string>>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.strings.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }
  async set<T>(key: string, value: T) {
    this.strings.set(key, JSON.stringify(value));
  }
  async sadd(key: string, ...values: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    values.forEach((value) => {
      set.add(value);
    });
    this.sets.set(key, set);
    return values.length;
  }
  async srem(key: string, ...values: string[]) {
    values.forEach((value) => {
      this.sets.get(key)?.delete(value);
    });
    return values.length;
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  getClient() {
    return {
      hget: async (key: string, field: string) => this.hashes.get(key)?.get(field) ?? null,
      hset: async (key: string, field: string, value: string) => {
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        hash.set(field, value);
        this.hashes.set(key, hash);
        return 1;
      },
      hkeys: async (key: string) => [...(this.hashes.get(key)?.keys() ?? [])],
      hdel: async (key: string, ...fields: string[]) => {
        const hash = this.hashes.get(key);
        fields.forEach((field) => {
          hash?.delete(field);
        });
        return fields.length;
      },
      del: async (...keys: string[]) => {
        keys.forEach((key) => {
          this.strings.delete(key);
          this.hashes.delete(key);
        });
        return keys.length;
      },
    };
  }
}

function createService(connected = true) {
  const cache = new MemoryCache();
  const registry = { getNode: vi.fn(() => (connected ? { nodeId: 'node-1' } : undefined)) };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]),
        })),
      })),
    })),
  };
  const service = new DockerSnapshotService(db as never, cache as never, registry as never, new EventBusService());
  return { service, cache, registry };
}

describe('DockerSnapshotService', () => {
  it('preserves last-known data and revision when a refresh fails', async () => {
    const { service } = createService();
    const success = await service.replaceList('node-1', 'containers', [{ id: 'c1', state: 'running' }]);
    expect(service.availability('node-1', success)).toBe('available');

    await service.markListError('node-1', 'containers', new Error('timeout'));
    const failed = await service.getList('node-1', 'containers');

    expect(failed.data).toEqual([{ id: 'c1', state: 'running' }]);
    expect(failed.revision).toBe(1);
    expect(failed.lastError).toBe('timeout');
    expect(service.availability('node-1', failed)).toBe('unavailable');
  });

  it('stays available while refreshing a previously successful snapshot', async () => {
    const { service } = createService();
    await service.replaceList('node-1', 'images', [{ id: 'i1' }]);
    await service.markListRefreshing('node-1', 'images');
    const refreshing = await service.getList('node-1', 'images');
    expect(refreshing.refreshStatus).toBe('refreshing');
    expect(service.availability('node-1', refreshing)).toBe('available');
  });

  it('marks a preserved snapshot unavailable when the node disconnects', async () => {
    const { service, registry } = createService();
    const snapshot = await service.replaceList('node-1', 'volumes', [{ name: 'data' }]);
    registry.getNode.mockReturnValue(undefined);
    expect(service.availability('node-1', snapshot)).toBe('unavailable');
    expect(snapshot.data).toEqual([{ name: 'data', driver: '', mountpoint: '', scope: '', usedBy: [] }]);
  });

  it('removes environment values and credential-shaped fields from container inspect snapshots', () => {
    expect(
      sanitizeContainerInspect({
        Id: 'c1',
        Config: { Env: ['API_KEY=value'], Labels: { app: 'demo' }, Password: 'hidden' },
        HostConfig: { RegistryAuth: 'hidden', Nested: { access_token: 'hidden', safe: true } },
      })
    ).toEqual({
      Id: 'c1',
      Config: { Labels: { app: 'demo' } },
      HostConfig: { Nested: { safe: true } },
    });
  });

  it('allowlists volume DTO fields and removes Docker options, status, usage data, and secret labels', () => {
    expect(
      sanitizeVolumeSnapshot({
        Name: 'data',
        Driver: 'local',
        Mountpoint: '/var/lib/docker/volumes/data',
        Labels: {
          app: 'gateway',
          password: 'hidden',
          'registry.auth-token': 'hidden',
        },
        Scope: 'local',
        CreatedAt: '2026-07-17T10:00:00Z',
        UsedBy: ['web', 123],
        Options: { device: '/secret', password: 'hidden' },
        Status: { token: 'hidden' },
        UsageData: { Size: 1024 },
      })
    ).toEqual({
      name: 'data',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/data',
      labels: { app: 'gateway' },
      scope: 'local',
      createdAt: '2026-07-17T10:00:00Z',
      usedBy: ['web'],
    });
  });

  it('sanitizes volume lists and details before writing them to Redis', async () => {
    const { service } = createService();
    const raw = {
      Name: 'data',
      Driver: 'local',
      Mountpoint: '/mnt/data',
      Labels: { app: 'gateway', secret_key: 'hidden' },
      Scope: 'local',
      UsedBy: ['web'],
      Options: { password: 'hidden' },
      Status: { token: 'hidden' },
    };

    await service.replaceList('node-1', 'volumes', [raw]);
    await service.replaceDetail('node-1', 'volume-detail', 'data', raw);

    expect((await service.getList<any[]>('node-1', 'volumes')).data[0]).toEqual({
      name: 'data',
      driver: 'local',
      mountpoint: '/mnt/data',
      labels: { app: 'gateway' },
      scope: 'local',
      usedBy: ['web'],
    });
    expect((await service.getDetail<any>('node-1', 'volume-detail', 'data'))?.data).toEqual({
      name: 'data',
      driver: 'local',
      mountpoint: '/mnt/data',
      labels: { app: 'gateway' },
      scope: 'local',
      usedBy: ['web'],
    });
  });

  it('removes stale volume details when the refreshed physical inventory no longer contains them', async () => {
    const { service } = createService();
    await service.replaceDetail('node-1', 'volume-detail', 'deleted-data', {
      Name: 'deleted-data',
      Driver: 'local',
    });

    await service.replaceList('node-1', 'volumes', []);

    await expect(service.getDetail('node-1', 'volume-detail', 'deleted-data')).resolves.toBeNull();
  });

  it('does not resolve a replaced container name to a stale detail snapshot', async () => {
    const { service } = createService();
    await service.replaceList('node-1', 'containers', [{ id: 'new-id', name: 'api' }]);
    await service.replaceDetail('node-1', 'container-detail', 'api', {
      Id: 'old-id',
      Name: '/api',
    });
    await service.replaceDetail('node-1', 'container-detail', 'new-id', {
      Id: 'new-id',
      Name: '/api',
    });

    await expect(service.getContainerDetailSnapshot('node-1', 'api')).resolves.toMatchObject({
      data: { Id: 'new-id', Name: '/api' },
    });
  });

  it('does not recreate snapshot keys after a node tombstone and purge', async () => {
    const { service } = createService();
    await service.replaceList('node-1', 'containers', [{ id: 'before-delete' }]);
    await service.purgeNode('node-1');
    await service.replaceList('node-1', 'containers', [{ id: 'late-result' }]);
    await service.replaceDetail('node-1', 'container-detail', 'late-result', { Id: 'late-result' });

    expect((await service.getList('node-1', 'containers')).data).toEqual([]);
    expect(await service.getDetail('node-1', 'container-detail', 'late-result')).toBeNull();
  });
});
