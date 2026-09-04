import { describe, expect, it, vi } from 'vitest';
import {
  DockerAccessResourceService,
  dockerScopedNodeIds,
  parseDockerChildScopeResourceId,
  rewriteDockerResourceScopes,
} from './docker-access-resource.service.js';

describe('Docker access resource scopes', () => {
  it('parses child resource ids and derives their owning nodes', () => {
    expect(parseDockerChildScopeResourceId('node-1/resource-1')).toEqual({
      nodeId: 'node-1',
      resourceId: 'resource-1',
    });
    expect(parseDockerChildScopeResourceId('node-1')).toBeNull();
    expect(
      dockerScopedNodeIds(
        [
          'docker:containers:view:node-1/resource-1',
          'docker:containers:view:node-2',
          'docker:containers:edit:node-3/resource-3',
        ],
        ['docker:containers:view']
      )
    ).toEqual(['node-1', 'node-2', 'node-3']);
  });

  it('moves every matching Docker container permission while preserving unrelated scopes', () => {
    expect(
      rewriteDockerResourceScopes(
        [
          'docker:containers:view:node-1/resource-1',
          'docker:containers:edit:node-1/resource-1',
          'docker:containers:view:node-1/resource-2',
          'docker:images:view:node-1/resource-1',
          'proxy:view:host-1',
        ],
        'node-1/resource-1',
        'node-2/resource-1'
      )
    ).toEqual([
      'docker:containers:edit:node-2/resource-1',
      'docker:containers:view:node-1/resource-2',
      'docker:containers:view:node-2/resource-1',
      'docker:images:view:node-1/resource-1',
      'proxy:view:host-1',
    ]);
  });

  it('removes grants when the underlying resource is deleted', () => {
    expect(
      rewriteDockerResourceScopes(
        ['docker:containers:view:node-1/resource-1', 'docker:containers:view:node-1/resource-2'],
        'node-1/resource-1',
        null
      )
    ).toEqual(['docker:containers:view:node-1/resource-2']);
  });
});

describe('Pending container access identity lifecycle', () => {
  function harness(runtimeId: string) {
    const row = { id: 'stable-resource', nodeId: 'node-1', resourceKey: 'api', runtimeId };
    const db: any = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values) => ({
          where: vi.fn(async () => {
            Object.assign(row, values);
          }),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      transaction: vi.fn(async (callback) => callback(db)),
    };
    const service = new DockerAccessResourceService(db);
    const rewrite = vi.spyOn(service as any, 'rewritePersistedScopes').mockResolvedValue(undefined);
    return { row, db, service, rewrite };
  }

  it('adopts the first real runtime without changing the pending resource ID or grants', async () => {
    const { service, row, rewrite, db } = harness('');
    expect(await service.ensureContainer('node-1', 'api', 'runtime-1')).toBe('stable-resource');
    expect(row.runtimeId).toBe('runtime-1');
    expect(rewrite).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('keeps an empty-runtime reservation and its grants across empty snapshot reconciliation', async () => {
    const { service, row, db, rewrite } = harness('');
    db.select.mockReturnValue({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([row]) })) });
    expect(await service.syncContainers('node-1', [])).toEqual(new Map([['api', 'stable-resource']]));
    expect(await service.syncContainers('node-1', [])).toEqual(new Map([['api', 'stable-resource']]));
    expect(await service.syncContainers('node-1', [{ id: 'source-1', name: 'api', pendingSourceBuild: true }])).toEqual(
      new Map([['api', 'stable-resource']])
    );
    expect(row.runtimeId).toBe('');
    expect(service.cachedContainerResourceId('node-1', { name: 'api' })).toBe('stable-resource');
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('does not let a pending reservation replace a runtime identity', async () => {
    const { service, rewrite, db } = harness('runtime-1');
    await expect(service.ensureContainer('node-1', 'api', '', false, db)).rejects.toMatchObject({
      code: 'CONTAINER_NAME_CONFLICT',
    });
    expect(rewrite).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('removes empty pending identity and its scoped grants on Disconnect', async () => {
    const { service, rewrite, db } = harness('');
    expect(await service.removePendingContainer('node-1', 'api', db)).toBe('stable-resource');
    expect(rewrite).toHaveBeenCalledWith(db, 'node-1/stable-resource', null);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it('never removes identity/grants once the first runtime has adopted them', async () => {
    const { service, rewrite, db } = harness('runtime-1');
    expect(await service.removePendingContainer('node-1', 'api', db)).toBeNull();
    expect(rewrite).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});
