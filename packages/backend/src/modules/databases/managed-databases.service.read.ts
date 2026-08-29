import { and, asc, eq, isNull } from 'drizzle-orm';
import { managedDatabaseBindings, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { ManagedDatabaseListQuery } from './databases.schemas.js';

import {
  MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
  MANAGED_DATABASE_CATALOG,
  type ManagedDatabaseLogOptions,
  type ManagedDatabaseLogTarget,
  type ManagedDatabaseRow,
  managedDatabaseServiceAddresses,
  safeManagedDatabaseView,
} from './managed-databases.service.core.js';
import { ManagedDatabaseLifecycleService } from './managed-databases.service.lifecycle.js';

export class ManagedDatabaseReadService extends ManagedDatabaseLifecycleService {
  listCatalog() {
    return Object.entries(MANAGED_DATABASE_CATALOG).map(([type, versions]) => ({
      type,
      versions: Object.keys(versions),
    }));
  }

  async list(query: ManagedDatabaseListQuery = {}) {
    const conditions = [];
    if (query.nodeId) conditions.push(eq(managedDatabaseInstances.nodeId, query.nodeId));
    if (query.type) conditions.push(eq(managedDatabaseInstances.type, query.type));
    const rows = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(managedDatabaseInstances.name));
    return rows.map(safeManagedDatabaseView);
  }

  async get(id: string) {
    let row = await this.getRow(id);
    // The deploy wizard polls this endpoint while its loader is visible. Use
    // that poll to converge a response lost during daemon reconnect, instead
    // of making the user wait for the background reconciliation interval.
    if (row.pendingOperation) {
      await this.reconcilePendingRow(row);
      row = await this.getRow(id);
    }
    return safeManagedDatabaseView(row);
  }

  async getByDatabaseConnectionId(databaseConnectionId: string) {
    const [row] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    return row ? safeManagedDatabaseView(row) : null;
  }

  async getCanonicalScopeResourceId(id: string): Promise<string> {
    const row = await this.getRow(id);
    if (!row.databaseConnectionId) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_CONNECTION_UNAVAILABLE',
        'Managed database is missing its canonical database connection'
      );
    }
    return row.databaseConnectionId;
  }

  async resolveLogTarget(databaseConnectionId: string): Promise<ManagedDatabaseLogTarget> {
    const row = await this.getRowByDatabaseConnectionId(databaseConnectionId);
    const inspected = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
    if (!inspected.success) {
      throw new AppError(409, 'MANAGED_DATABASE_LOGS_UNAVAILABLE', inspected.error || 'Database logs are unavailable');
    }
    let detail: { containerId?: unknown } = {};
    try {
      detail = JSON.parse(inspected.detail || '{}') as { containerId?: unknown };
    } catch {
      throw new AppError(502, 'MANAGED_DATABASE_INVALID_RESPONSE', 'Database node returned an invalid log target');
    }
    const containerId = typeof detail.containerId === 'string' ? detail.containerId : '';
    if (!containerId) {
      throw new AppError(409, 'MANAGED_DATABASE_LOGS_UNAVAILABLE', 'Database container is not available');
    }
    return { managedDatabaseId: row.id, nodeId: row.nodeId, containerId };
  }

  async getLogs(databaseConnectionId: string, options: ManagedDatabaseLogOptions = {}): Promise<string[]> {
    const row = await this.getRowByDatabaseConnectionId(databaseConnectionId);
    const result = await this.nodeDispatch.sendManagedDatabaseLogsCommand(row.nodeId, row.id, options);
    if (!result.success) {
      throw new AppError(409, 'MANAGED_DATABASE_LOGS_UNAVAILABLE', result.error || 'Database logs are unavailable');
    }
    try {
      const lines = JSON.parse(result.detail || '[]') as unknown;
      return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string') : [];
    } catch {
      throw new AppError(502, 'MANAGED_DATABASE_INVALID_RESPONSE', 'Database node returned invalid logs');
    }
  }

  /**
   * Backfill missing canonical database resources and restore their internal
   * owner credentials. Direct-access and scoped query accounts are separate
   * principals; the canonical owner remains reserved for administrative and
   * internal control-plane operations.
   */
  async reconcileDatabaseConnections() {
    const rows = await this.db.select().from(managedDatabaseInstances);
    for (const row of rows) {
      const ownerCredentials = this.ownerCredentials(row);
      if (!row.databaseConnectionId) {
        const connection = await this.createCanonicalConnection(
          row.name,
          row.type,
          ownerCredentials,
          row.storageSizeBytes,
          row.createdById,
          [],
          row.tlsEnabled
        );
        await this.db
          .update(managedDatabaseInstances)
          .set({ databaseConnectionId: connection.id, updatedAt: new Date() })
          .where(eq(managedDatabaseInstances.id, row.id));
        this.emit({ ...row, databaseConnectionId: connection.id }, 'connection.backfilled');
        continue;
      }
      await this.syncCanonicalConnectionCredentials(row, ownerCredentials, null);
    }
  }

  /**
   * Converge all managed ClickHouse identities through the versioned daemon
   * action. This is invoked only after a database daemon has connected, so an
   * unavailable/older daemon cannot trigger a legacy binding_create fallback.
   */
  async reconcileClickHouseQueryPrincipals(nodeId?: string) {
    const [rows, legacyBindingDatabaseIds] = await Promise.all([
      this.db.select().from(managedDatabaseInstances),
      this.legacyBindingDatabaseIds(),
    ]);
    let failures = 0;
    for (const row of rows) {
      if (
        row.type !== 'clickhouse' ||
        legacyBindingDatabaseIds.has(row.id) ||
        row.status !== 'ready' ||
        row.pendingOperation ||
        (nodeId !== undefined && row.nodeId !== nodeId)
      ) {
        continue;
      }
      try {
        let current = row;
        if (current.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
          current = await this.ensureBindingIdentity(current.id, null);
        }
        await this.reconcileClickHouseOwnerCredentials(current);
        current = await this.ensureClickHouseQueryPrincipals(current, null);
        if (current.ownerSeparationState !== 'active') {
          await this.finalizeBindingIdentity(current.id, null);
        }
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      throw new Error(`Failed to reconcile ${failures} ClickHouse query principal(s)`);
    }
  }

  async reconcileBindingIdentities(nodeId?: string) {
    const [rows, legacyBindingDatabaseIds] = await Promise.all([
      this.db.select().from(managedDatabaseInstances),
      this.legacyBindingDatabaseIds(),
    ]);
    let failures = 0;
    for (const row of rows) {
      if (
        legacyBindingDatabaseIds.has(row.id) ||
        row.status !== 'ready' ||
        row.pendingOperation ||
        (nodeId !== undefined && row.nodeId !== nodeId)
      ) {
        continue;
      }
      try {
        let current = row;
        if (current.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
          current = await this.ensureBindingIdentity(current.id, null);
        }
        if (current.type === 'clickhouse') {
          await this.reconcileClickHouseOwnerCredentials(current);
          current = await this.ensureClickHouseQueryPrincipals(current, null);
        }
        if (current.ownerSeparationState !== 'active') {
          await this.finalizeBindingIdentity(current.id, null);
        }
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      throw new Error(`Failed to reconcile ${failures} managed database identity record(s)`);
    }
  }

  protected async reconcileBindingIdentitiesForNode(nodeId: string) {
    if (this.bindingIdentityReconciliationNodes.has(nodeId)) return;
    this.bindingIdentityReconciliationNodes.add(nodeId);
    try {
      await this.reconcileBindingIdentities(nodeId);
    } finally {
      this.bindingIdentityReconciliationNodes.delete(nodeId);
    }
  }

  protected async reconcileClickHouseOwnerCredentials(row: ManagedDatabaseRow): Promise<void> {
    if (row.type !== 'clickhouse' || row.ownerSeparationState !== 'active' || !row.applicationPrincipalName) return;
    const owner = this.ownerCredentials(row);
    this.requireDatabaseCommandSuccess(
      await this.nodeDispatch.sendDockerDatabaseCommand(
        row.nodeId,
        'owner_separation_finalize_v1',
        row.id,
        JSON.stringify({
          operationId: row.id,
          databaseName: owner.databaseName ?? 'app',
          applicationPrincipalName: row.applicationPrincipalName,
          currentOwnerUsername: owner.username,
          currentOwnerPassword: owner.password,
          pendingOwnerUsername: owner.username,
          pendingOwnerPassword: owner.password,
        })
      ),
      'Managed ClickHouse owner credentials could not be reconciled'
    );
  }

  protected async legacyBindingDatabaseIds(): Promise<Set<string>> {
    const bindings = await this.db
      .select({
        managedDatabaseId: managedDatabaseBindings.managedDatabaseId,
        principalModelVersion: managedDatabaseBindings.principalModelVersion,
      })
      .from(managedDatabaseBindings);
    return new Set(
      bindings
        .filter(({ principalModelVersion }) => principalModelVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION)
        .map(({ managedDatabaseId }) => managedDatabaseId)
    );
  }

  /** Backfill certificates for instances created before direct TLS existed. */
  async reconcileDatabaseCertificates() {
    if (!this.databaseCA) return;
    const rows = await this.db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        certificateId: managedDatabaseInstances.certificateId,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
        capabilities: nodes.capabilities,
      })
      .from(managedDatabaseInstances)
      .innerJoin(nodes, eq(nodes.id, managedDatabaseInstances.nodeId))
      .where(isNull(managedDatabaseInstances.certificateId));
    for (const row of rows) {
      const serviceAddresses = managedDatabaseServiceAddresses(row);
      if (serviceAddresses.length === 0) continue;
      await this.databaseCA.issueManagedDatabaseCertificate(row.id, serviceAddresses, async (tx, certificate) => {
        const updated = await tx
          .update(managedDatabaseInstances)
          .set({ certificateId: certificate.id, updatedAt: new Date() })
          .where(and(eq(managedDatabaseInstances.id, row.id), isNull(managedDatabaseInstances.certificateId)))
          .returning({ id: managedDatabaseInstances.id });
        if (updated.length !== 1) throw new Error('Managed database certificate owner binding was not claimed');
      });
    }
  }

  async warmReadyPostgresExtensionCatalogs() {
    if (!this.databaseConnectionService) return;
    const rows = await this.db.select().from(managedDatabaseInstances);
    for (const row of rows) {
      if (row.type !== 'postgres' || row.status !== 'ready' || !row.databaseConnectionId) continue;
      await this.warmPostgresExtensionCatalog(row);
    }
  }
}
