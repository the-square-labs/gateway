import { describe, expect, it } from 'vitest';
import type { WorkloadRow } from '../../modules/managed-workloads/managed-workload-store.js';
import { systemCAPurposeEnum } from './certificate-authorities.js';
import {
  type ManagedStorageClusterRow,
  managedStorageAccessKeys,
  managedStorageClusterMembers,
  managedStorageClusters,
  managedStorageMemberStatusEnum,
  managedStorageStatusEnum,
} from './managed-storage.js';
import { objectStorageConnectionOriginEnum } from './object-storage.js';

// Compile-time guard: `ManagedStorageClusterRow` must stay assignable to the
// `ManagedWorkloadStore` seam's `WorkloadRow` (it has strictly more columns,
// which is fine for structural assignability).
const _c: WorkloadRow = {} as ManagedStorageClusterRow;
void _c;

describe('managed-storage schema', () => {
  it('defines the managed storage status enum without a paused state', () => {
    expect(managedStorageStatusEnum.enumValues).toEqual([
      'creating',
      'updating',
      'ready',
      'stopped',
      'error',
      'deleting',
    ]);
  });

  it('defines the object storage connection origin enum', () => {
    expect(objectStorageConnectionOriginEnum.enumValues).toEqual(['user', 'managed']);
  });

  it('exposes the expected managed_storage_clusters columns', () => {
    const keys = Object.keys(managedStorageClusters);
    expect(keys).toContain('objectStorageConnectionId');
    expect(keys).toContain('encryptedRootCredentials');
    expect(keys).toContain('publishedPort');
    expect(keys).toContain('pendingOperation');
    expect(keys).toContain('nodeId');
    expect(keys).toContain('status');
    expect(keys).toContain('erasureConfig');
    expect(keys).toContain('tlsEnabled');
    expect(keys).toContain('relayEnabled');
    expect(keys).toContain('certificateId');
    expect(keys).toContain('sftpEnabled');
    expect(keys).toContain('sftpPort');
    expect(keys).toContain('encryptedSftpHostKey');
  });

  it('scopes the system CA purpose enum to node mTLS, database TLS, and storage TLS', () => {
    expect(systemCAPurposeEnum.enumValues).toEqual(['node-mtls', 'database-tls', 'storage-tls']);
  });

  it('defines the managed storage member status enum', () => {
    expect(managedStorageMemberStatusEnum.enumValues).toEqual(['pending', 'ready', 'error', 'removing']);
  });

  it('exposes the expected managed_storage_cluster_members columns', () => {
    const keys = Object.keys(managedStorageClusterMembers);
    expect(keys).toContain('clusterId');
    expect(keys).toContain('nodeId');
    expect(keys).toContain('memberIndex');
    expect(keys).toContain('drives');
    expect(keys).toContain('status');
    expect(keys).toContain('lastError');
  });

  it('exposes the expected managed_storage_access_keys columns', () => {
    const keys = Object.keys(managedStorageAccessKeys);
    expect(keys).toContain('id');
    expect(keys).toContain('clusterId');
    expect(keys).toContain('accessKeyId');
    expect(keys).toContain('encryptedSecretKey');
    expect(keys).toContain('name');
    expect(keys).toContain('createdById');
    expect(keys).toContain('createdAt');
    expect(keys).toContain('updatedAt');
    // Never a plaintext secret column.
    expect(keys).not.toContain('secretKey');
  });
});
