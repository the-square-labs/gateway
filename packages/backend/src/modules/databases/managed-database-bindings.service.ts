import crypto from 'node:crypto';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { DEVELOPMENT_DATABASE_CONNECTOR_IMAGE } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { managedDatabaseBindings, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { CreateManagedDatabaseBindingInput } from './databases.schemas.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;

interface BindingCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

const immutableImageReference = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const logger = createChildLogger('ManagedDatabaseBindings');

function enginePort(type: ManagedDatabaseRow['type']): number {
  switch (type) {
    case 'postgres':
      return 5432;
    case 'redis':
      return 6379;
    case 'clickhouse':
      return 8123;
  }
}

function bindingView(row: ManagedDatabaseBindingRow) {
  return {
    id: row.id,
    managedDatabaseId: row.managedDatabaseId,
    targetNodeId: row.targetNodeId,
    targetType: row.targetType,
    targetResourceId: row.targetResourceId,
    environment: row.environment,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function encryptedPayload(value: string): { encryptedKey: string; encryptedDek: string } {
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

function isMissingContainerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no such container|container not found)/i.test(message);
}

export class ManagedDatabaseBindingService {
  private eventBus?: EventBusService;
  private readonly clickHousePrincipalReconciliationNodes = new Set<string>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly dockerManagement: DockerManagementService,
    private readonly dockerDeployments: DockerDeploymentService,
    private readonly dockerSecrets: DockerSecretService,
    private readonly connectorImage: string,
    private readonly allowDevelopmentConnectorImage = false,
    private readonly relayPolicy?: Pick<RelayPolicyService, 'ensureBindingRoute' | 'getNodeGrantBundle' | 'revokeOwner'>
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; status?: unknown } | null;
      if (typeof event?.id !== 'string' || event.status !== 'online') return;
      this.reconcileClickHousePrincipalsForNode(event.id).catch((error) => {
        logger.warn('Failed to reconcile ClickHouse binding principals after daemon connect', {
          nodeId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  async list(managedDatabaseId: string) {
    await this.getReadyDatabase(managedDatabaseId);
    const rows = await this.db
      .select()
      .from(managedDatabaseBindings)
      .where(eq(managedDatabaseBindings.managedDatabaseId, managedDatabaseId))
      .orderBy(asc(managedDatabaseBindings.createdAt));
    return rows.map(bindingView);
  }

  async getTarget(managedDatabaseId: string, bindingId: string) {
    const binding = await this.getBinding(managedDatabaseId, bindingId);
    return {
      targetNodeId: binding.targetNodeId,
      targetType: binding.targetType,
      targetResourceId: binding.targetResourceId,
    };
  }

  /** Reapply secure ClickHouse binding principals after a daemon reconnect. */
  async reconcileClickHousePrincipals(nodeId?: string) {
    const rows = await this.db
      .select({ database: managedDatabaseInstances, binding: managedDatabaseBindings })
      .from(managedDatabaseBindings)
      .innerJoin(managedDatabaseInstances, eq(managedDatabaseInstances.id, managedDatabaseBindings.managedDatabaseId));
    let failures = 0;
    for (const { database, binding } of rows) {
      if (
        database.type !== 'clickhouse' ||
        database.status !== 'ready' ||
        database.pendingOperation ||
        binding.status !== 'ready' ||
        (nodeId !== undefined && database.nodeId !== nodeId)
      ) {
        continue;
      }
      try {
        const credentials = this.bindingCredentials(binding);
        const owner = this.ownerCredentials(database);
        await this.provisionClickHouseBindingPrincipal(database, owner, credentials);
        this.emitBinding(database, binding, 'binding.reconciliation_ready', { failurePhase: 'reconciliation' });
      } catch (error) {
        failures += 1;
        this.emitBinding(database, binding, 'binding.reconciliation_failed', {
          failurePhase: 'reconciliation',
          failureCode: this.failureCode(error),
        });
      }
    }
    if (failures > 0) {
      throw new Error(`Failed to reconcile ${failures} ClickHouse binding principal(s)`);
    }
  }

  private async reconcileClickHousePrincipalsForNode(nodeId: string) {
    if (this.clickHousePrincipalReconciliationNodes.has(nodeId)) return;
    this.clickHousePrincipalReconciliationNodes.add(nodeId);
    try {
      await this.reconcileClickHousePrincipals(nodeId);
    } finally {
      this.clickHousePrincipalReconciliationNodes.delete(nodeId);
    }
  }

  async create(managedDatabaseId: string, input: CreateManagedDatabaseBindingInput, userId: string) {
    const preflightDatabase = await this.getReadyDatabase(managedDatabaseId);
    await this.assertDockerNode(input.targetNodeId);
    this.assertConnectorImage();
    const targetResourceId = await this.resolveBindingTarget(input);
    await this.assertEnvironmentNamesAvailable(
      input.targetNodeId,
      input.targetType,
      targetResourceId,
      input.environment,
      input.replaceExistingEnvironment === true
    );
    const id = crypto.randomUUID();
    const shortId = id.replaceAll('-', '').slice(0, 16);
    const credentials: BindingCredentials = {
      username: `gw_${preflightDatabase.type}_${shortId.slice(0, 10)}`,
      password: crypto.randomBytes(32).toString('base64url'),
      ...(preflightDatabase.engineConfig.databaseName
        ? { databaseName: preflightDatabase.engineConfig.databaseName }
        : {}),
    };
    const encryptedCredentials = JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials)));
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
          encryptedCredentials,
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
    return this.provisionBinding(database, row, userId, {
      replaceExistingEnvironment: input.replaceExistingEnvironment === true,
      targetEnvironment: input.targetEnvironment,
    });
  }

  async delete(
    managedDatabaseId: string,
    bindingId: string,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    const database = await this.getDatabase(managedDatabaseId);
    const row = await this.getBinding(managedDatabaseId, bindingId);
    const [deleting] = await this.db
      .update(managedDatabaseBindings)
      .set({ status: 'deleting', updatedById: userId, updatedAt: new Date() })
      .where(eq(managedDatabaseBindings.id, bindingId))
      .returning();
    // Close existing relay sessions before any fallible cleanup. The status
    // transition prevents new opens while the source daemon persists revocation.
    try {
      await this.relayPolicy?.revokeOwner('managed_database_binding', deleting!.id);
    } catch (error) {
      // Periodic canonical relay reconciliation is the durable fallback. Cleanup
      // must continue after the committed deleting transition.
      logger.warn('Direct relay binding revocation failed; reconciliation will retry', {
        bindingId: deleting!.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this.deprovisionBinding(database, deleting!, userId, options);
    } catch (error) {
      return this.markBindingError(database, deleting!, 'delete', error);
    }
    await this.db.delete(managedDatabaseBindings).where(eq(managedDatabaseBindings.id, bindingId));
    await this.auditService.log({
      userId,
      action: 'database.managed.binding.delete',
      resourceType: 'managed_database_binding',
      resourceId: bindingId,
      details: {
        managedDatabaseId,
        targetNodeId: row.targetNodeId,
        targetType: row.targetType,
        targetResourceId: row.targetResourceId,
      },
    });
    this.emitBinding(database, deleting!, 'binding.deleted');
    return { success: true };
  }

  async revealCredentials(managedDatabaseId: string, bindingId: string) {
    const database = await this.getReadyDatabase(managedDatabaseId);
    const binding = await this.getBinding(managedDatabaseId, bindingId);
    const plaintext = this.cryptoService.decryptString(encryptedPayload(binding.encryptedCredentials));
    const credentials = JSON.parse(plaintext) as BindingCredentials;
    const port = enginePort(database.type);
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

  private async provisionBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    userId: string,
    options: { replaceExistingEnvironment?: boolean; targetEnvironment?: Record<string, string> } = {}
  ) {
    let principalCreated = false;
    let policyPrepared = false;
    let networkCreated = false;
    let connectorCreated = false;
    let targetApplyAttempted = false;
    try {
      const credentials = this.bindingCredentials(binding);
      const owner = this.ownerCredentials(database);
      if (database.type === 'clickhouse') {
        await this.provisionClickHouseBindingPrincipal(database, owner, credentials);
      } else {
        this.requireSuccess(
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
      principalCreated = true;

      if (!this.relayPolicy) throw new Error('Gateway relay policy is unavailable');
      await this.relayPolicy.ensureBindingRoute(
        binding.id,
        binding.managedDatabaseId,
        binding.targetNodeId,
        database.nodeId
      );
      policyPrepared = true;
      // The command ACK proves that the source daemon persisted its connect
      // grant. Its detail also exposes the daemon-owned Unix socket mounted by
      // the first-party connector.
      const prepared = await this.nodeDispatch.sendRelayGrantBundle(
        binding.targetNodeId,
        await this.relayPolicy.getNodeGrantBundle(binding.targetNodeId)
      );
      this.requireSuccess(prepared);
      const socketMount = this.tunnelSocketMount(prepared.detail);

      this.requireSuccess(
        await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'create', {
          networkId: binding.networkName,
          driver: 'bridge',
        })
      );
      networkCreated = true;
      this.requireSuccess(
        await this.nodeDispatch.sendDockerImageCommand(binding.targetNodeId, this.connectorImageAction(), {
          imageRef: this.connectorImage,
        })
      );
      const connector = await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'create', {
        configJson: JSON.stringify({
          name: binding.connectorName,
          image: this.connectorImage,
          env: [
            `GATEWAY_DB_BINDING_ID=${binding.id}`,
            `GATEWAY_DB_SOCKET=${socketMount.connectorPath}`,
            `GATEWAY_DB_LISTEN=:${enginePort(database.type)}`,
          ],
          binds: [`${socketMount.hostDirectory}:/run/gateway-db:ro`],
          network_mode: binding.networkName,
          network_aliases: [binding.connectorAlias],
          restartPolicy: 'unless-stopped',
          labels: {
            'wiolett.gateway.managed-database.binding': binding.id,
            'wiolett.gateway.managed-database.connector': 'true',
          },
        }),
      });
      this.requireSuccess(connector);
      const connectorId = this.containerID(connector.detail);
      connectorCreated = true;
      this.requireSuccess(
        await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'start', { containerId: connectorId })
      );

      // Mark this before the first target write. Compensation is credential
      // value-aware, so it removes only values that this binding actually set.
      targetApplyAttempted = true;
      await this.applyTargetBinding(database, binding, credentials, userId, options);
    } catch (error) {
      await this.compensateProvisioning(database, binding, {
        principalCreated,
        policyPrepared,
        networkCreated,
        connectorCreated,
        targetApplyAttempted,
      });
      return this.markBindingError(database, binding, 'prepare', error);
    }

    const [ready] = await this.db
      .update(managedDatabaseBindings)
      .set({ status: 'ready', lastError: null, updatedAt: new Date() })
      .where(eq(managedDatabaseBindings.id, binding.id))
      .returning();
    this.emitBinding(database, ready!, 'binding.ready');
    return bindingView(ready!);
  }

  private async provisionClickHouseBindingPrincipal(
    database: ManagedDatabaseRow,
    owner: OwnerCredentials,
    credentials: BindingCredentials
  ) {
    this.requireSuccess(
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
  }

  private async deprovisionBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    const credentials = this.bindingCredentials(binding);
    const owner = this.ownerCredentials(database);
    await this.removeTargetBinding(database, binding, userId, options);
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
    this.requireSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(
        database.nodeId,
        'binding_remove',
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

  private async applyTargetBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: BindingCredentials,
    userId: string,
    options: { replaceExistingEnvironment?: boolean; targetEnvironment?: Record<string, string> } = {}
  ) {
    const values = this.bindingEnvironmentValues(database, binding, credentials);
    if (binding.targetType === 'deployment') {
      const secretContainer = `deployment:${binding.targetResourceId}`;
      for (const [key, value] of Object.entries(values)) {
        await this.dockerSecrets.create(binding.targetNodeId, secretContainer, key, value, userId);
      }
      try {
        await this.dockerDeployments.setManagedDatabaseBindingNetwork(
          binding.targetNodeId,
          binding.targetResourceId,
          binding.networkName,
          true,
          userId
        );
      } catch (error) {
        await this.removeDeploymentSecrets(binding, Object.keys(values), userId);
        throw error;
      }
      return;
    }

    this.requireSuccess(
      await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'connect', {
        networkId: binding.networkName,
        containerId: binding.targetResourceId,
      })
    );
    const current = this.environmentMap(
      await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)
    );
    const ordinaryEnvironment = { ...(options.targetEnvironment ?? current) };
    const managedNames = Object.keys(values);
    for (const name of managedNames) {
      // Managed credentials live in Docker secrets. This keeps them out of
      // the ordinary Environment editor while updateContainerEnv still merges
      // them into the recreated container configuration.
      await this.dockerSecrets.create(binding.targetNodeId, binding.targetResourceId, name, values[name]!, userId);
      delete ordinaryEnvironment[name];
    }
    const removeEnv = Object.keys(current).filter(
      (name) => !Object.hasOwn(ordinaryEnvironment, name) || managedNames.includes(name)
    );
    await this.dockerManagement.updateContainerEnv(
      binding.targetNodeId,
      binding.targetResourceId,
      ordinaryEnvironment,
      removeEnv,
      userId
    );
  }

  private async removeTargetBinding(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    const expected = this.bindingEnvironmentValues(database, binding, this.bindingCredentials(binding));
    const variableNames = Object.keys(expected);
    if (binding.targetType === 'deployment') {
      const secretContainer = `deployment:${binding.targetResourceId}`;
      const values = await this.matchingDeploymentSecretValues(binding, expected);
      await this.removeDeploymentSecrets(binding, Object.keys(values), userId);
      try {
        await this.dockerDeployments.setManagedDatabaseBindingNetwork(
          binding.targetNodeId,
          binding.targetResourceId,
          binding.networkName,
          false,
          userId
        );
      } catch (error) {
        for (const [key, value] of Object.entries(values)) {
          await this.dockerSecrets.create(binding.targetNodeId, secretContainer, key, value, userId);
        }
        throw error;
      }
      const deployment = await this.dockerDeployments.get(binding.targetNodeId, binding.targetResourceId);
      for (const slot of deployment.slots) {
        if (slot.containerName) {
          await this.nodeDispatch
            .sendDockerNetworkCommand(binding.targetNodeId, 'disconnect', {
              networkId: binding.networkName,
              containerId: slot.containerName,
            })
            .catch(() => undefined);
        }
      }
      return;
    }

    try {
      const secrets = await this.dockerSecrets.list(binding.targetNodeId, binding.targetResourceId, true);
      for (const secret of secrets) {
        if (variableNames.includes(secret.key) && secret.value === expected[secret.key]) {
          await this.dockerSecrets.delete(secret.id, binding.targetNodeId, userId, binding.targetResourceId);
        }
      }
      const current = this.environmentMap(
        await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)
      );
      const ordinaryEnvironment = { ...(options.targetEnvironment ?? current) };
      for (const name of variableNames) delete ordinaryEnvironment[name];
      const removeEnv = Array.from(
        new Set([...variableNames, ...Object.keys(current).filter((name) => !Object.hasOwn(ordinaryEnvironment, name))])
      );
      await this.dockerManagement.updateContainerEnv(
        binding.targetNodeId,
        binding.targetResourceId,
        ordinaryEnvironment,
        removeEnv,
        userId
      );
    } catch (error) {
      // The target may have been removed while a failed binding was being
      // reconciled. Its sidecar, tunnel lane and database principal still
      // need cleanup; only the no-longer-possible env update is optional.
      if (!isMissingContainerError(error)) throw error;
    }
    await this.nodeDispatch
      .sendDockerNetworkCommand(binding.targetNodeId, 'disconnect', {
        networkId: binding.networkName,
        containerId: binding.targetResourceId,
      })
      .catch(() => undefined);
  }

  private async compensateProvisioning(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    state: {
      principalCreated: boolean;
      policyPrepared: boolean;
      networkCreated: boolean;
      connectorCreated: boolean;
      targetApplyAttempted: boolean;
    }
  ) {
    if (state.targetApplyAttempted) await this.removeTargetBinding(database, binding, 'system').catch(() => undefined);
    if (state.connectorCreated) {
      await this.nodeDispatch
        .sendDockerContainerCommand(binding.targetNodeId, 'remove', { containerId: binding.connectorName, force: true })
        .catch(() => undefined);
    }
    if (state.networkCreated) {
      await this.nodeDispatch
        .sendDockerNetworkCommand(binding.targetNodeId, 'remove', { networkId: binding.networkName })
        .catch(() => undefined);
    }
    if (state.policyPrepared) {
      await this.relayPolicy?.revokeOwner('managed_database_binding', binding.id).catch(() => undefined);
    }
    if (state.principalCreated) {
      const credentials = this.bindingCredentials(binding);
      const owner = this.ownerCredentials(database);
      await this.nodeDispatch
        .sendDockerDatabaseCommand(
          database.nodeId,
          'binding_remove',
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
        .catch(() => undefined);
    }
  }

  private async markBindingError(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    operation: 'prepare' | 'delete',
    error?: unknown
  ) {
    const operationLabel = operation === 'prepare' ? 'Binding preparation failed' : 'Binding removal failed';
    const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
    const [failed] = await this.db
      .update(managedDatabaseBindings)
      .set({
        status: 'error',
        lastError: detail ? `${operationLabel}: ${detail}`.slice(0, 1_000) : operationLabel,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseBindings.id, binding.id))
      .returning();
    this.emitBinding(database, failed!, 'binding.error', {
      failurePhase: operation === 'prepare' ? 'provisioning' : 'deprovisioning',
      failureCode: this.failureCode(error),
    });
    return bindingView(failed!);
  }

  private assertConnectorImage() {
    if (immutableImageReference.test(this.connectorImage) || this.usesDevelopmentConnectorImage()) return;
    throw new AppError(
      503,
      'MANAGED_DATABASE_CONNECTOR_UNAVAILABLE',
      'Managed database connector image is not configured with an immutable digest'
    );
  }

  private usesDevelopmentConnectorImage() {
    return this.allowDevelopmentConnectorImage && this.connectorImage === DEVELOPMENT_DATABASE_CONNECTOR_IMAGE;
  }

  private connectorImageAction(): 'ensure' | 'ensure-local' {
    return this.usesDevelopmentConnectorImage() ? 'ensure-local' : 'ensure';
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

  private tunnelSocketPath(detail: string | undefined) {
    try {
      const parsed = JSON.parse(detail ?? '') as { socketPath?: unknown };
      if (
        typeof parsed.socketPath === 'string' &&
        /^\/[A-Za-z0-9._/-]+$/.test(parsed.socketPath) &&
        parsed.socketPath !== '/'
      ) {
        return parsed.socketPath;
      }
    } catch {
      // Convert malformed daemon details to a generic provisioning error.
    }
    throw new Error('database tunnel socket is unavailable');
  }

  private tunnelSocketMount(detail: string | undefined) {
    const socketPath = this.tunnelSocketPath(detail);
    const hostDirectory = path.posix.dirname(socketPath);
    const socketName = path.posix.basename(socketPath);
    if (hostDirectory === '/' || !socketName || socketName === '.' || socketName === '..') {
      throw new Error('database tunnel socket directory is unavailable');
    }
    return {
      hostDirectory,
      connectorPath: path.posix.join('/run/gateway-db', socketName),
    };
  }

  private containerID(detail: string | undefined) {
    try {
      const parsed = JSON.parse(detail ?? '') as { id?: unknown; Id?: unknown };
      const id = typeof parsed.id === 'string' ? parsed.id : parsed.Id;
      if (typeof id === 'string' && /^[a-f0-9]{12,128}$/i.test(id)) return id;
    } catch {
      // Convert malformed daemon details to a generic provisioning error.
    }
    throw new Error('connector container was not created');
  }

  private bindingCredentials(binding: ManagedDatabaseBindingRow): BindingCredentials {
    const plaintext = this.cryptoService.decryptString(encryptedPayload(binding.encryptedCredentials));
    return JSON.parse(plaintext) as BindingCredentials;
  }

  private ownerCredentials(database: ManagedDatabaseRow): OwnerCredentials {
    const plaintext = this.cryptoService.decryptString(encryptedPayload(database.encryptedOwnerCredentials));
    return JSON.parse(plaintext) as OwnerCredentials;
  }

  private bindingEnvironmentValues(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: BindingCredentials
  ): Record<string, string> {
    const host = binding.connectorAlias;
    const port = enginePort(database.type);
    const databaseName = credentials.databaseName;
    const connectionUri =
      database.type === 'redis'
        ? `redis://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}`
        : database.type === 'clickhouse'
          ? `http://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}/?database=${encodeURIComponent(databaseName ?? 'default')}`
          : `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}/${encodeURIComponent(databaseName ?? 'app')}`;
    const values: Record<string, string> = {};
    if (binding.environment.connectionUri) values[binding.environment.connectionUri] = connectionUri;
    if (binding.environment.host) values[binding.environment.host] = host;
    if (binding.environment.port) values[binding.environment.port] = String(port);
    if (binding.environment.database && databaseName) values[binding.environment.database] = databaseName;
    if (binding.environment.username) values[binding.environment.username] = credentials.username;
    if (binding.environment.password) values[binding.environment.password] = credentials.password;
    return values;
  }

  private environmentMap(entries: unknown): Record<string, string> {
    if (!Array.isArray(entries)) return {};
    return Object.fromEntries(
      entries
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => {
          const separator = entry.indexOf('=');
          return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
        })
    );
  }

  private async resolveBindingTarget(input: CreateManagedDatabaseBindingInput): Promise<string> {
    if (input.targetType === 'deployment') {
      await this.dockerDeployments.get(input.targetNodeId, input.targetResourceId);
      return input.targetResourceId;
    }
    const inspect = await this.dockerManagement.inspectContainer(input.targetNodeId, input.targetResourceId);
    const labels = (inspect?.Config?.Labels ?? {}) as Record<string, string>;
    if (labels['wiolett.gateway.deployment.managed'] === 'true') {
      throw new AppError(409, 'MANAGED_DEPLOYMENT_CONTAINER', 'Use a deployment target for a blue/green container');
    }
    if (labels['wiolett.gateway.managed-database.connector'] === 'true') {
      throw new AppError(
        409,
        'MANAGED_DATABASE_CONNECTOR_TARGET',
        'A managed database connector cannot be a binding target'
      );
    }
    const name = typeof inspect?.Name === 'string' ? inspect.Name.replace(/^\/+/, '') : '';
    if (!name) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
    return name;
  }

  private async assertEnvironmentNamesAvailable(
    targetNodeId: string,
    targetType: ManagedDatabaseBindingRow['targetType'],
    targetResourceId: string,
    environment: ManagedDatabaseBindingRow['environment'],
    replaceExistingEnvironment = false
  ) {
    const requested = new Set(Object.values(environment).filter((value): value is string => Boolean(value)));
    if (requested.size === 0) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_BINDING_ENV_REQUIRED',
        'At least one application environment variable is required'
      );
    }
    const rows = await this.db
      .select({ environment: managedDatabaseBindings.environment })
      .from(managedDatabaseBindings)
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, targetNodeId),
          eq(managedDatabaseBindings.targetType, targetType),
          eq(managedDatabaseBindings.targetResourceId, targetResourceId)
        )
      );
    for (const row of rows) {
      if (Object.values(row.environment).some((name) => name && requested.has(name))) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_BINDING_ENV_CONFLICT',
          'A managed database binding already uses an environment variable'
        );
      }
    }

    if (targetType === 'deployment') {
      const deployment = await this.dockerDeployments.get(targetNodeId, targetResourceId);
      const secretKeys = await this.dockerSecrets.getSecretKeys(targetNodeId, `deployment:${targetResourceId}`);
      const existing = new Set([...Object.keys(deployment.desiredConfig.env ?? {}), ...secretKeys]);
      if ([...requested].some((name) => existing.has(name))) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_BINDING_ENV_CONFLICT',
          'The deployment already uses an environment variable'
        );
      }
      return;
    }

    const inspect = await this.dockerManagement.inspectContainer(targetNodeId, targetResourceId);
    const name = typeof inspect?.Name === 'string' ? inspect.Name.replace(/^\/+/, '') : '';
    const envKeys = new Set(
      (Array.isArray(inspect?.Config?.Env) ? (inspect.Config.Env as unknown[]) : [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.split('=', 1)[0]!)
    );
    if (name) {
      for (const key of await this.dockerSecrets.getSecretKeys(targetNodeId, name)) envKeys.add(key);
    }
    if ([...requested].some((key) => envKeys.has(key)) && !(targetType === 'container' && replaceExistingEnvironment)) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_BINDING_ENV_CONFLICT',
        'The container already uses an environment variable'
      );
    }
  }

  private async matchingDeploymentSecretValues(binding: ManagedDatabaseBindingRow, expected: Record<string, string>) {
    const all = await this.dockerSecrets.getDecryptedMap(
      binding.targetNodeId,
      `deployment:${binding.targetResourceId}`
    );
    return Object.fromEntries(Object.entries(expected).filter(([key, value]) => all[key] === value)) as Record<
      string,
      string
    >;
  }

  private async removeDeploymentSecrets(binding: ManagedDatabaseBindingRow, keys: string[], userId: string) {
    const rows = await this.dockerSecrets.list(binding.targetNodeId, `deployment:${binding.targetResourceId}`, false);
    for (const row of rows) {
      if (keys.includes(row.key)) {
        await this.dockerSecrets.delete(row.id, binding.targetNodeId, userId, `deployment:${binding.targetResourceId}`);
      }
    }
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
