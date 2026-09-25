import type { DrizzleClient } from '@/db/client.js';
import type { ManagedStorageClusterRow } from '@/db/schema/index.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
export interface StorageIamDispatchOpts {
  publishedPort: number;
  useTls: boolean;
  caPem?: string;
  serverName?: string;
  rootAccessKey: string;
  rootSecretKey: string;
  engine: 'minio' | 'seaweedfs';
}
export declare function resolveStorageIamDispatchOpts(
  db: DrizzleClient,
  row: ManagedStorageClusterRow,
  credentials: {
    username: string;
    password: string;
  },
  storageCA?: StorageCAService
): Promise<StorageIamDispatchOpts>;
export declare function isRevokedKeyAlreadyGone(engine: 'minio' | 'seaweedfs', error: string | undefined): boolean;
export declare function revokeFailureMessage(engine: 'minio' | 'seaweedfs', error: string | undefined): string;
export declare function seaweedfsPrincipal(id: string): string;
export declare function generateSeaweedfsAccessKey(): {
  accessKeyId: string;
  secretKey: string;
};
