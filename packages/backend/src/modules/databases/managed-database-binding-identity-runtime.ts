import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
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

const PRINCIPAL_MODEL_VERSION = 2;
const logger = createChildLogger('ManagedDatabaseBindingIdentityRuntime');

function isDeferredUpgrade(error: unknown): boolean {
  return (
    error instanceof AppError &&
    [
      'MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED',
      'MANAGED_DATABASE_TARGET_DAEMON_UPDATE_REQUIRED',
      'NODE_OFFLINE',
      'NODE_UPDATING',
    ].includes(error.code)
  );
}

function principalName(bindingId: string) {
  return `gw_b_${bindingId.replaceAll('-', '').slice(0, 24)}`;
}

function newCredentials(
  type: ManagedDatabaseRow['type'],
  bindingId: string,
  databaseName?: string
): ManagedDatabaseBindingCredentials {
  return {
    username: principalName(bindingId),
    password: crypto.randomBytes(32).toString('base64url'),
    ...(type === 'redis' ? {} : { databaseName: databaseName ?? 'app' }),
  };
}

function requireSuccess(result: { success: boolean; error?: string }) {
  if (!result.success) throw new Error(`daemon operation failed${result.error ? `: ${result.error}` : ''}`);
}

export class ManagedDatabaseBindingIdentityRuntime {
  private readonly reconcilingNodes = new Set<string>();
  private readonly migrations = new Map<string, Promise<ManagedDatabaseBindingRow>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly callbacks: IdentityRuntimeCallbacks,
    private readonly identityManager?: ManagedDatabaseIdentityManager,
    private readonly relayPolicy?: Pick<RelayPolicyService, 'revokeOwner'>
  ) {}

  async reconcileForNode(nodeId: string): Promise<void> {
    if (this.reconcilingNodes.has(nodeId)) return;
    this.reconcilingNodes.add(nodeId);
    try {
      await this.reconcile(nodeId);
    } finally {
      this.reconcilingNodes.delete(nodeId);
    }
  }

  async reconcile(nodeId?: string) {
    const rows = await this.db
      .select({ database: managedDatabaseInstances, binding: managedDatabaseBindings })
      .from(managedDatabaseBindings)
      .innerJoin(managedDatabaseInstances, eq(managedDatabaseInstances.id, managedDatabaseBindings.managedDatabaseId));
    const legacyTargetsByDatabase = new Map<string, Set<string>>();
    for (const { binding } of rows) {
      if (binding.principalModelVersion === PRINCIPAL_MODEL_VERSION) continue;
      const targets = legacyTargetsByDatabase.get(binding.managedDatabaseId) ?? new Set<string>();
      targets.add(binding.targetNodeId);
      legacyTargetsByDatabase.set(binding.managedDatabaseId, targets);
    }
    const migrationReadiness = new Map<string, Promise<void>>();
    const ensureMigrationReady = (managedDatabaseId: string) => {
      let readiness = migrationReadiness.get(managedDatabaseId);
      if (!readiness) {
        readiness = Promise.all(
          [...(legacyTargetsByDatabase.get(managedDatabaseId) ?? [])].map((targetNodeId) =>
            this.callbacks.assertTargetReady(targetNodeId)
          )
        ).then(() => undefined);
        migrationReadiness.set(managedDatabaseId, readiness);
      }
      return readiness;
    };
    let failures = 0;
    const eligibleDatabaseIds = new Set<string>();
    for (const { database: storedDatabase, binding: storedBinding } of rows) {
      if (nodeId !== undefined && storedDatabase.nodeId !== nodeId && storedBinding.targetNodeId !== nodeId) {
        continue;
      }
      if (
        nodeId !== undefined &&
        storedDatabase.nodeId !== nodeId &&
        storedDatabase.bindingIdentityVersion !== PRINCIPAL_MODEL_VERSION
      ) {
        // A target-only reconnect cannot prove that the database daemon is
        // available for owner separation or principal mutation. Leave the
        // legacy row untouched until the database node reconnects (or a full
        // reconciliation observes identity v2 already committed).
        continue;
      }
      if (
        this.identityManager &&
        storedDatabase.status === 'ready' &&
        !storedDatabase.pendingOperation &&
        storedBinding.principalModelVersion !== PRINCIPAL_MODEL_VERSION
      ) {
        try {
          await ensureMigrationReady(storedDatabase.id);
          if (storedDatabase.bindingIdentityVersion !== PRINCIPAL_MODEL_VERSION) {
            await this.identityManager.ensureBindingIdentity(storedDatabase.id, null);
          }
        } catch (error) {
          if (isDeferredUpgrade(error)) {
            logger.info('Deferred managed database binding identity migration until daemons are updated', {
              managedDatabaseId: storedDatabase.id,
              bindingId: storedBinding.id,
            });
            continue;
          }
          failures += 1;
          await this.callbacks.markError(storedDatabase, storedBinding, error);
          continue;
        }
      }
      const reconcile = async () => {
        let binding = storedBinding;
        let database = storedDatabase;
        if (this.identityManager) {
          try {
            binding = await this.callbacks.getBinding(storedDatabase.id, storedBinding.id);
          } catch (error) {
            if (error instanceof AppError && error.code === 'MANAGED_DATABASE_BINDING_NOT_FOUND') return;
            throw error;
          }
          database = await this.callbacks.getDatabase(storedDatabase.id);
        }
        if (database.status !== 'ready' || database.pendingOperation) return;
        eligibleDatabaseIds.add(database.id);
        try {
          if (binding.principalModelVersion === undefined) {
            await this.reconcileUnversioned(database, binding);
            return;
          }
          if (this.identityManager && database.bindingIdentityVersion !== PRINCIPAL_MODEL_VERSION) {
            throw new Error('Managed database binding identity is not ready for reconciliation');
          }
          await this.callbacks.reconcileDesired(database, binding);
        } catch (error) {
          failures += 1;
          await this.callbacks.markError(database, binding, error);
        }
      };
      try {
        await this.callbacks.runDatabaseOperation(storedDatabase.id, () =>
          this.callbacks.runTargetOperation(storedBinding, reconcile)
        );
      } catch (error) {
        failures += 1;
        await this.callbacks.markError(storedDatabase, storedBinding, error);
      }
    }
    if (this.identityManager) {
      for (const databaseId of eligibleDatabaseIds) {
        try {
          await this.identityManager.finalizeBindingIdentity(databaseId, null);
        } catch (error) {
          failures += 1;
          logger.warn('Failed to finalize managed database binding identity', {
            managedDatabaseId: databaseId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (failures > 0) throw new Error(`Failed to reconcile ${failures} managed database binding principal(s)`);
  }

  async ensurePrincipal(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow) {
    if (binding.principalModelVersion !== PRINCIPAL_MODEL_VERSION) return this.migrateLegacy(database, binding);
    await this.reconcilePrincipal(database, binding, this.callbacks.bindingCredentials(binding));
    return binding;
  }

  private async reconcileUnversioned(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow) {
    const failedDelete = binding.status === 'error' && binding.lastError?.startsWith('Binding removal failed') === true;
    const failedCreate =
      binding.status === 'error' && binding.lastError?.startsWith('Binding preparation failed') === true;
    const failedReconcile =
      binding.status === 'error' && binding.lastError?.startsWith('Binding reconciliation failed') === true;
    if (failedCreate || failedDelete) {
      await this.relayPolicy?.revokeOwner('managed_database_binding', binding.id);
      await this.callbacks.deprovision(database, binding);
      await this.db.delete(managedDatabaseBindings).where(eq(managedDatabaseBindings.id, binding.id));
      this.callbacks.emitDeleted(database, binding);
      return;
    }
    const credentials = this.callbacks.bindingCredentials(binding);
    const owner = this.callbacks.ownerCredentials(database);
    if (credentials.username !== owner.username && database.type !== 'redis') {
      if (database.type === 'clickhouse') {
        requireSuccess(
          await this.nodeDispatch.sendDockerDatabaseCommand(
            database.nodeId,
            'clickhouse_principal_apply_v1',
            database.id,
            JSON.stringify({
              principalType: 'binding',
              username: credentials.username,
              password: credentials.password,
              databaseName: credentials.databaseName ?? 'app',
              ownerUsername: owner.username,
              ownerPassword: owner.password,
            })
          )
        );
      } else {
        requireSuccess(
          await this.nodeDispatch.sendDockerDatabaseCommand(
            database.nodeId,
            'binding_create',
            database.id,
            JSON.stringify({
              bindingId: binding.id,
              username: credentials.username,
              password: credentials.password,
              databaseName: credentials.databaseName ?? 'app',
              ownerUsername: owner.username,
              ownerPassword: owner.password,
            })
          )
        );
      }
    }
    await this.callbacks.reconcileRuntime(database, binding);
    if (failedReconcile) {
      const [ready] = await this.db
        .update(managedDatabaseBindings)
        .set({ status: 'ready', lastError: null, updatedAt: new Date() })
        .where(eq(managedDatabaseBindings.id, binding.id))
        .returning();
      this.callbacks.emitReady(database, ready!);
      return;
    }
    this.callbacks.emitReady(database, binding);
  }

  private async reconcilePrincipal(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ) {
    const payload = this.callbacks.bindingPrincipalPayload(database, binding, credentials);
    requireSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(
        database.nodeId,
        'binding_principal_apply_v2',
        database.id,
        payload
      )
    );
    requireSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(
        database.nodeId,
        'binding_principal_probe_v2',
        database.id,
        payload
      )
    );
  }

  private async migrateLegacy(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow) {
    const existing = this.migrations.get(binding.id);
    if (existing) return existing;
    const migration = this.performMigration(database, binding);
    this.migrations.set(binding.id, migration);
    try {
      return await migration;
    } finally {
      if (this.migrations.get(binding.id) === migration) this.migrations.delete(binding.id);
    }
  }

  private async performMigration(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow) {
    let current = binding;
    const legacy = this.callbacks.bindingCredentials(current);
    const owner = this.callbacks.ownerCredentials(database);
    let pending = this.callbacks.pendingBindingCredentials(current);
    if (!pending) {
      pending = newCredentials(database.type, current.id, legacy.databaseName);
      const [prepared] = await this.db
        .update(managedDatabaseBindings)
        .set({
          pendingEncryptedCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(pending))),
          principalName: pending.username,
          principalOperationId: current.principalOperationId ?? crypto.randomUUID(),
          credentialGeneration: Math.max(1, current.credentialGeneration + 1),
          desiredState: 'active',
          observedState: 'preparing',
          status: 'creating',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseBindings.id, current.id))
        .returning();
      current = prepared!;
    }
    await this.reconcilePrincipal(database, current, pending);
    await this.db
      .update(managedDatabaseBindings)
      .set({ observedState: 'principal_ready', updatedAt: new Date() })
      .where(eq(managedDatabaseBindings.id, current.id));
    await this.callbacks.reconcileRuntime(database, current);
    await this.callbacks.applyTarget(database, current, pending);
    await this.callbacks.reconcileTargetNode(current.targetNodeId);
    await this.callbacks.verifyTarget(database, current, pending);
    await this.retireLegacy(database, current, legacy, pending, owner);
    const [promoted] = await this.db
      .update(managedDatabaseBindings)
      .set({
        encryptedCredentials: current.pendingEncryptedCredentials!,
        pendingEncryptedCredentials: null,
        principalModelVersion: PRINCIPAL_MODEL_VERSION,
        observedState: 'active',
        status: 'ready',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseBindings.id, current.id))
      .returning();
    return promoted!;
  }

  private legacyUsesOwner(
    database: ManagedDatabaseRow,
    credentials: ManagedDatabaseBindingCredentials,
    owner: OwnerCredentials
  ) {
    if (credentials.username === owner.username) return true;
    if (database.type !== 'postgres') return false;
    const bootstrapOwner = (database.engineConfig as unknown as Record<string, unknown>).ownerUsername;
    return typeof bootstrapOwner === 'string' && bootstrapOwner.length > 0 && credentials.username === bootstrapOwner;
  }

  private async retireLegacy(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    legacy: ManagedDatabaseBindingCredentials,
    pending: ManagedDatabaseBindingCredentials,
    owner: OwnerCredentials
  ) {
    if (legacy.username === pending.username || this.legacyUsesOwner(database, legacy, owner)) return;
    requireSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(
        database.nodeId,
        'binding_principal_drop_v2',
        database.id,
        this.callbacks.bindingPrincipalPayload(database, { ...binding, principalName: legacy.username }, legacy, owner)
      )
    );
  }
}
