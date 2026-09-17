import type { DrizzleClient } from '@/db/client.js';
import type { managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { ManagedDatabaseBindingCredentials } from './managed-database-binding-target-runtime.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;
interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}
interface ManagedDatabaseIdentityManager {
  ensureBindingIdentity(managedDatabaseId: string, userId: string | null): Promise<ManagedDatabaseRow>;
  finalizeBindingIdentity(managedDatabaseId: string, userId: string | null): Promise<ManagedDatabaseRow>;
}
interface IdentityRuntimeCallbacks {
  getBinding(managedDatabaseId: string, bindingId: string): Promise<ManagedDatabaseBindingRow>;
  getDatabase(managedDatabaseId: string): Promise<ManagedDatabaseRow>;
  assertDatabaseReady(nodeId: string): Promise<void>;
  assertTargetReady(nodeId: string): Promise<void>;
  markError(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow, error: unknown): Promise<void>;
  deprovision(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow): Promise<void>;
  reconcileDesired(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow): Promise<void>;
  reconcileRuntime(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow): Promise<void>;
  applyTarget(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ): Promise<void>;
  verifyTarget(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ): Promise<void>;
  reconcileTargetNode(nodeId: string): Promise<void>;
  emitReady(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow): void;
  emitDeleted(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow): void;
  runDatabaseOperation<T>(managedDatabaseId: string, operation: () => Promise<T>): Promise<T>;
  runTargetOperation<T>(binding: ManagedDatabaseBindingRow, operation: () => Promise<T>): Promise<T>;
  bindingCredentials(binding: ManagedDatabaseBindingRow): ManagedDatabaseBindingCredentials;
  pendingBindingCredentials(binding: ManagedDatabaseBindingRow): ManagedDatabaseBindingCredentials | null;
  ownerCredentials(database: ManagedDatabaseRow): OwnerCredentials;
  bindingPrincipalPayload(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    owner?: OwnerCredentials
  ): string;
}
export declare class ManagedDatabaseBindingIdentityRuntime {
  private readonly db;
  private readonly cryptoService;
  private readonly nodeDispatch;
  private readonly callbacks;
  private readonly identityManager?;
  private readonly relayPolicy?;
  private readonly reconcilingNodes;
  private readonly migrations;
  constructor(
    db: DrizzleClient,
    cryptoService: CryptoService,
    nodeDispatch: NodeDispatchService,
    callbacks: IdentityRuntimeCallbacks,
    identityManager?: ManagedDatabaseIdentityManager | undefined,
    relayPolicy?: Pick<RelayPolicyService, 'revokeOwner'> | undefined
  );
  reconcileForNode(nodeId: string): Promise<void>;
  reconcile(nodeId?: string): Promise<void>;
  ensurePrincipal(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow
  ): Promise<{
    id: string;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    updatedById: string | null;
    status: 'error' | 'creating' | 'ready' | 'deleting';
    managedDatabaseId: string;
    targetNodeId: string;
    targetType: 'container' | 'deployment' | 'compose_service';
    targetResourceId: string;
    networkName: string;
    connectorName: string;
    connectorAlias: string;
    connectorAddress: string | null;
    environment: import('@/db/schema/index.js').DatabaseBindingEnvironment;
    encryptedCredentials: string;
    pendingEncryptedCredentials: string | null;
    principalName: string | null;
    principalModelVersion: number;
    credentialGeneration: number;
    principalOperationId: string | null;
    desiredState: import('@/db/schema/index.js').ManagedDatabaseBindingDesiredState;
    observedState: import('@/db/schema/index.js').ManagedDatabaseBindingObservedState;
  }>;
  private reconcileUnversioned;
  private reconcilePrincipal;
  private migrateLegacy;
  private performMigration;
  private legacyUsesOwner;
  private retireLegacy;
}
