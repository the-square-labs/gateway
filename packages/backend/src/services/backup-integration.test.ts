import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { BackupRuntimeIntegration } from './backup-integration.js';

vi.mock('@/modules/auth/live-session-user.js', () => ({ resolveLiveUser: vi.fn() }));
const source = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const run = '33333333-3333-4333-8333-333333333333';
const relay = { ensureBackupRoute: vi.fn().mockResolvedValue(run), revokeBackupRoutes: vi.fn() };
function integration() {
  return new BackupRuntimeIntegration(
    {} as never,
    {} as never,
    relay as never,
    { getStorageCA: vi.fn().mockResolvedValue({ certificatePem: 'CA' }) } as never,
    {} as never
  );
}
beforeEach(() => vi.clearAllMocks());
describe('backup runtime authority and target resolution', () => {
  it('honors a concrete resource scope without granting access to another resource', async () => {
    vi.mocked(resolveLiveUser).mockResolvedValue({
      id: 'actor',
      scopes: [`databases:backups:run:${source}`],
      isBlocked: false,
    } as never);
    const service = integration();
    await expect(service.assertScope('actor', 'databases:backups:run', source)).resolves.toBeUndefined();
    await expect(service.assertScope('actor', 'databases:backups:run', other)).rejects.toMatchObject({
      code: 'BACKUP_ACCESS_DENIED',
    });
  });
  it('revokes a blocked actor even when the stored grant is broad', async () => {
    vi.mocked(resolveLiveUser).mockResolvedValue({ scopes: ['nodes:backups:execute'], isBlocked: true } as never);
    await expect(integration().assertScope('actor', 'nodes:backups:execute', source)).rejects.toMatchObject({
      code: 'BACKUP_ACCESS_DENIED',
    });
  });
  it('resolves managed storage to a run-owned route and never forwards internal DTO metadata', async () => {
    const result = await integration().resolve(
      {
        connectionId: source,
        provider: 'minio',
        endpoint: 'https://127.0.0.1',
        managedClusterId: other,
        managedNodeId: 'target-node',
        secretAccessKey: 'test-only',
        accessKeyId: 'test-key',
      },
      'executor',
      { runId: run, bucket: 'backups', prefix: 'owned', ownerKind: 'storage_backup_target' }
    );
    expect(relay.ensureBackupRoute).toHaveBeenCalledWith(
      run,
      'executor',
      { kind: 'storage', id: other, nodeId: 'target-node' },
      'storage_backup_target'
    );
    expect(result).toMatchObject({
      relayRouteId: run,
      caPem: 'CA',
      serverName: 'localhost',
      bucket: 'backups',
      prefix: 'owned',
    });
    expect(result).not.toHaveProperty('managedClusterId');
    expect(result).not.toHaveProperty('managedNodeId');
  });
  it('resolves the standard AWS endpoint when the saved connection uses region-only configuration', async () => {
    const result = await integration().resolve(
      { connectionId: source, provider: 'aws', region: 'us-east-1' },
      'executor',
      { runId: run, bucket: 'backups', prefix: 'owned', ownerKind: 'storage_backup_target' }
    );
    expect(result.endpoint).toBe('https://s3.us-east-1.amazonaws.com');
    expect(relay.ensureBackupRoute).not.toHaveBeenCalled();
  });
});
