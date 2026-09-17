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
