export type ManagedStorageAccessLevel = 'read-only' | 'read-write';
export declare function buildManagedStoragePolicy(access: ManagedStorageAccessLevel, buckets: string[]): string;
export declare function buildSeaweedfsStoragePolicy(access: ManagedStorageAccessLevel, buckets: string[]): string;
export declare function buildStoragePolicyForEngine(
  engine: 'minio' | 'seaweedfs',
  access: ManagedStorageAccessLevel,
  buckets: string[]
): string;
