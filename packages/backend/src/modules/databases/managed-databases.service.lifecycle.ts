import crypto from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { databaseConnections, managedDatabaseInstances } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

import {
  allocatedPublishedPort,
  daemonCreateConfig,
  daemonState,
  logger,
  MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
  type ManagedDatabaseOperation,
  type ManagedDatabaseRow,
  managedDatabasePublishNativeTcp,
  managedDatabasePublishTcp,
  type OwnerCredentials,
  parseEncryptedCredentials,
  safeManagedDatabaseView,
} from './managed-databases.service.core.js';
import { ManagedDatabaseIdentityService } from './managed-databases.service.identity.js';

export abstract class ManagedDatabaseLifecycleService extends ManagedDatabaseIdentityService {
  protected dispatchCreate(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ) {
    const operation = this.pendingOperation(row, 'create');
    return this.runDatabaseOperationDispatch(row.id, operation, (current) =>
      this.dispatchCreateUnlocked(current, credentials, publishTcp, publishNativeTcp, userId)
    );
  }

  protected async dispatchCreateUnlocked(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ) {
    const operation = this.pendingOperation(row, 'create');
    const direct =
      row.type === 'clickhouse' || !publishTcp ? null : await this.ensureDirectAccessCredentials(row, userId, false);
    const configJson = JSON.stringify(
      await daemonCreateConfig(row, credentials, publishTcp, publishNativeTcp, operation.id, this.databaseCA)
    );
    let result: Awaited<ReturnType<NodeDispatchService['sendDockerDatabaseCommand']>>;
    try {
      result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'create', row.id, configJson);
    } catch {
      return this.markOutcomeUnknown(row);
    }
    if (!result.success) return this.markError(row, 'create', result.error);
    try {
      let current = direct?.row ?? row;
      if (current.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
        current = await this.ensureBindingIdentity(current.id, userId);
      }
      if (current.type === 'clickhouse') {
        current = await this.ensureClickHouseQueryPrincipals(current, userId);
      }
      if (current.ownerSeparationState !== 'active') {
        current = await this.finalizeBindingIdentity(current.id, userId, operation.id);
      }
      const publishedPort = await this.resolvePublishedPort(current, publishTcp, result);
      const publishedNativePort = await this.resolvePublishedNativePort(current, publishNativeTcp, result);
      return this.markReady(current, operation, userId, publishedPort, 'ready', publishedNativePort, true);
    } catch (error) {
      logger.warn('Managed database create completion will be reconciled after daemon success', {
        managedDatabaseId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.markOutcomeUnknown(row);
    }
  }

  protected dispatchUpdate(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ) {
    const operation = this.pendingOperation(row, 'update');
    return this.runDatabaseOperationDispatch(row.id, operation, (current) =>
      this.dispatchUpdateUnlocked(current, credentials, publishTcp, publishNativeTcp, userId)
    );
  }

  protected async dispatchUpdateUnlocked(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ) {
    const operation = this.pendingOperation(row, 'update');
    const direct =
      row.type === 'clickhouse' || !publishTcp ? null : await this.ensureDirectAccessCredentials(row, userId, false);
    const configJson = JSON.stringify(
      await daemonCreateConfig(row, credentials, publishTcp, publishNativeTcp, operation.id, this.databaseCA)
    );
    let result: Awaited<ReturnType<NodeDispatchService['sendDockerDatabaseCommand']>>;
    try {
      result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'update', row.id, configJson);
    } catch {
      return this.markOutcomeUnknown(row);
    }
    if (!result.success) return this.markError(row, 'update', result.error);
    try {
      let current = direct?.row ?? row;
      if (current.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
        current = await this.ensureBindingIdentity(current.id, userId);
      }
      if (current.type === 'clickhouse') {
        current = await this.ensureClickHouseQueryPrincipals(current, userId);
      }
      if (current.ownerSeparationState !== 'active') {
        current = await this.finalizeBindingIdentity(current.id, userId, operation.id);
      }
      const publishedPort = await this.resolvePublishedPort(current, publishTcp, result);
      const publishedNativePort = await this.resolvePublishedNativePort(current, publishNativeTcp, result);
      return this.markReady(
        current,
        operation,
        userId,
        publishedPort,
        'ready',
        publishedNativePort,
        true,
        true,
        'database.managed.update'
      );
    } catch (error) {
      logger.warn('Managed database update completion will be reconciled after daemon success', {
        managedDatabaseId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.markOutcomeUnknown(row);
    }
  }

  protected async dispatchDelete(row: ManagedDatabaseRow, userId: string | null) {
    this.pendingOperation(row, 'delete');
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(
        row.nodeId,
        'remove',
        row.id,
        JSON.stringify({ operationId: row.pendingOperation!.id })
      );
      if (!result.success) return this.markError(row, 'delete', result.error);
    } catch {
      return this.markOutcomeUnknown(row);
    }
    await this.completeDelete(row, userId);
    return { success: true };
  }

  protected async reconcilePendingRow(row: ManagedDatabaseRow) {
    const operation = row.pendingOperation;
    if (!operation) return;
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
      if (!result.success) return;
      const state = daemonState(result);
      if (!state) return;
      if (state.status === 'missing' && operation.action === 'delete') {
        return this.completeDelete(row, null);
      }
      // Daemon commands are handled asynchronously. An inspect can acquire
      // the database mutex before an earlier mutation, so missing or stale
      // operation IDs are not a terminal outcome. Replay the *same* durable
      // operation ID instead: create/update are idempotent on it and remove
      // is idempotent for a missing record.
      if (state.status === 'missing' || state.operationId !== operation.id) {
        await this.replayPendingOperation(row);
        return;
      }
      if (operation.action === 'delete') {
        await this.dispatchDelete(row, null);
        return;
      }
      if (operation.action === 'pause' || operation.action === 'unpause') {
        const expectedStatus = operation.action === 'pause' ? 'paused' : 'ready';
        if (state.status !== expectedStatus) {
          await this.replayPendingOperation(row);
          return;
        }
        await this.completeLifecycleTransition(row, null, expectedStatus, operation.action);
        return;
      }
      if (state.status === 'paused') {
        await this.replayPendingOperation(row);
        return;
      }
      // A create/update may have reached Docker before the controller lost its
      // response. Direct principals are for published client access only;
      // Gateway's canonical connection always keeps the internal owner.
      const direct =
        row.type === 'clickhouse' || !managedDatabasePublishTcp(row)
          ? null
          : await this.ensureDirectAccessCredentials(row, null);
      let current = direct?.row ?? row;
      if (current.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
        current = await this.ensureBindingIdentity(current.id, null);
      }
      if (current.type === 'clickhouse') {
        current = await this.ensureClickHouseQueryPrincipals(current, null);
      }
      if (current.ownerSeparationState !== 'active') {
        current = await this.finalizeBindingIdentity(current.id, null, operation.id);
      }
      // Inspect is also the recovery source of truth for an auto-assigned
      // host port when the original create/update response was lost.
      await this.markReady(
        current,
        operation,
        null,
        allocatedPublishedPort(result) ?? row.publishedPort,
        state.status,
        current.publishedNativePort,
        true,
        operation.action === 'update'
      );
    } catch {
      // The node is offline or the inspect response is still unavailable.
      // Keep the durable pending operation for the next scheduled pass.
    }
  }

  protected async replayPendingOperation(row: ManagedDatabaseRow) {
    if (this.databaseCA) {
      const node = await this.assertDatabaseNode(row.nodeId);
      row = await this.ensureManagedDatabaseCertificate(row, node);
    }
    const operation = this.pendingOperation(row, row.pendingOperation!.action);
    if (operation.action === 'delete') return this.dispatchDelete(row, null);
    if (operation.action === 'pause' || operation.action === 'unpause') {
      return this.dispatchLifecycleTransition(
        row,
        null,
        operation.action,
        operation.action === 'pause' ? 'paused' : 'ready'
      );
    }
    const credentials = JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
    ) as OwnerCredentials;
    if (operation.action === 'create') {
      return this.dispatchCreate(
        row,
        credentials,
        managedDatabasePublishTcp(row),
        managedDatabasePublishNativeTcp(row),
        null
      );
    }
    if (operation.action === 'restart') return this.dispatchRestart(row, credentials, null);
    return this.dispatchUpdate(
      row,
      credentials,
      managedDatabasePublishTcp(row),
      managedDatabasePublishNativeTcp(row),
      null
    );
  }

  protected pendingOperation(row: ManagedDatabaseRow, action: ManagedDatabaseOperation['action']) {
    if (!row.pendingOperation || row.pendingOperation.action !== action) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation does not match its pending state'
      );
    }
    return row.pendingOperation;
  }

  protected requireOperationClaim(row: ManagedDatabaseRow | undefined): ManagedDatabaseRow {
    if (row) return row;
    throw new AppError(
      409,
      'MANAGED_DATABASE_OPERATION_PENDING',
      'Managed database operation is still being reconciled'
    );
  }

  protected pendingOperationCondition(id: string, operation: ManagedDatabaseOperation) {
    return and(
      eq(managedDatabaseInstances.id, id),
      sql`${managedDatabaseInstances.pendingOperation}->>'id' = ${operation.id}`,
      sql`${managedDatabaseInstances.pendingOperation}->>'action' = ${operation.action}`
    );
  }

  protected async staleOperationResult(row: ManagedDatabaseRow) {
    const current = await this.getRow(row.id).catch(() => row);
    return safeManagedDatabaseView(current);
  }

  protected runDatabaseOperationDispatch<T>(
    managedDatabaseId: string,
    operation: ManagedDatabaseOperation,
    dispatch: (current: ManagedDatabaseRow) => Promise<T>
  ): Promise<T> {
    const key = `${managedDatabaseId}:${operation.action}:${operation.id}`;
    const existing = this.databaseOperationDispatches.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = (async () => {
      let started: Promise<T> | undefined;
      const stale = await this.withBindingIdentityOperation(managedDatabaseId, async () => {
        const current = await this.getRow(managedDatabaseId);
        if (current.pendingOperation?.id !== operation.id || current.pendingOperation.action !== operation.action) {
          return current;
        }
        // Start the daemon dispatch while the lifecycle gate is still held,
        // but do not await its completion here: completion paths acquire the
        // same gate for their final compare-and-set.
        started = dispatch(current);
        return null;
      });
      if (stale) return safeManagedDatabaseView(stale) as T;
      return started!;
    })().finally(() => {
      if (this.databaseOperationDispatches.get(key) === pending) {
        this.databaseOperationDispatches.delete(key);
      }
    });
    this.databaseOperationDispatches.set(key, pending);
    return pending;
  }

  protected async beginLifecycleTransition(
    id: string,
    userId: string,
    action: 'pause' | 'unpause',
    requiredStatus: 'ready' | 'paused',
    targetStatus: 'ready' | 'paused'
  ) {
    const claimed = await this.withBindingIdentityOperation(id, async () => {
      const row = await this.getRow(id);
      if (row.pendingOperation) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_OPERATION_PENDING',
          'Managed database operation is still being reconciled'
        );
      }
      if (row.status !== requiredStatus) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_INVALID_LIFECYCLE_STATE',
          `Managed database must be ${requiredStatus} before it can be ${targetStatus}`
        );
      }
      await this.assertDatabaseNode(row.nodeId);
      const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action };
      const [pending] = await this.db
        .update(managedDatabaseInstances)
        .set({
          status: 'updating',
          pendingOperation,
          lastError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedDatabaseInstances.id, id),
            eq(managedDatabaseInstances.status, requiredStatus),
            isNull(managedDatabaseInstances.pendingOperation)
          )
        )
        .returning();
      return this.requireOperationClaim(pending);
    });
    this.emit(claimed, `${action}.started`);
    return this.dispatchLifecycleTransition(claimed, userId, action, targetStatus);
  }

  protected async dispatchLifecycleTransition(
    row: ManagedDatabaseRow,
    userId: string | null,
    action: 'pause' | 'unpause',
    targetStatus: 'ready' | 'paused'
  ) {
    const operation = this.pendingOperation(row, action);
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(
        row.nodeId,
        action,
        row.id,
        JSON.stringify({ operationId: operation.id })
      );
      if (!result.success) return this.markError(row, action, result.error);
      const state = daemonState(result);
      if (!state || state.status !== targetStatus || state.operationId !== operation.id) {
        return this.markOutcomeUnknown(row);
      }
      return this.completeLifecycleTransition(row, userId, targetStatus, action);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  protected async completeLifecycleTransition(
    row: ManagedDatabaseRow,
    userId: string | null,
    status: 'ready' | 'paused',
    action: 'pause' | 'unpause'
  ) {
    const operation = this.pendingOperation(row, action);
    return this.withBindingIdentityOperation(row.id, async () => {
      const fresh = await this.getRow(row.id);
      if (fresh.pendingOperation?.id !== operation.id || fresh.pendingOperation.action !== operation.action) {
        return safeManagedDatabaseView(fresh);
      }
      const principalCurrent =
        action === 'unpause' && fresh.type === 'clickhouse'
          ? await this.ensureClickHouseQueryPrincipals(fresh, userId)
          : fresh;
      const [updated] = await this.db
        .update(managedDatabaseInstances)
        .set({
          status,
          pendingOperation: null,
          lastError: null,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(this.pendingOperationCondition(principalCurrent.id, operation))
        .returning();
      if (!updated) return this.staleOperationResult(principalCurrent);
      if (userId) {
        try {
          await this.auditService.log({
            userId,
            action: `database.managed.${action}`,
            resourceType: 'managed_database',
            resourceId: row.id,
            details: { name: updated.name, type: updated.type },
          });
        } catch (error) {
          logger.warn('Failed to audit completed managed database lifecycle transition', {
            managedDatabaseId: row.id,
            action,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await this.warmPostgresExtensionCatalog(updated);
      this.emit(updated, status);
      return safeManagedDatabaseView(updated);
    });
  }

  protected async markReady(
    row: ManagedDatabaseRow,
    operation: ManagedDatabaseOperation,
    userId: string | null,
    publishedPort: number | null,
    status: 'ready' | 'stopped' = 'ready',
    publishedNativePort: number | null = row.publishedNativePort,
    syncCanonicalCredentials = false,
    syncCanonicalStorage = false,
    auditAction?: string
  ) {
    return this.withBindingIdentityOperation(row.id, async () => {
      const current = await this.getRow(row.id);
      if (current.pendingOperation?.id !== operation.id || current.pendingOperation.action !== operation.action) {
        return safeManagedDatabaseView(current);
      }
      if (syncCanonicalCredentials) {
        await this.syncCanonicalConnectionCredentials(current, this.ownerCredentials(current), userId);
      }
      if (syncCanonicalStorage) {
        await this.syncCanonicalConnectionStorageLimit(current);
      }
      const [ready] = await this.db
        .update(managedDatabaseInstances)
        .set({
          status,
          pendingOperation: null,
          lastError: null,
          publishedPort,
          publishedNativePort,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(this.pendingOperationCondition(row.id, operation))
        .returning();
      if (!ready) return this.staleOperationResult(current);
      if (auditAction && userId) {
        try {
          await this.auditService.log({
            userId,
            action: auditAction,
            resourceType: 'managed_database',
            resourceId: ready.id,
            details: { name: ready.name, type: ready.type },
          });
        } catch (error) {
          logger.warn('Failed to audit completed managed database operation', {
            managedDatabaseId: ready.id,
            action: auditAction,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await this.warmPostgresExtensionCatalog(ready);
      this.emit(ready, status);
      return safeManagedDatabaseView(ready);
    });
  }

  protected async markOutcomeUnknown(row: ManagedDatabaseRow) {
    const operation = this.pendingOperation(row, row.pendingOperation!.action);
    return this.withBindingIdentityOperation(row.id, async () => {
      const [pending] = await this.db
        .update(managedDatabaseInstances)
        .set({ lastError: 'Managed database operation outcome is being reconciled', updatedAt: new Date() })
        .where(this.pendingOperationCondition(row.id, operation))
        .returning();
      if (!pending) return this.staleOperationResult(row);
      this.emit(pending, 'reconciling');
      return safeManagedDatabaseView(pending);
    });
  }

  protected async warmPostgresExtensionCatalog(row: ManagedDatabaseRow) {
    if (
      row.type !== 'postgres' ||
      row.status !== 'ready' ||
      !row.databaseConnectionId ||
      !this.databaseConnectionService
    ) {
      return;
    }
    await this.databaseConnectionService.warmManagedPostgresExtensionCatalog(row.databaseConnectionId).catch(() => {});
  }

  protected async dispatchRestart(row: ManagedDatabaseRow, credentials: OwnerCredentials, userId: string | null) {
    const operation = this.pendingOperation(row, 'restart');
    const configJson = JSON.stringify(
      await daemonCreateConfig(
        row,
        credentials,
        managedDatabasePublishTcp(row),
        managedDatabasePublishNativeTcp(row),
        operation.id,
        this.databaseCA
      )
    );
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'restart', row.id, configJson);
      if (!result.success) return this.markError(row, 'restart', result.error);
      const current = row.type === 'clickhouse' ? await this.ensureClickHouseQueryPrincipals(row, userId) : row;
      return this.markReady(current, operation, userId, current.publishedPort, 'ready', current.publishedNativePort);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  protected async markError(row: ManagedDatabaseRow, operation: ManagedDatabaseOperation['action'], detail?: string) {
    const pendingOperation = this.pendingOperation(row, operation);
    const sanitizedDetail = detail
      ?.replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 480);
    const [failed] = await this.db
      .update(managedDatabaseInstances)
      .set({
        status: 'error',
        pendingOperation: null,
        lastError: sanitizedDetail
          ? `Managed database ${operation} failed: ${sanitizedDetail}`
          : `Managed database ${operation} failed`,
        updatedAt: new Date(),
      })
      .where(this.pendingOperationCondition(row.id, pendingOperation))
      .returning();
    if (!failed) return this.staleOperationResult(row);
    this.emit(failed, 'error');
    return safeManagedDatabaseView(failed);
  }

  protected async completeDelete(row: ManagedDatabaseRow, userId: string | null) {
    const operation = this.pendingOperation(row, 'delete');
    // This point is reached only after the daemon has confirmed its delete.
    // Make the durable owner deletion and retirement one transaction so a DB
    // failure cannot revoke a leaf that is still attached to an owner row.
    const deleted = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(managedDatabaseInstances)
        .where(eq(managedDatabaseInstances.id, row.id))
        .for('update');
      if (
        !current ||
        current.pendingOperation?.id !== operation.id ||
        current.pendingOperation.action !== operation.action
      ) {
        return false;
      }
      await this.databaseCA?.retireManagedDatabaseCertificates(row.id, tx);
      await tx.delete(managedDatabaseInstances).where(this.pendingOperationCondition(row.id, operation));
      return true;
    });
    if (!deleted) return false;
    if (row.databaseConnectionId && this.databaseConnectionService) {
      await this.databaseConnectionService.disposeClient(row.databaseConnectionId);
    }
    await this.databaseCA?.retryPendingSystemCRLs();
    if (row.databaseConnectionId) {
      await this.db.delete(databaseConnections).where(eq(databaseConnections.id, row.databaseConnectionId));
    }
    await this.auditService.log({
      userId,
      action: 'database.managed.delete',
      resourceType: 'managed_database',
      resourceId: row.id,
      details: { name: row.name, type: row.type },
    });
    this.emit({ ...row, status: 'deleting' }, 'deleted');
    return true;
  }
}
