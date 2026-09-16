import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
import type { User } from '@/types.js';
import { executeStorageTool } from './ai.storage-tools.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const USER: User = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [],
  isBlocked: false,
};

afterEach(() => container.reset());

describe('managed storage AI tool', () => {
  it('lists only managed storage rows authorized by canonical storage connection scope', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 'managed-1', objectStorageConnectionId: 'storage-1' },
      { id: 'managed-2', objectStorageConnectionId: 'storage-2' },
    ]);
    container.registerInstance(ManagedStorageService, { list } as unknown as ManagedStorageService);

    await expect(
      executeStorageTool({ ...USER, scopes: ['storage:view:storage-1'] }, 'manage_managed_storage', {
        action: 'list',
      })
    ).resolves.toEqual([{ id: 'managed-1', objectStorageConnectionId: 'storage-1' }]);

    expect(list).toHaveBeenCalledWith({});
  });

  it('dispatches managed storage lifecycle operations through the existing service', async () => {
    const service = {
      getCanonicalScopeResourceId: vi.fn().mockResolvedValue('storage-1'),
      update: vi.fn().mockResolvedValue({ id: 'managed-1', name: 'new-name' }),
      retryProvisioning: vi.fn().mockResolvedValue({ id: 'managed-1', status: 'creating' }),
      restart: vi.fn().mockResolvedValue({ id: 'managed-1', status: 'updating' }),
      delete: vi.fn().mockResolvedValue({ id: 'managed-1', status: 'deleting' }),
    };
    container.registerInstance(ManagedStorageService, service as unknown as ManagedStorageService);

    await expect(
      executeStorageTool({ ...USER, scopes: ['storage:edit:storage-1'] }, 'manage_managed_storage', {
        action: 'update',
        managedStorageId: 'managed-1',
        config: { name: 'new-name' },
      })
    ).resolves.toMatchObject({ id: 'managed-1', name: 'new-name' });
    await expect(
      executeStorageTool({ ...USER, scopes: ['storage:edit:storage-1'] }, 'manage_managed_storage', {
        action: 'retry',
        managedStorageId: 'managed-1',
      })
    ).resolves.toMatchObject({ status: 'creating' });
    await expect(
      executeStorageTool({ ...USER, scopes: ['storage:edit:storage-1'] }, 'manage_managed_storage', {
        action: 'restart',
        managedStorageId: 'managed-1',
      })
    ).resolves.toMatchObject({ status: 'updating' });
    await expect(
      executeStorageTool({ ...USER, scopes: ['storage:delete:storage-1'] }, 'manage_managed_storage', {
        action: 'delete',
        managedStorageId: 'managed-1',
      })
    ).resolves.toMatchObject({ status: 'deleting' });

    expect(service.update).toHaveBeenCalledWith('managed-1', { name: 'new-name' }, 'user-1');
    expect(service.retryProvisioning).toHaveBeenCalledWith('managed-1', 'user-1');
    expect(service.restart).toHaveBeenCalledWith('managed-1', 'user-1');
    expect(service.delete).toHaveBeenCalledWith('managed-1', 'user-1');
  });

  it('exposes scoped IAM key lifecycle without returning secrets from the list action', async () => {
    const service = {
      getCanonicalScopeResourceId: vi.fn().mockResolvedValue('storage-1'),
      listAccessKeys: vi
        .fn()
        .mockResolvedValue([{ accessKeyId: 'key-1', name: 'CI', access: 'read-only', buckets: ['uploads'] }]),
      createAccessKey: vi.fn().mockResolvedValue({ accessKeyId: 'key-2', secretAccessKey: 'shown-once' }),
      removeAccessKey: vi.fn().mockResolvedValue({ success: true }),
    };
    container.registerInstance(ManagedStorageService, service as unknown as ManagedStorageService);
    const user = { ...USER, scopes: ['storage:view:storage-1', 'storage:iam:storage-1'] };

    const listed = await executeStorageTool(user, 'manage_managed_storage', {
      action: 'list_access_keys',
      managedStorageId: 'managed-1',
    });
    await expect(
      executeStorageTool(user, 'manage_managed_storage', {
        action: 'create_access_key',
        managedStorageId: 'managed-1',
        config: { name: 'CI', access: 'read-only', buckets: ['uploads'] },
      })
    ).resolves.toEqual({ accessKeyId: 'key-2', secretAccessKey: 'shown-once' });
    await expect(
      executeStorageTool(user, 'manage_managed_storage', {
        action: 'remove_access_key',
        managedStorageId: 'managed-1',
        accessKeyId: 'key-2',
      })
    ).resolves.toEqual({ success: true });

    expect(listed).toEqual([{ accessKeyId: 'key-1', name: 'CI', access: 'read-only', buckets: ['uploads'] }]);
    expect(listed).not.toHaveProperty('secretAccessKey');
    expect(service.createAccessKey).toHaveBeenCalledWith(
      'managed-1',
      { name: 'CI', access: 'read-only', buckets: ['uploads'] },
      'user-1'
    );
    expect(service.removeAccessKey).toHaveBeenCalledWith('managed-1', 'key-2', 'user-1');
  });

  it('requires storage IAM before creating or removing scoped access keys', async () => {
    const service = {
      getCanonicalScopeResourceId: vi.fn().mockResolvedValue('storage-1'),
      createAccessKey: vi.fn(),
      removeAccessKey: vi.fn(),
    };
    container.registerInstance(ManagedStorageService, service as unknown as ManagedStorageService);
    const user = { ...USER, scopes: ['storage:view:storage-1'] };

    await expect(
      executeStorageTool(user, 'manage_managed_storage', {
        action: 'create_access_key',
        managedStorageId: 'managed-1',
        config: { name: 'CI' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      executeStorageTool(user, 'manage_managed_storage', {
        action: 'remove_access_key',
        managedStorageId: 'managed-1',
        accessKeyId: 'key-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(service.createAccessKey).not.toHaveBeenCalled();
    expect(service.removeAccessKey).not.toHaveBeenCalled();
  });

  it('creates and removes bucket-scoped links only with storage IAM and target workload access', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue('storage-1');
    const create = vi.fn().mockResolvedValue({ id: 'binding-1', status: 'ready' });
    const getTarget = vi
      .fn()
      .mockResolvedValue({ targetNodeId: NODE_ID, targetType: 'container', targetResourceId: 'container-1' });
    const remove = vi.fn().mockResolvedValue({ success: true });
    container.registerInstance(ManagedStorageService, {
      getCanonicalScopeResourceId,
    } as unknown as ManagedStorageService);
    container.registerInstance(ManagedStorageBindingsService, {
      create,
      getTarget,
      delete: remove,
    } as unknown as ManagedStorageBindingsService);
    const user = {
      ...USER,
      scopes: [
        'storage:iam:storage-1',
        `docker:containers:environment:${NODE_ID}/container-1`,
        `docker:containers:secrets:${NODE_ID}/container-1`,
      ],
    };
    const config = {
      targetNodeId: NODE_ID,
      targetType: 'container',
      targetResourceId: 'container-1',
      environment: { endpoint: 'S3_ENDPOINT', accessKeyId: 'S3_ACCESS_KEY', secretAccessKey: 'S3_SECRET_KEY' },
      buckets: ['uploads'],
    };

    await expect(
      executeStorageTool(user, 'manage_managed_storage', {
        action: 'create_binding',
        managedStorageId: 'managed-1',
        config,
      })
    ).resolves.toEqual({ id: 'binding-1', status: 'ready' });
    await expect(
      executeStorageTool(user, 'manage_managed_storage', {
        action: 'delete_binding',
        managedStorageId: 'managed-1',
        bindingId: 'binding-1',
        config: { targetEnvironment: { KEEP: 'value' } },
      })
    ).resolves.toEqual({ success: true });

    expect(create).toHaveBeenCalledWith('managed-1', config, 'user-1');
    expect(remove).toHaveBeenCalledWith('managed-1', 'binding-1', 'user-1', { KEEP: 'value' });
  });

  it('rejects link creation before touching the binding service when target workload access is missing', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue('storage-1');
    const create = vi.fn();
    container.registerInstance(ManagedStorageService, {
      getCanonicalScopeResourceId,
    } as unknown as ManagedStorageService);
    container.registerInstance(ManagedStorageBindingsService, { create } as unknown as ManagedStorageBindingsService);

    await expect(
      executeStorageTool({ ...USER, scopes: ['storage:iam:storage-1'] }, 'manage_managed_storage', {
        action: 'create_binding',
        managedStorageId: 'managed-1',
        config: {
          targetNodeId: NODE_ID,
          targetType: 'container',
          targetResourceId: 'container-1',
          environment: { endpoint: 'S3_ENDPOINT' },
          buckets: ['uploads'],
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(create).not.toHaveBeenCalled();
  });
});
