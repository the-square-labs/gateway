import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { DockerDeploymentService } from './docker-deployment.service.js';

function subject(deploy: ReturnType<typeof vi.fn>) {
  const updates: Array<Record<string, unknown>> = [];
  const predicates: Array<{ sql: string; params: unknown[] }> = [];
  const state = {
    desiredConfig: {
      image: 'registry/orders:1',
      env: { KEEP: 'old', DATABASE_URL: 'legacy' },
      networks: ['app'],
    } as Record<string, unknown>,
  };
  const service = Object.create(DockerDeploymentService.prototype) as {
    db: { update: ReturnType<typeof vi.fn> };
    validateDockerNode: ReturnType<typeof vi.fn>;
    loadDeployment: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    deploy: ReturnType<typeof vi.fn>;
    setManagedDatabaseBindingNetwork: DockerDeploymentService['setManagedDatabaseBindingNetwork'];
    setManagedStorageBindingNetwork: DockerDeploymentService['setManagedStorageBindingNetwork'];
  };
  service.db = {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: vi.fn(async (predicate: SQL) => {
            const query = new PgDialect().sqlToQuery(predicate);
            predicates.push(query);
            // Model the database equality guard using its compiled bind value.
            const expected = query.params[1];
            if (expected === undefined || JSON.stringify(state.desiredConfig) === expected) {
              state.desiredConfig = values.desiredConfig as Record<string, unknown>;
            }
          }),
        };
      }),
    })),
  };
  service.validateDockerNode = vi.fn().mockResolvedValue(undefined);
  service.loadDeployment = vi.fn().mockResolvedValue({
    id: 'deployment-1',
    desiredConfig: state.desiredConfig,
  });
  service.emit = vi.fn();
  service.deploy = deploy;
  return { service, updates, state, predicates };
}

describe('managed deployment binding Environment saves', () => {
  it.each([
    ['database', 'gateway-db-binding-1', 'setManagedDatabaseBindingNetwork'],
    ['storage', 'gateway-storage-1234567890abcdef', 'setManagedStorageBindingNetwork'],
  ] as const)('applies the final ordinary draft for a %s link', async (_kind, networkName, method) => {
    const deploy = vi.fn().mockResolvedValue({ id: 'deployment-1' });
    const { service, updates } = subject(deploy);

    if (method === 'setManagedDatabaseBindingNetwork') {
      await service.setManagedDatabaseBindingNetwork('node-1', 'deployment-1', networkName, true, 'user-1', false, {
        KEEP: 'new',
      });
    } else {
      await service.setManagedStorageBindingNetwork('node-1', 'deployment-1', networkName, true, 'user-1', {
        KEEP: 'new',
      });
    }

    expect(updates).toEqual([
      expect.objectContaining({
        desiredConfig: expect.objectContaining({
          env: { KEEP: 'new' },
          networks: expect.arrayContaining([networkName]),
        }),
      }),
    ]);
  });

  it('restores the prior database deployment Environment when its binding rollout fails', async () => {
    const { service, updates } = subject(vi.fn().mockRejectedValue(new Error('rollout failed')));

    await expect(
      service.setManagedDatabaseBindingNetwork(
        'node-1',
        'deployment-1',
        'gateway-db-binding-1',
        true,
        'user-1',
        false,
        {
          KEEP: 'new',
        }
      )
    ).rejects.toThrow('rollout failed');

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      desiredConfig: expect.objectContaining({ env: { KEEP: 'new' }, networks: ['app', 'gateway-db-binding-1'] }),
    });
    expect(updates[1]).toMatchObject({
      desiredConfig: { image: 'registry/orders:1', env: { KEEP: 'old', DATABASE_URL: 'legacy' }, networks: ['app'] },
    });
  });

  it('does not overwrite a concurrent config save when the binding rollout fails', async () => {
    let fail!: (error: Error) => void;
    const deploy = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    );
    const { service, state, predicates } = subject(deploy);
    const pending = service.setManagedDatabaseBindingNetwork(
      'node-1',
      'deployment-1',
      'gateway-db-binding-1',
      true,
      'user-1',
      false,
      { KEEP: 'new' }
    );
    const rejected = expect(pending).rejects.toThrow('rollout failed');
    await vi.waitFor(() => expect(deploy).toHaveBeenCalled());
    const candidate = state.desiredConfig;
    const concurrent = { ...candidate, env: { KEEP: 'concurrent-user-save' } };
    state.desiredConfig = concurrent;
    fail(new Error('rollout failed'));
    await rejected;
    expect(predicates[1].sql).toContain('"desired_config" = $2');
    expect(predicates[1].params[1]).toBe(JSON.stringify(candidate));
    expect(state.desiredConfig).toEqual(concurrent);
  });
});
