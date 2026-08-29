import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { databaseConnections, managedDatabaseBindings, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  allocatedPublishedNativePort,
  allocatedPublishedPort,
  applicationPrincipalName,
  bootstrapOwnerUsername,
  CLICKHOUSE_QUERY_PRINCIPAL_VERSION,
  daemonCreateConfig,
  MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
  type ManagedDatabaseRow,
  ManagedDatabaseServiceCore,
  MEBIBYTE,
  managedConnectionConfig,
  managedDatabasePublishNativeTcp,
  managedDatabasePublishTcp,
  managedDatabaseServiceAddresses,
  newClickHouseQueryCredentials,
  newDirectAccessCredentials,
  newOwnerRotationCredentials,
  newPostgresControlCredentials,
  type OwnerCredentials,
  parseEncryptedCredentials,
} from './managed-databases.service.core.js';

export abstract class ManagedDatabaseIdentityService extends ManagedDatabaseServiceCore {
  protected async getRow(id: string): Promise<ManagedDatabaseRow> {
    const [row] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, id))
      .limit(1);
    if (!row) throw new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found');
    return row;
  }

  protected async getRowByDatabaseConnectionId(databaseConnectionId: string): Promise<ManagedDatabaseRow> {
    const [row] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    if (!row) throw new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found');
    return row;
  }

  protected async assertDatabaseNode(nodeId: string) {
    const [node] = await this.db
      .select({
        id: nodes.id,
        type: nodes.type,
        status: nodes.status,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
        capabilities: nodes.capabilities,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Database node not found');
    if (node.type !== 'databases')
      throw new AppError(400, 'INVALID_DATABASE_NODE', 'Managed databases require a database node');
    if (node.status !== 'online') throw new AppError(409, 'NODE_OFFLINE', 'Database node is offline');
    return node;
  }

  protected async assertBindingPrincipalV2Capability(nodeId: string) {
    const node = await this.assertDatabaseNode(nodeId);
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes('managed_database_binding_principals_v2')) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED',
        'Update the database daemon before creating or migrating isolated database bindings'
      );
    }
    return node;
  }

  protected async ensureManagedDatabaseCertificate(
    row: ManagedDatabaseRow,
    node: { serviceAddresses: string[]; serviceAddress: string | null; lastHealthReport: unknown }
  ): Promise<ManagedDatabaseRow> {
    if (row.certificateId || !this.databaseCA) return row;
    const serviceAddresses = managedDatabaseServiceAddresses(node);
    if (serviceAddresses.length === 0) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_TLS_IDENTITY_UNAVAILABLE',
        'Database node has no service IP addresses available for the managed TLS certificate'
      );
    }
    let updated: ManagedDatabaseRow | undefined;
    await this.databaseCA.issueManagedDatabaseCertificate(row.id, serviceAddresses, async (tx, certificate) => {
      const [bound] = await tx
        .update(managedDatabaseInstances)
        .set({ certificateId: certificate.id, updatedAt: new Date() })
        .where(and(eq(managedDatabaseInstances.id, row.id), isNull(managedDatabaseInstances.certificateId)))
        .returning();
      if (!bound) throw new Error('Managed database certificate owner binding was not claimed');
      updated = bound;
    });
    return updated!;
  }

  protected async createCanonicalConnection(
    name: string,
    type: ManagedDatabaseRow['type'],
    credentials: OwnerCredentials,
    storageSizeBytes: number,
    userId: string,
    tags: string[] = [],
    tlsEnabled = false
  ) {
    const config = managedConnectionConfig(type, credentials, tlsEnabled);
    const encryptedConfig = JSON.stringify(this.cryptoService.encryptString(JSON.stringify(config)));
    return writeWithAllocatedSlug({
      source: name,
      fallback: 'database',
      constraint: 'database_connections_slug_unique',
      write: async (slug) => {
        const [connection] = await this.db
          .insert(databaseConnections)
          .values({
            name,
            slug,
            type,
            tags,
            host: config.host,
            port: config.port,
            databaseName: config.type === 'redis' ? `db${config.db}` : config.database,
            username: config.username ?? null,
            tlsEnabled: config.type === 'postgres' ? config.sslEnabled : config.tlsEnabled,
            manualSizeLimitMb: type === 'postgres' ? Math.round(storageSizeBytes / MEBIBYTE) : null,
            encryptedConfig,
            healthStatus: 'unknown',
            createdById: userId,
            updatedById: userId,
          })
          .returning();
        return connection!;
      },
    });
  }

  async ensureBindingIdentity(managedDatabaseId: string, userId: string | null = null): Promise<ManagedDatabaseRow> {
    return this.withBindingIdentityOperation(managedDatabaseId, () =>
      this.ensureBindingIdentityUnlocked(managedDatabaseId, userId)
    );
  }

  protected async ensureBindingIdentityUnlocked(
    managedDatabaseId: string,
    userId: string | null
  ): Promise<ManagedDatabaseRow> {
    let row = await this.getRow(managedDatabaseId);
    if (
      row.bindingIdentityVersion === MANAGED_DATABASE_BINDING_IDENTITY_VERSION &&
      row.applicationPrincipalName &&
      row.directPrincipalVersion === MANAGED_DATABASE_BINDING_IDENTITY_VERSION
    ) {
      return row;
    }
    await this.assertBindingPrincipalV2Capability(row.nodeId);
    const owner = this.ownerCredentials(row);
    if (row.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
      await this.prepareBindingIdentityRuntime(row, owner);
    }
    const applicationName = row.applicationPrincipalName ?? applicationPrincipalName(row);

    if (row.type === 'postgres' && row.bindingIdentityVersion < 1) {
      const pending = row.encryptedPendingOwnerCredentials
        ? (JSON.parse(
            this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedPendingOwnerCredentials))
          ) as OwnerCredentials)
        : newPostgresControlCredentials(row, owner);
      const operationId = row.ownerSeparationOperationId ?? crypto.randomUUID();
      const [prepared] = await this.db
        .update(managedDatabaseInstances)
        .set({
          applicationPrincipalName: applicationName,
          ownerSeparationState: 'preparing',
          ownerSeparationOperationId: operationId,
          encryptedPendingOwnerCredentials:
            row.encryptedPendingOwnerCredentials ??
            JSON.stringify(this.cryptoService.encryptString(JSON.stringify(pending))),
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = prepared!;
      this.requireDatabaseCommandSuccess(
        await this.nodeDispatch.sendDockerDatabaseCommand(
          row.nodeId,
          'owner_separation_prepare_v1',
          row.id,
          JSON.stringify({
            operationId,
            databaseName: owner.databaseName ?? 'app',
            applicationPrincipalName: applicationName,
            currentOwnerUsername: owner.username,
            currentOwnerPassword: owner.password,
            pendingOwnerUsername: pending.username,
            pendingOwnerPassword: pending.password,
          })
        ),
        'Managed PostgreSQL owner separation could not be prepared'
      );
      const [preparedIdentity] = await this.db
        .update(managedDatabaseInstances)
        .set({
          encryptedOwnerCredentials: row.encryptedPendingOwnerCredentials!,
          encryptedPendingOwnerCredentials: null,
          bindingIdentityVersion: 1,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = preparedIdentity!;
      await this.syncCanonicalConnectionCredentials(row, pending, userId);
      if (row.databaseConnectionId && this.databaseConnectionService) {
        await this.databaseConnectionService.disposeClient(row.databaseConnectionId);
      }
    } else if (!row.applicationPrincipalName) {
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          applicationPrincipalName: applicationName,
          ownerSeparationState: 'preparing',
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = updated!;
    }

    const direct = this.directAccessCredentials(row);
    if (direct && row.directPrincipalVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
      await this.provisionManagedPrincipalV2(row, owner, direct, applicationName, row.id);
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          directPrincipalVersion: MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = updated!;
    } else if (!direct && row.directPrincipalVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          directPrincipalVersion: MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = updated!;
    }

    if (row.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          bindingIdentityVersion: MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = updated!;
    }
    return row;
  }

  protected async prepareBindingIdentityRuntime(row: ManagedDatabaseRow, owner: OwnerCredentials): Promise<void> {
    const runtimeOperationId = row.pendingOperation?.id ?? `binding-identity-${row.id}`;
    const runtime = {
      ...(await daemonCreateConfig(
        row,
        owner,
        managedDatabasePublishTcp(row),
        managedDatabasePublishNativeTcp(row),
        runtimeOperationId,
        this.databaseCA
      )),
      preserveLifecycleOperationId: true,
    };
    this.requireDatabaseCommandSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'update', row.id, JSON.stringify(runtime)),
      'Managed database identity runtime could not be prepared'
    );
  }

  async finalizeBindingIdentity(
    managedDatabaseId: string,
    userId: string | null = null,
    expectedPendingOperationId: string | null = null
  ): Promise<ManagedDatabaseRow> {
    return this.withBindingIdentityOperation(managedDatabaseId, () =>
      this.finalizeBindingIdentityUnlocked(managedDatabaseId, userId, expectedPendingOperationId)
    );
  }

  protected async finalizeBindingIdentityUnlocked(
    managedDatabaseId: string,
    userId: string | null,
    expectedPendingOperationId: string | null
  ): Promise<ManagedDatabaseRow> {
    let row = await this.getRow(managedDatabaseId);
    if (row.ownerSeparationState === 'active') return row;
    const ownsPendingOperation =
      expectedPendingOperationId !== null && row.pendingOperation?.id === expectedPendingOperationId;
    if (!ownsPendingOperation && (row.status !== 'ready' || row.pendingOperation)) return row;
    if (row.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION || !row.applicationPrincipalName) {
      return row;
    }
    const legacy = await this.db
      .select({
        id: managedDatabaseBindings.id,
        principalModelVersion: managedDatabaseBindings.principalModelVersion,
      })
      .from(managedDatabaseBindings)
      .where(eq(managedDatabaseBindings.managedDatabaseId, row.id));
    if (legacy.some((binding) => binding.principalModelVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION)) {
      return row;
    }
    if (row.directPrincipalVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) return row;
    if (row.type === 'clickhouse' && row.clickhouseQueryPrincipalVersion !== CLICKHOUSE_QUERY_PRINCIPAL_VERSION) {
      return row;
    }

    const currentOwner = this.ownerCredentials(row);
    const pendingOwner =
      row.type === 'postgres'
        ? currentOwner
        : row.encryptedPendingOwnerCredentials
          ? (JSON.parse(
              this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedPendingOwnerCredentials))
            ) as OwnerCredentials)
          : newOwnerRotationCredentials(currentOwner);
    const operationId = row.ownerSeparationOperationId ?? crypto.randomUUID();
    if (row.type !== 'postgres' && (!row.encryptedPendingOwnerCredentials || !row.ownerSeparationOperationId)) {
      const [prepared] = await this.db
        .update(managedDatabaseInstances)
        .set({
          ownerSeparationState: 'preparing',
          ownerSeparationOperationId: operationId,
          encryptedPendingOwnerCredentials: JSON.stringify(
            this.cryptoService.encryptString(JSON.stringify(pendingOwner))
          ),
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      row = prepared!;
    }

    this.requireDatabaseCommandSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(
        row.nodeId,
        'owner_separation_finalize_v1',
        row.id,
        JSON.stringify({
          operationId,
          databaseName: currentOwner.databaseName ?? 'redis',
          applicationPrincipalName: row.applicationPrincipalName,
          currentOwnerUsername:
            row.type === 'postgres' ? (bootstrapOwnerUsername(row) ?? currentOwner.username) : currentOwner.username,
          currentOwnerPassword: currentOwner.password,
          pendingOwnerUsername: pendingOwner.username,
          pendingOwnerPassword: pendingOwner.password,
        })
      ),
      'Managed database owner separation could not be finalized'
    );

    const [active] = await this.db
      .update(managedDatabaseInstances)
      .set({
        encryptedOwnerCredentials:
          row.type === 'postgres' ? row.encryptedOwnerCredentials : row.encryptedPendingOwnerCredentials!,
        encryptedPendingOwnerCredentials: null,
        ownerSeparationState: 'active',
        ownerSeparationOperationId: null,
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    row = active!;
    await this.syncCanonicalConnectionCredentials(row, pendingOwner, userId);
    if (row.databaseConnectionId && this.databaseConnectionService) {
      await this.databaseConnectionService.disposeClient(row.databaseConnectionId);
    }
    return row;
  }

  protected async withBindingIdentityOperation<T>(managedDatabaseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.bindingIdentityOperations.get(managedDatabaseId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.bindingIdentityOperations.set(managedDatabaseId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.bindingIdentityOperations.get(managedDatabaseId) === queued) {
        this.bindingIdentityOperations.delete(managedDatabaseId);
      }
    }
  }

  async runBindingLifecycleOperation<T>(managedDatabaseId: string, operation: () => Promise<T>): Promise<T> {
    return this.withBindingIdentityOperation(managedDatabaseId, operation);
  }

  protected async provisionManagedPrincipalV2(
    row: ManagedDatabaseRow,
    owner: OwnerCredentials,
    credentials: OwnerCredentials,
    applicationName: string,
    operationId: string
  ) {
    const payload = JSON.stringify({
      operationId,
      principalName: credentials.username,
      password: credentials.password,
      databaseName: credentials.databaseName ?? 'redis',
      applicationPrincipalName: applicationName,
      ownerUsername: owner.username,
      ownerPassword: owner.password,
    });
    this.requireDatabaseCommandSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'binding_principal_apply_v2', row.id, payload),
      'Managed database principal could not be configured'
    );
    this.requireDatabaseCommandSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'binding_principal_probe_v2', row.id, payload),
      'Managed database principal authentication could not be verified'
    );
  }

  protected requireDatabaseCommandSuccess(result: { success: boolean; error?: string }, message: string) {
    if (!result.success) {
      throw new AppError(
        503,
        'MANAGED_DATABASE_IDENTITY_UNAVAILABLE',
        result.error ? `${message}: ${result.error}` : message
      );
    }
  }

  protected ownerCredentials(row: ManagedDatabaseRow): OwnerCredentials {
    return JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
    ) as OwnerCredentials;
  }

  protected directAccessCredentials(row: ManagedDatabaseRow): OwnerCredentials | null {
    if (!row.encryptedDirectCredentials) return null;
    return JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedDirectCredentials))
    ) as OwnerCredentials;
  }

  protected queryCredentials(row: ManagedDatabaseRow): OwnerCredentials | null {
    if (!row.encryptedQueryCredentials) return null;
    return JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedQueryCredentials))
    ) as OwnerCredentials;
  }

  /**
   * Creates or reapplies the two non-owner ClickHouse principals. The marker
   * is deliberately restored only after the daemon has accepted both actions:
   * API requests with read/write scopes can therefore never fall back to the
   * canonical owner during a mixed-version rollout or a transient failure.
   */
  protected async ensureClickHouseQueryPrincipals(row: ManagedDatabaseRow, userId: string | null) {
    if (row.type !== 'clickhouse') return row;

    const owner = this.ownerCredentials(row);
    const writer = this.directAccessCredentials(row) ?? newDirectAccessCredentials(row.type, owner.databaseName);
    const reader = this.queryCredentials(row) ?? newClickHouseQueryCredentials(owner.databaseName);
    const credentialsChanged = !row.encryptedDirectCredentials || !row.encryptedQueryCredentials;
    let current = row;

    // Persist generated credentials before dispatching. If the daemon is not
    // yet compatible, a later node-online reconciliation uses the same
    // identity rather than minting an unbounded set of orphan accounts.
    if (credentialsChanged || row.clickhouseQueryPrincipalVersion === CLICKHOUSE_QUERY_PRINCIPAL_VERSION) {
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          ...(row.encryptedDirectCredentials
            ? {}
            : { encryptedDirectCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(writer))) }),
          ...(row.encryptedQueryCredentials
            ? {}
            : { encryptedQueryCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(reader))) }),
          // Clear the readiness marker before the first daemon action. A
          // partial apply after a daemon replacement must disable scoped API
          // access rather than let it attempt a potentially stale identity.
          clickhouseQueryPrincipalVersion: null,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, row.id))
        .returning();
      current = updated!;
    }

    if (
      current.bindingIdentityVersion === MANAGED_DATABASE_BINDING_IDENTITY_VERSION &&
      current.applicationPrincipalName
    ) {
      await this.provisionManagedPrincipalV2(current, owner, writer, current.applicationPrincipalName, current.id);
    } else {
      await this.provisionClickHousePrincipal(current, owner, writer, 'writer');
    }
    await this.provisionClickHousePrincipal(current, owner, reader, 'reader');

    if (current.clickhouseQueryPrincipalVersion !== CLICKHOUSE_QUERY_PRINCIPAL_VERSION) {
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          clickhouseQueryPrincipalVersion: CLICKHOUSE_QUERY_PRINCIPAL_VERSION,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, current.id))
        .returning();
      current = updated!;
    }

    if (credentialsChanged && current.databaseConnectionId && this.databaseConnectionService) {
      await this.databaseConnectionService.disposeClient(current.databaseConnectionId);
    }
    return current;
  }

  protected async ensureDirectAccessCredentials(
    row: ManagedDatabaseRow,
    userId: string | null,
    provision = true
  ): Promise<{ row: ManagedDatabaseRow; credentials: OwnerCredentials }> {
    const owner = this.ownerCredentials(row);
    const existing = this.directAccessCredentials(row);
    if (existing) {
      if (provision) {
        await this.provisionDirectAccessPrincipal(row, owner, existing);
      }
      return { row, credentials: existing };
    }
    const credentials = newDirectAccessCredentials(row.type, owner.databaseName);
    if (provision) await this.provisionDirectAccessPrincipal(row, owner, credentials);
    const [updated] = await this.db
      .update(managedDatabaseInstances)
      .set({
        encryptedDirectCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials))),
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    return { row: updated!, credentials };
  }

  protected async provisionDirectAccessPrincipal(
    row: ManagedDatabaseRow,
    owner: OwnerCredentials,
    credentials: OwnerCredentials
  ) {
    if (row.bindingIdentityVersion === MANAGED_DATABASE_BINDING_IDENTITY_VERSION && row.applicationPrincipalName) {
      return this.provisionManagedPrincipalV2(row, owner, credentials, row.applicationPrincipalName, row.id);
    }
    if (row.type === 'clickhouse') {
      return this.provisionClickHousePrincipal(row, owner, credentials, 'writer');
    }
    const result = await this.nodeDispatch.sendDockerDatabaseCommand(
      row.nodeId,
      'binding_create',
      row.id,
      JSON.stringify({
        bindingId: row.id,
        username: credentials.username,
        password: credentials.password,
        databaseName: credentials.databaseName ?? 'redis',
        ownerUsername: owner.username,
        ownerPassword: owner.password,
      })
    );
    if (!result.success) {
      throw new AppError(
        503,
        'MANAGED_DATABASE_DIRECT_ACCESS_UNAVAILABLE',
        'Direct-access credentials could not be configured'
      );
    }
  }

  protected async provisionClickHousePrincipal(
    row: ManagedDatabaseRow,
    owner: OwnerCredentials,
    credentials: OwnerCredentials,
    principalType: 'reader' | 'writer'
  ) {
    const result = await this.nodeDispatch.sendDockerDatabaseCommand(
      row.nodeId,
      'clickhouse_principal_apply_v1',
      row.id,
      JSON.stringify({
        principalType,
        username: credentials.username,
        password: credentials.password,
        databaseName: credentials.databaseName ?? 'app',
        ownerUsername: owner.username,
        ownerPassword: owner.password,
      })
    );
    if (!result.success) {
      throw new AppError(
        503,
        'MANAGED_CLICKHOUSE_QUERY_PRINCIPAL_UNAVAILABLE',
        'Managed ClickHouse query access is unavailable until the database daemon supports secure query principals'
      );
    }
  }

  /**
   * Docker returns the selected ephemeral port in the normal lifecycle detail.
   * Treat that as an optimisation only: a reconnecting daemon can acknowledge
   * the operation with an empty detail, while the container itself is already
   * running. In that case inspect its durable record before exposing ready
   * state, otherwise the controller would mistakenly persist TCP as disabled.
   */
  protected async resolvePublishedPort(
    row: ManagedDatabaseRow,
    publishTcp: boolean,
    result: { detail?: string }
  ): Promise<number | null> {
    const returned = allocatedPublishedPort(result);
    if (returned !== null) return returned;
    if (!publishTcp) return null;
    if (row.publishedPort !== null) return row.publishedPort;

    const inspected = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
    const inspectedPort = inspected.success ? allocatedPublishedPort(inspected) : null;
    if (inspectedPort !== null) return inspectedPort;
    throw new AppError(
      503,
      'MANAGED_DATABASE_PUBLICATION_UNCONFIRMED',
      'Managed database started, but its published TCP port could not be confirmed'
    );
  }

  protected async resolvePublishedNativePort(
    row: ManagedDatabaseRow,
    publishNativeTcp: boolean,
    result: { detail?: string }
  ): Promise<number | null> {
    if (row.type !== 'clickhouse' || !publishNativeTcp) return null;
    const returned = allocatedPublishedNativePort(result);
    if (returned !== null) return returned;
    if (row.publishedNativePort !== null) return row.publishedNativePort;
    const inspected = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
    const inspectedPort = inspected.success ? allocatedPublishedNativePort(inspected) : null;
    if (inspectedPort !== null) return inspectedPort;
    throw new AppError(
      503,
      'MANAGED_DATABASE_NATIVE_PUBLICATION_UNCONFIRMED',
      'Managed ClickHouse started, but its published native TCP port could not be confirmed'
    );
  }

  protected async syncCanonicalConnectionCredentials(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    userId: string | null
  ) {
    if (!row.databaseConnectionId) return;
    const config = managedConnectionConfig(row.type, credentials, row.tlsEnabled);
    await this.db
      .update(databaseConnections)
      .set({
        host: config.host,
        port: config.port,
        databaseName: config.type === 'redis' ? `db${config.db}` : config.database,
        username: config.username ?? null,
        tlsEnabled: config.type === 'postgres' ? config.sslEnabled : config.tlsEnabled,
        encryptedConfig: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(config))),
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(databaseConnections.id, row.databaseConnectionId));
  }

  protected async syncCanonicalConnectionName(row: ManagedDatabaseRow, previousName: string): Promise<void> {
    if (!row.databaseConnectionId || row.name === previousName) return;
    const [connection] = await this.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, row.databaseConnectionId))
      .limit(1);
    if (!connection) return;
    const update = async (slug?: string) => {
      const [updated] = await this.db
        .update(databaseConnections)
        .set({ name: row.name, updatedById: row.updatedById, updatedAt: new Date(), ...(slug ? { slug } : {}) })
        .where(eq(databaseConnections.id, connection.id))
        .returning();
      return updated!;
    };
    const updated = await writeWithAllocatedSlug({
      source: row.name,
      fallback: 'database',
      constraint: 'database_connections_slug_unique',
      write: update,
    });
    this.eventBus?.publish('database.changed', {
      id: updated.id,
      action: 'updated',
      name: updated.name,
      type: updated.type,
      ...(updated.slug === connection.slug ? {} : { oldSlug: connection.slug, slug: updated.slug }),
    });
  }

  protected async syncCanonicalConnectionStorageLimit(row: ManagedDatabaseRow): Promise<void> {
    if (!row.databaseConnectionId || row.type !== 'postgres') return;
    await this.db
      .update(databaseConnections)
      .set({
        manualSizeLimitMb: Math.round(Number(row.storageSizeBytes) / MEBIBYTE),
        updatedById: row.updatedById,
        updatedAt: new Date(),
      })
      .where(eq(databaseConnections.id, row.databaseConnectionId));
  }

  protected async syncCanonicalConnectionTags(row: ManagedDatabaseRow, tags: string[] | undefined): Promise<void> {
    if (!row.databaseConnectionId || tags === undefined) return;
    await this.db
      .update(databaseConnections)
      .set({ tags, updatedById: row.updatedById, updatedAt: new Date() })
      .where(eq(databaseConnections.id, row.databaseConnectionId));
  }
}
