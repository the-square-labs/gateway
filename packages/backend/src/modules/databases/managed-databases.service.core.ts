import type { managedDatabaseInstances } from '@/db/schema/index.js';
export type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
export type ManagedDatabaseType = ManagedDatabaseRow['type'];
export interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}
export interface ManagedDatabaseRuntimeStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  swapUsageBytes: number;
  swapLimitBytes: number;
  pids: number;
}
export interface ManagedDatabaseLogTarget {
  managedDatabaseId: string;
  nodeId: string;
  containerId: string;
}
export interface ManagedDatabaseLogOptions {
  tailLines?: number;
  follow?: boolean;
  timestamps?: boolean;
  since?: string;
  until?: string;
}
export type ManagedDatabaseOperation = NonNullable<ManagedDatabaseRow['pendingOperation']>;
export interface DaemonManagedDatabaseState {
  status: 'ready' | 'paused' | 'stopped' | 'missing';
  operationId?: string;
}
