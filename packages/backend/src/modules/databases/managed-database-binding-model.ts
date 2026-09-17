import type { managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import type { ManagedDatabaseBindingCredentials } from './managed-database-binding-target-runtime.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;
export declare function managedDatabaseBindingPort(type: ManagedDatabaseRow['type']): number;
export declare function newManagedDatabaseBindingCredentials(
  type: ManagedDatabaseRow['type'],
  bindingId: string,
  databaseName?: string
): ManagedDatabaseBindingCredentials;
export declare function managedDatabaseBindingView(row: ManagedDatabaseBindingRow): {
  id: string;
  managedDatabaseId: string;
  targetNodeId: string;
  targetType: 'container' | 'deployment' | 'compose_service';
  targetResourceId: string;
  environment: import('@/db/schema/index.js').DatabaseBindingEnvironment;
  status: 'error' | 'creating' | 'ready' | 'deleting';
  observedState: import('@/db/schema/index.js').ManagedDatabaseBindingObservedState;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export declare function managedDatabaseBindingEncryptedPayload(value: string): {
  encryptedKey: string;
  encryptedDek: string;
};
