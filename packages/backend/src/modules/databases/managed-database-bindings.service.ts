import crypto from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedDatabaseBindings, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { CreateManagedDatabaseBindingInput } from './databases.schemas.js';
import { ManagedDatabaseBindingAdmission } from './managed-database-binding-admission.js';
import { ManagedDatabaseBindingIdentityRuntime } from './managed-database-binding-identity-runtime.js';
import { reconcileManagedDatabaseBindingLifecycle } from './managed-database-binding-lifecycle.js';
import {
  managedDatabaseBindingEncryptedPayload,
  managedDatabaseBindingPort,
  managedDatabaseBindingView,
  newManagedDatabaseBindingCredentials,
} from './managed-database-binding-model.js';
import {
  type ManagedDatabaseBindingCredentials,
  ManagedDatabaseBindingTargetRuntime,
} from './managed-database-binding-target-runtime.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;

type BindingCredentials = ManagedDatabaseBindingCredentials;

interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

interface ManagedDatabaseIdentityManager {
  ensureBindingIdentity(managedDatabaseId: string, userId: string | null): Promise<ManagedDatabaseRow>;
  finalizeBindingIdentity(managedDatabaseId: string, userId: string | null): Promise<ManagedDatabaseRow>;
  runBindingLifecycleOperation<T>(managedDatabaseId: string, operation: () => Promise<T>): Promise<T>;
}

const BINDING_PRINCIPAL_MODEL_VERSION = 2;

const logger = createChildLogger('ManagedDatabaseBindings');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export class ManagedDatabaseBindingService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;
  private readonly targetRuntime: ManagedDatabaseBindingTargetRuntime;
  private readonly identityRuntime: ManagedDatabaseBindingIdentityRuntime;
  private readonly admission: ManagedDatabaseBindingAdmission;
  private targetRuntimeReconciler?: {
    reconcileTargetNode(nodeId: string): Promise<void>;
    releaseTargetNetwork(nodeId: string, networkName: string): Promise<void>;
  };
  private readonly targetLifecycleOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly nodeDispatch: NodeDispatchService,
    dockerManagement: DockerManagementService,
    dockerDeployments: DockerDeploymentService,
    dockerSecrets: DockerSecretService,
    private readonly relayPolicy?: Pick<
      RelayPolicyService,
      'ensureBindingRoute' | 'syncNodeGrantBundle' | 'probeManagedDatabaseBindingRoute' | 'revokeOwner'
    > &
      Partial<Pick<RelayPolicyService, 'getManagedDatabaseBindingRouteRuntime'>>,
    dockerCompose?: DockerComposeService,
    private readonly identityManager?: ManagedDatabaseIdentityManager
  ) {
    this.targetRuntime = new ManagedDatabaseBindingTargetRuntime(
      db,
      nodeDispatch,
      dockerManagement,
      dockerDeployments,
      dockerSecrets,
      relayPolicy,
      dockerCompose
    );
    this.admission = new ManagedDatabaseBindingAdmission(
      db,
      dockerManagement,
      dockerDeployments,
      dockerSecrets,
      dockerCompose
    );
    this.identityRuntime = new ManagedDatabaseBindingIdentityRuntime(
      db,
      cryptoService,
      nodeDispatch,
      {
        getBinding: (managedDatabaseId, bindingId) => this.getBinding(managedDatabaseId, bindingId),
        getDatabase: (managedDatabaseId) => this.getDatabase(managedDatabaseId),
        assertTargetReady: (nodeId) => this.assertBindingTargetMigrationReady(nodeId),
        markError: (database, binding, error) => this.markBindingReconciliationError(database, binding, error),
        deprovision: (database, binding) => this.deprovisionBinding(database, binding, SYSTEM_USER_ID, {}),
        reconcileDesired: async (database, binding) => {
          await this.reconcileDesiredBinding(database, binding, SYSTEM_USER_ID, {}, 'reconciliation');
        },
        reconcileRuntime: (database, binding) => this.reconcileBindingRuntime(database, binding),
        applyTarget: (database, binding, credentials) =>
          this.applyTargetBinding(database, binding, credentials, SYSTEM_USER_ID, { forceDeploymentRollout: true }),
        verifyTarget: (database, binding, credentials) =>
          this.verifyTargetBindingValues(database, binding, credentials),
        reconcileTargetNode: async (nodeId) => this.targetRuntimeReconciler?.reconcileTargetNode(nodeId),
        emitReady: (database, binding) =>
          this.emitBinding(database, binding, 'binding.reconciliation_ready', { failurePhase: 'reconciliation' }),
        emitDeleted: (database, binding) =>
          this.emitBinding(database, binding, 'binding.deleted', { failurePhase: 'reconciliation' }),
        runDatabaseOperation: (managedDatabaseId, operation) =>
          this.runDatabaseBindingOperation(managedDatabaseId, operation),
        runTargetOperation: (binding, operation) => this.runTargetLifecycleOperation(binding, operation),
        bindingCredentials: (binding) => this.bindingCredentials(binding),
        pendingBindingCredentials: (binding) => this.pendingBindingCredentials(binding),
        ownerCredentials: (database) => this.ownerCredentials(database),
        bindingPrincipalPayload: (database, binding, credentials, owner) =>
          this.bindingPrincipalPayload(database, binding, credentials, owner),
      },
      identityManager,
      relayPolicy
    );
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; status?: unknown } | null;
      if (typeof event?.id !== 'string' || event.status !== 'online') return;
      this.reconcileBindingPrincipalsForNode(event.id).catch((error) => {
        logger.warn('Failed to reconcile managed database binding principals after daemon connect', {
          nodeId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    bus.subscribe('docker.container.changed', (payload) => {
      const event = payload as { nodeId?: unknown; action?: unknown; transition?: unknown } | null;
      if (typeof event?.nodeId !== 'string') return;
      const action = typeof event.action === 'string' ? event.action : '';
      if (action.startsWith('database.')) return;
      if (event.transition !== null && !['recreated', 'updated', 'started'].includes(action)) return;
      this.reconcileBindingPrincipalsForNode(event.nodeId).catch((error) => {
        logger.warn('Failed to reconcile managed database bindings after container lifecycle completion', {
          nodeId: event.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  setTargetRuntimeReconciler(reconciler: {
    reconcileTargetNode(nodeId: string): Promise<void>;
    releaseTargetNetwork(nodeId: string, networkName: string): Promise<void>;
  }): void {
    this.targetRuntimeReconciler = reconciler;
    this.targetRuntime.setReconciler(reconciler);
  }

  async list(managedDatabaseId: string) {
    await this.getReadyDatabase(managedDatabaseId);
    const rows = await this.db
      .select()
      .from(managedDatabaseBindings)
      .where(eq(managedDatabaseBindings.managedDatabaseId, managedDatabaseId))
      .orderBy(asc(managedDatabaseBindings.createdAt));
    return rows.map(managedDatabaseBindingView);
  }

  async getTarget(managedDatabaseId: string, bindingId: string) {
    const binding = await this.getBinding(managedDatabaseId, bindingId);
    return {
      targetNodeId: binding.targetNodeId,
      targetType: binding.targetType,
      targetResourceId: binding.targetResourceId,
    };
  }

  async getRuntime(managedDatabaseId: string, bindingId: string) {
    const binding = await this.getBinding(managedDatabaseId, bindingId);
    if (!this.relayPolicy?.getManagedDatabaseBindingRouteRuntime) {
      throw new AppError(503, 'RELAY_POLICY_UNAVAILABLE', 'Managed database link runtime is unavailable');
    }
    return {
      binding: managedDatabaseBindingView(binding),
      runtime: await this.relayPolicy.getManagedDatabaseBindingRouteRuntime(binding.id),
    };
  }

  /** Reapply idempotent binding principals after a database daemon reconnect. */
  async reconcileBindingPrincipals(nodeId?: string) {
    return this.identityRuntime.reconcile(nodeId);
  }

  private async reconcileBindingPrincipalsForNode(nodeId: string) {
    return this.identityRuntime.reconcileForNode(nodeId);
  }

  private runDatabaseBindingOperation<T>(managedDatabaseId: string, operation: () => Promise<T>): Promise<T> {
    return this.identityManager?.runBindingLifecycleOperation
      ? this.identityManager.runBindingLifecycleOperation(managedDatabaseId, operation)
      : operation();
  }

  private runTargetLifecycleOperation<T>(
    target: Pick<ManagedDatabaseBindingRow, 'targetNodeId' | 'targetType' | 'targetResourceId'>,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${target.targetNodeId}:${target.targetType}:${target.targetResourceId}`;
    const previous = this.targetLifecycleOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.targetLifecycleOperations.set(key, tail);
    return current.finally(() => {
      if (this.targetLifecycleOperations.get(key) === tail) this.targetLifecycleOperations.delete(key);
    });
  }

  private async reconcileDesiredBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    userId: string,
    options: { replaceExistingEnvironment?: boolean; targetEnvironment?: Record<string, string> } = {},
    source: 'request' | 'reconciliation' = 'request'
  ) {
    return reconcileManagedDatabaseBindingLifecycle(binding, binding, {
      markDeleting: async () => {
        const [row] = await this.db
          .update(managedDatabaseBindings)
          .set({ status: 'deleting', lastError: null, updatedById: userId, updatedAt: new Date() })
          .where(eq(managedDatabaseBindings.id, binding.id))
          .returning();
        return row ?? binding;
      },
      revokeAccess: async (row) => this.relayPolicy?.revokeOwner('managed_database_binding', row.id),
      deprovision: async (row) => this.deprovisionBinding(database, row, userId, options),
      deleteRecord: async (row) => {
        await this.db.delete(managedDatabaseBindings).where(eq(managedDatabaseBindings.id, row.id));
        await this.auditService.log({
          userId,
          action: 'database.managed.binding.delete',
          resourceType: 'managed_database_binding',
          resourceId: row.id,
          details: {
            managedDatabaseId: database.id,
            targetNodeId: row.targetNodeId,
            targetType: row.targetType,
            targetResourceId: row.targetResourceId,
          },
        });
        this.emitBinding(database, row, 'binding.deleted', {
          ...(source === 'reconciliation' ? { failurePhase: 'reconciliation' } : {}),
        });
      },
      ensurePrincipal: async (row) => this.identityRuntime.ensurePrincipal(database, row),
      markPrincipalReady: async (row) => {
        if (row.status === 'ready' && row.observedState === 'active') return row;
        const [updated] = await this.db
          .update(managedDatabaseBindings)
          .set({ status: 'creating', observedState: 'principal_ready', lastError: null, updatedAt: new Date() })
          .where(eq(managedDatabaseBindings.id, row.id))
          .returning();
        return updated ?? row;
      },
      ensureRuntime: async (row) => this.reconcileBindingRuntime(database, row),
      markReady: async (row) => {
        const [ready] = await this.db
          .update(managedDatabaseBindings)
          .set({ status: 'ready', observedState: 'active', lastError: null, updatedAt: new Date() })
          .where(eq(managedDatabaseBindings.id, row.id))
          .returning();
        this.emitBinding(database, ready!, source === 'request' ? 'binding.ready' : 'binding.reconciliation_ready', {
          ...(source === 'reconciliation' ? { failurePhase: 'reconciliation' } : {}),
        });
        return ready!;
      },
    });
  }

  private async reconcileBindingRuntime(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow) {
    return this.targetRuntime.reconcile(database, binding, this.bindingCredentials(binding));
  }

  async create(managedDatabaseId: string, input: CreateManagedDatabaseBindingInput, userId: string) {
    // LICENSE ENFORCEMENT: Shared REST/AI binding creation must remain behind the Personal entitlement.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('managed-databases');
    let readyDatabase = await this.getReadyDatabase(managedDatabaseId);
    await this.assertBindingTargetMigrationReady(input.targetNodeId);
    if (this.identityManager) {
      readyDatabase = await this.identityManager.ensureBindingIdentity(managedDatabaseId, userId);
    }
    if (
      readyDatabase.bindingIdentityVersion !== undefined &&
      readyDatabase.bindingIdentityVersion !== BINDING_PRINCIPAL_MODEL_VERSION
    ) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_IDENTITY_UNAVAILABLE',
        'Managed database binding identity is not ready'
      );
    }
    await this.assertDockerNode(input.targetNodeId);
    await this.assertBindingTargetMigrationReady(input.targetNodeId);
    const targetResourceId = await this.admission.resolveTarget(input);
    await this.admission.assertEnvironmentNamesAvailable(
      input.targetNodeId,
      input.targetType,
      targetResourceId,
      input.environment,
      input.replaceExistingEnvironment === true
    );
    const id = crypto.randomUUID();
    const shortId = id.replaceAll('-', '').slice(0, 16);
    const operationId = crypto.randomUUID();
    const provision = async () => {
      // Bindings provision external resources after this transaction. Lock the
      // managed database row while inserting so lifecycle deletion cannot race
      // past an empty binding list and cascade-delete an in-flight binding.
      const { database, row } = await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(managedDatabaseInstances)
          .where(eq(managedDatabaseInstances.id, managedDatabaseId))
          .for('update');
        if (!locked) throw new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found');
        if (locked.status !== 'ready' || locked.pendingOperation) {
          throw new AppError(409, 'MANAGED_DATABASE_NOT_READY', 'Managed database is not ready for bindings');
        }
        if (
          locked.bindingIdentityVersion !== undefined &&
          locked.bindingIdentityVersion !== BINDING_PRINCIPAL_MODEL_VERSION
        ) {
          throw new AppError(
            409,
            'MANAGED_DATABASE_IDENTITY_UNAVAILABLE',
            'Managed database binding identity is not ready'
          );
        }
        const owner = this.ownerCredentials(locked);
        const credentials = newManagedDatabaseBindingCredentials(locked.type, id, owner.databaseName);
        const [created] = await tx
          .insert(managedDatabaseBindings)
          .values({
            id,
            managedDatabaseId,
            targetNodeId: input.targetNodeId,
            targetType: input.targetType,
            targetResourceId,
            networkName: `gateway-db-${shortId}`,
            connectorName: `gateway-db-connector-${shortId}`,
            connectorAlias: `db-${shortId}`,
            environment: input.environment,
            encryptedCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials))),
            principalName: credentials.username,
            principalModelVersion: BINDING_PRINCIPAL_MODEL_VERSION,
            credentialGeneration: 1,
            principalOperationId: operationId,
            desiredState: 'active',
            observedState: 'preparing',
            status: 'creating',
            createdById: userId,
            updatedById: userId,
          })
          .returning();
        return { database: locked, row: created! };
      });
      await this.auditService.log({
        userId,
        action: 'database.managed.binding.create',
        resourceType: 'managed_database_binding',
        resourceId: row.id,
        details: {
          managedDatabaseId,
          targetNodeId: row.targetNodeId,
          targetType: row.targetType,
          targetResourceId: row.targetResourceId,
        },
      });
      this.emitBinding(database, row, 'binding.created');
      try {
        const reconciled = await this.reconcileDesiredBinding(
          database,
          row,
          userId,
          {
            replaceExistingEnvironment: input.replaceExistingEnvironment === true,
            targetEnvironment: input.targetEnvironment,
          },
          'request'
        );
        if (reconciled.deleted) throw new Error('active binding reconciliation deleted its tracking row');
        return managedDatabaseBindingView(reconciled.binding);
      } catch (error) {
        await this.markBindingReconciliationError(database, row, error);
        return managedDatabaseBindingView(await this.getBinding(database.id, row.id));
      }
    };
    const result = await this.runDatabaseBindingOperation(managedDatabaseId, () =>
      this.runTargetLifecycleOperation(
        { targetNodeId: input.targetNodeId, targetType: input.targetType, targetResourceId },
        provision
      )
    );
    await this.identityManager?.finalizeBindingIdentity(managedDatabaseId, userId);
    return result;
  }

  async delete(
    managedDatabaseId: string,
    bindingId: string,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    if (this.identityManager) {
      const currentDatabase = await this.getDatabase(managedDatabaseId);
      if (currentDatabase.bindingIdentityVersion !== BINDING_PRINCIPAL_MODEL_VERSION) {
        await this.identityManager.ensureBindingIdentity(currentDatabase.id, userId);
      }
    }
    const remove = async () => {
      const database = await this.getDatabase(managedDatabaseId);
      if (database.pendingOperation) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_OPERATION_PENDING',
          'Managed database operation is still being reconciled'
        );
      }
      const row = await this.getBinding(managedDatabaseId, bindingId);
      return this.runTargetLifecycleOperation(row, async () => {
        const [deleting] = await this.db
          .update(managedDatabaseBindings)
          .set({ status: 'deleting', desiredState: 'deleted', updatedById: userId, updatedAt: new Date() })
          .where(eq(managedDatabaseBindings.id, bindingId))
          .returning();
        try {
          await this.reconcileDesiredBinding(database, deleting!, userId, options, 'request');
          return { success: true };
        } catch (error) {
          await this.markBindingReconciliationError(database, deleting!, error);
          return managedDatabaseBindingView(await this.getBinding(database.id, deleting!.id));
        }
      });
    };
    const result = await this.runDatabaseBindingOperation(managedDatabaseId, remove);
    await this.identityManager?.finalizeBindingIdentity(managedDatabaseId, userId);
    return result;
  }

  async revealCredentials(managedDatabaseId: string, bindingId: string) {
    const database = await this.getReadyDatabase(managedDatabaseId);
    const binding = await this.getBinding(managedDatabaseId, bindingId);
    const plaintext = this.cryptoService.decryptString(
      managedDatabaseBindingEncryptedPayload(binding.encryptedCredentials)
    );
    const credentials = JSON.parse(plaintext) as BindingCredentials;
    const port = managedDatabaseBindingPort(database.type);
    const host = binding.connectorAlias;
    const databaseName = credentials.databaseName;
    const connectionUri =
      database.type === 'redis'
        ? `redis://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}`
        : database.type === 'clickhouse'
          ? `http://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}/?database=${encodeURIComponent(databaseName ?? 'default')}`
          : `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}/${encodeURIComponent(databaseName ?? 'app')}`;
    return {
      connectionUri,
      host,
      port,
      username: credentials.username,
      password: credentials.password,
      ...(databaseName ? { databaseName } : {}),
    };
  }

  private async getReadyDatabase(id: string): Promise<ManagedDatabaseRow> {
    const database = await this.getDatabase(id);
    if (database.status !== 'ready') {
      throw new AppError(409, 'MANAGED_DATABASE_NOT_READY', 'Managed database is not ready for bindings');
    }
    return database;
  }

  private async getDatabase(id: string): Promise<ManagedDatabaseRow> {
    const [database] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, id))
      .limit(1);
    if (!database) throw new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found');
    return database;
  }

  private async deprovisionBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    const credentials = this.bindingCredentials(binding);
    const principalCredentials = this.pendingBindingCredentials(binding) ?? credentials;
    const owner = this.ownerCredentials(database);
    await this.prepareTargetNetworkRemoval(binding);
    await this.removeTargetBinding(database, binding, userId, options);
    await this.targetRuntimeReconciler?.reconcileTargetNode(binding.targetNodeId);
    if (this.relayPolicy) {
      this.requireSuccess(await this.relayPolicy.syncNodeGrantBundle(binding.targetNodeId));
    }
    this.requireSuccessOrMissing(
      await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'remove', {
        containerId: binding.connectorName,
        force: true,
      })
    );
    this.requireSuccessOrMissing(
      await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'remove', {
        networkId: binding.networkName,
      })
    );
    if (
      binding.principalModelVersion === BINDING_PRINCIPAL_MODEL_VERSION ||
      (binding.principalModelVersion !== undefined && binding.principalName !== null)
    ) {
      this.requireSuccess(
        await this.nodeDispatch.sendDockerDatabaseCommand(
          database.nodeId,
          'binding_principal_drop_v2',
          database.id,
          this.bindingPrincipalPayload(database, binding, principalCredentials, owner)
        )
      );
    } else if (
      binding.principalModelVersion !== undefined &&
      !this.legacyBindingUsesOwner(database, credentials, owner)
    ) {
      this.requireSuccess(
        await this.nodeDispatch.sendDockerDatabaseCommand(
          database.nodeId,
          'binding_principal_drop_v2',
          database.id,
          this.bindingPrincipalPayload(database, binding, credentials, owner)
        )
      );
    } else if (binding.principalModelVersion === undefined && credentials.username !== owner.username) {
      this.requireSuccess(
        await this.nodeDispatch.sendDockerDatabaseCommand(
          database.nodeId,
          'binding_remove_v2',
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
    await this.db
      .update(managedDatabaseBindings)
      .set({ observedState: 'absent', updatedAt: new Date() })
      .where(eq(managedDatabaseBindings.id, binding.id));
  }

  private legacyBindingUsesOwner(
    database: ManagedDatabaseRow,
    credentials: BindingCredentials,
    owner: OwnerCredentials
  ) {
    if (credentials.username === owner.username) return true;
    if (database.type !== 'postgres') return false;
    const bootstrapOwner = (database.engineConfig as unknown as Record<string, unknown>).ownerUsername;
    return typeof bootstrapOwner === 'string' && bootstrapOwner.length > 0 && credentials.username === bootstrapOwner;
  }

  private async prepareTargetNetworkRemoval(binding: ManagedDatabaseBindingRow): Promise<void> {
    return this.targetRuntime.prepareNetworkRemoval(binding);
  }

  private async applyTargetBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: BindingCredentials,
    userId: string,
    options: {
      replaceExistingEnvironment?: boolean;
      targetEnvironment?: Record<string, string>;
      forceDeploymentRollout?: boolean;
    } = {}
  ) {
    return this.targetRuntime.apply(database, binding, credentials, userId, options);
  }

  private async removeTargetBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    return this.targetRuntime.remove(database, binding, this.bindingCredentials(binding), userId, options);
  }

  private async verifyTargetBindingValues(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: BindingCredentials
  ) {
    return this.targetRuntime.verifyValues(database, binding, credentials);
  }

  private async markBindingReconciliationError(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    error: unknown
  ) {
    const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
    const lastError = detail
      ? `Binding reconciliation failed: ${detail}`.slice(0, 1_000)
      : 'Binding reconciliation failed';
    const [failed] = await this.db
      .update(managedDatabaseBindings)
      .set({ status: 'error', observedState: 'error', lastError, updatedAt: new Date() })
      .where(eq(managedDatabaseBindings.id, binding.id))
      .returning();
    this.emitBinding(database, failed!, 'binding.reconciliation_failed', {
      failurePhase: 'reconciliation',
      failureCode: this.failureCode(error),
    });
  }

  private requireSuccess(result: { success: boolean; detail?: string; error?: string }) {
    if (!result.success) throw new Error(`daemon operation failed${result.error ? `: ${result.error}` : ''}`);
    return result;
  }

  private requireSuccessOrMissing(result: { success: boolean; detail?: string; error?: string }) {
    if (result.success) return result;
    if (/not found|no such/i.test(result.error ?? '')) return result;
    throw new Error(`daemon operation failed${result.error ? `: ${result.error}` : ''}`);
  }

  private bindingCredentials(binding: ManagedDatabaseBindingRow): BindingCredentials {
    const plaintext = this.cryptoService.decryptString(
      managedDatabaseBindingEncryptedPayload(binding.encryptedCredentials)
    );
    return JSON.parse(plaintext) as BindingCredentials;
  }

  private pendingBindingCredentials(binding: ManagedDatabaseBindingRow): BindingCredentials | null {
    if (!binding.pendingEncryptedCredentials) return null;
    const plaintext = this.cryptoService.decryptString(
      managedDatabaseBindingEncryptedPayload(binding.pendingEncryptedCredentials)
    );
    return JSON.parse(plaintext) as BindingCredentials;
  }

  private bindingPrincipalPayload(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: BindingCredentials,
    owner = this.ownerCredentials(database)
  ) {
    return JSON.stringify({
      operationId: binding.principalOperationId ?? binding.id,
      principalName: binding.principalName ?? credentials.username,
      password: credentials.password,
      databaseName: credentials.databaseName ?? 'redis',
      applicationPrincipalName: database.applicationPrincipalName ?? owner.username,
      ownerUsername: owner.username,
      ownerPassword: owner.password,
    });
  }

  private ownerCredentials(database: ManagedDatabaseRow): OwnerCredentials {
    const plaintext = this.cryptoService.decryptString(
      managedDatabaseBindingEncryptedPayload(database.encryptedOwnerCredentials)
    );
    return JSON.parse(plaintext) as OwnerCredentials;
  }

  private async getBinding(managedDatabaseId: string, id: string): Promise<ManagedDatabaseBindingRow> {
    const [binding] = await this.db
      .select()
      .from(managedDatabaseBindings)
      .where(and(eq(managedDatabaseBindings.id, id), eq(managedDatabaseBindings.managedDatabaseId, managedDatabaseId)))
      .limit(1);
    if (!binding) throw new AppError(404, 'MANAGED_DATABASE_BINDING_NOT_FOUND', 'Managed database binding not found');
    return binding;
  }

  private async assertDockerNode(id: string) {
    const [node] = await this.db
      .select({ type: nodes.type, status: nodes.status })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Binding target node not found');
    if (node.type !== 'docker') throw new AppError(400, 'INVALID_BINDING_NODE', 'Binding target must be a Docker node');
    if (node.status !== 'online') throw new AppError(409, 'NODE_OFFLINE', 'Binding target node is offline');
  }

  private async assertBindingTargetMigrationReady(nodeId: string) {
    await this.assertDockerNode(nodeId);
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    const capabilities = (node?.capabilities as { capabilities?: unknown } | null)?.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.includes('managed_database_binding_listener_v1')) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_TARGET_DAEMON_UPDATE_REQUIRED',
        'Update the target Docker daemon before creating or migrating managed database listeners'
      );
    }
  }

  private emitBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    action:
      | 'binding.created'
      | 'binding.ready'
      | 'binding.error'
      | 'binding.deleted'
      | 'binding.reconciliation_failed'
      | 'binding.reconciliation_ready',
    extra: { failurePhase?: string; failureCode?: string } = {}
  ) {
    const payload = {
      // WebSocket database event filtering is resource-scoped by the managed
      // database connection id, not by the binding id.
      id: database.databaseConnectionId ?? database.id,
      resourceKind: 'managed_database_binding',
      managedDatabaseId: database.id,
      bindingId: binding.id,
      name: database.name,
      type: database.type,
      status: binding.status,
      action,
      targetNodeId: binding.targetNodeId,
      targetType: binding.targetType,
      targetResourceId: binding.targetResourceId,
      ...extra,
    };
    this.eventBus?.publish('database.changed', payload);
    this.eventBus?.publish('docker.container.changed', {
      action: `database.${action}`,
      nodeId: binding.targetNodeId,
      managedDatabaseId: database.id,
      bindingId: binding.id,
      targetNodeId: binding.targetNodeId,
      targetType: binding.targetType,
      targetResourceId: binding.targetResourceId,
      ...(binding.targetType === 'deployment' ? { scopeResourceId: binding.targetResourceId } : {}),
      ...(binding.targetType === 'container' ? { containerName: binding.targetResourceId } : {}),
      ...(binding.targetType === 'compose_service' ? { scopeResourceId: binding.targetResourceId } : {}),
    });
  }

  private failureCode(error: unknown): string {
    if (error instanceof AppError) return error.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/timeout|timed out/i.test(message)) return 'timeout';
    if (/offline|unavailable|disconnect/i.test(message)) return 'node_unavailable';
    if (/credential|password|authentication|unauthorized/i.test(message)) return 'authentication_failed';
    return 'binding_operation_failed';
  }
}
