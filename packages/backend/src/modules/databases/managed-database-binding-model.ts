import crypto from 'node:crypto';
import type { managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { ManagedDatabaseBindingCredentials } from './managed-database-binding-target-runtime.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;

export function managedDatabaseBindingPort(type: ManagedDatabaseRow['type']): number {
  switch (type) {
    case 'postgres':
      return 5432;
    case 'redis':
      return 6379;
    case 'clickhouse':
      return 8123;
  }
}

export function newManagedDatabaseBindingCredentials(
  type: ManagedDatabaseRow['type'],
  bindingId: string,
  databaseName?: string
): ManagedDatabaseBindingCredentials {
  return {
    username: `gw_b_${bindingId.replaceAll('-', '').slice(0, 24)}`,
    password: crypto.randomBytes(32).toString('base64url'),
    ...(type === 'redis' ? {} : { databaseName: databaseName ?? 'app' }),
  };
}

export function managedDatabaseBindingView(row: ManagedDatabaseBindingRow) {
  return {
    id: row.id,
    managedDatabaseId: row.managedDatabaseId,
    targetNodeId: row.targetNodeId,
    targetType: row.targetType,
    targetResourceId: row.targetResourceId,
    environment: row.environment,
    status: row.status,
    observedState: row.observedState,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function managedDatabaseBindingEncryptedPayload(value: string): {
  encryptedKey: string;
  encryptedDek: string;
} {
  try {
    const parsed = JSON.parse(value) as { encryptedKey?: string; encryptedDek?: string };
    if (typeof parsed.encryptedKey === 'string' && typeof parsed.encryptedDek === 'string') {
      return { encryptedKey: parsed.encryptedKey, encryptedDek: parsed.encryptedDek };
    }
  } catch {
    // Return the generic corruption error below.
  }
  throw new AppError(500, 'MANAGED_DATABASE_BINDING_CREDENTIALS_CORRUPT', 'Binding credentials are unavailable');
}
