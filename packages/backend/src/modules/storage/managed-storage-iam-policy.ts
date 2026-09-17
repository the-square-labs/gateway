export type ManagedStorageAccessLevel = 'read-only' | 'read-write';
export declare function buildManagedStoragePolicy(access: ManagedStorageAccessLevel, buckets: string[]): string;
