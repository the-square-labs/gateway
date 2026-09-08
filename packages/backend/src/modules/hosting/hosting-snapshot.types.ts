import type { HostingProviderOperation, HostingResourceSnapshot } from './hosting-provider.types.js';
export const HOSTING_SNAPSHOT_ACTIONS = ['snapshot_create', 'snapshot_delete', 'snapshot_restore'] as const;
export type HostingSnapshotAction = (typeof HOSTING_SNAPSHOT_ACTIONS)[number];
export interface HostingVmSnapshot {
  entityId?: string;
  status?: 'pending' | 'ready' | 'failed' | 'deleting' | 'deleted';
  providerSnapshotId?: string | null;
  operationId?: string | null;
  error?: string | null;
  includeRam?: boolean;
  revision?: string;
  id: string;
  name: string;
  createdAt: string | null;
  fingerprint: string;
  sizeGb: number | null;
  minDiskGb: number | null;
  ready: boolean;
  providerId?: string;
  monthlyCost?: { amount: string; currency: string; estimated: true; tax: 'net' | 'gross' | 'unspecified' } | null;
  storageRate?: {
    amount: string;
    currency: string;
    unit: 'GB-month';
    source: 'provider-api' | 'published-rate';
  } | null;
  layoutId?: string;
  folderId?: string | null;
  sortOrder?: number;
}
export interface HostingSnapshotAdapter {
  operation?(
    id: string,
    resource: HostingResourceSnapshot,
    action: HostingSnapshotAction
  ): Promise<HostingProviderOperation>;
  list(resource: HostingResourceSnapshot): Promise<HostingVmSnapshot[]>;
  create(
    resource: HostingResourceSnapshot,
    name: string,
    marker: string,
    options?: { includeRam?: boolean }
  ): Promise<HostingProviderOperation>;
  remove(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot): Promise<HostingProviderOperation>;
  restore(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot): Promise<HostingProviderOperation>;
}
