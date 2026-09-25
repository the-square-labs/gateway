import { describe, expect, it, vi } from 'vitest';
import { NodeDispatchService } from './node-dispatch.service.js';

function createStorageService(capabilities: string[]) {
  const registry = {
    sendCommand: vi.fn().mockResolvedValue({ success: true, detail: '{"status":"updated"}' }),
    hasCapability: vi.fn().mockReturnValue(true),
    getNode: vi.fn().mockReturnValue({ connectionId: 'connection-1' }),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ type: 'storage', status: 'online', capabilities: { capabilities } }]),
        }),
      }),
    }),
  };
  return { registry, service: new NodeDispatchService(registry as never, db as never) };
}

const readOnlyPolicy = '{"Version":"2012-10-17","Statement":[]}';

describe('NodeDispatchService storage IAM policy updates', () => {
  it('refuses a policy update on a daemon that cannot rewrite key policies', async () => {
    const { registry, service } = createStorageService(['managed_storage_v1', 'managed_storage_iam_v1']);

    await expect(
      service.sendDockerStorageIamCommand('node-1', 'update_policy', 'storage-1', {
        publishedPort: 0,
        useTls: false,
        rootAccessKey: 'root-access',
        rootSecretKey: 'root-secret',
        targetAccessKey: 'BINDINGKEY0001',
        policy: readOnlyPolicy,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'STORAGE_CAPABILITY_UNAVAILABLE' });
    expect(registry.sendCommand).not.toHaveBeenCalled();
  });

  it('sends iam_update_policy with the key and its new policy', async () => {
    const { registry, service } = createStorageService([
      'managed_storage_v1',
      'managed_storage_iam_v1',
      'managed_storage_iam_policy_v1',
      'managed_storage_seaweedfs_v1',
    ]);

    await service.sendDockerStorageIamCommand('node-1', 'update_policy', 'storage-1', {
      publishedPort: 0,
      useTls: false,
      rootAccessKey: 'root-access',
      rootSecretKey: 'root-secret',
      targetAccessKey: 'BINDINGKEY0001',
      policy: readOnlyPolicy,
    });
    await service.sendDockerStorageIamCommand('node-1', 'update_policy', 'storage-2', {
      publishedPort: 0,
      useTls: false,
      rootAccessKey: 'root-access',
      rootSecretKey: 'root-secret',
      engine: 'seaweedfs',
      principal: 'gw-key-1',
      policy: readOnlyPolicy,
    });

    const [minio, seaweedfs] = registry.sendCommand.mock.calls.map(
      (call) => (call[1] as { dockerStorage: { action: string; configJson: string } }).dockerStorage
    );
    expect(minio!.action).toBe('iam_update_policy');
    expect(JSON.parse(minio!.configJson).iam).toMatchObject({
      action: 'update_policy',
      targetAccessKey: 'BINDINGKEY0001',
      policy: readOnlyPolicy,
    });
    expect(seaweedfs!.action).toBe('iam_update_policy');
    expect(JSON.parse(seaweedfs!.configJson)).toMatchObject({
      engine: 'seaweedfs',
      iam: { action: 'update_policy', principal: 'gw-key-1', policy: readOnlyPolicy },
    });
  });
});
