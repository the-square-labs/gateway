import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { ManagedDatabaseEngineConfig } from '@/db/schema/databases.js';
import { databaseConnections, managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { CreateManagedDatabaseInput, UpdateManagedDatabaseInput } from './databases.schemas.js';

import {
  catalogImage,
  DEFAULT_MANAGED_REDIS_CONFIG,
  GIBIBYTE,
  MANAGED_DATABASE_BINDING_IDENTITY_VERSION,
  type ManagedDatabaseOperation,
  type ManagedDatabaseRow,
  type ManagedDatabaseRuntimeStats,
  MEBIBYTE,
  managedDatabasePublishNativeTcp,
  managedDatabasePublishTcp,
  managedDatabaseServiceAddresses,
  newClickHouseQueryCredentials,
  newDirectAccessCredentials,
  type OwnerCredentials,
  parseEncryptedCredentials,
  parseManagedRuntimeStats,
  storageSizeBytesFromGb,
  validateClickHouseFragment,
} from './managed-databases.service.core.js';
import { ManagedDatabaseReadService } from './managed-databases.service.read.js';

export class ManagedDatabaseMutationService extends ManagedDatabaseReadService {
  async create(input: CreateManagedDatabaseInput, userId: string) {
    // LICENSE ENFORCEMENT: Managed database creation requires Personal under the project license/TOS.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('managed-databases');
    validateClickHouseFragment(input.clickhouseConfigXml);
    const imageRef = catalogImage(input.type, input.version);
    const node = await this.assertDatabaseNode(input.nodeId);
    const credentials: OwnerCredentials = {
      // Redis `requirepass` configures Redis's built-in `default` ACL user.
      // Retaining an invented username here would make revealed direct
      // credentials unusable, so its owner identity is deliberately fixed.
      username: input.type === 'redis' ? 'default' : (input.ownerUsername ?? `${input.type}_owner`),
      password: crypto.randomBytes(32).toString('base64url'),
      ...(input.type === 'redis' ? {} : { databaseName: input.databaseName ?? 'app' }),
    };
    const encryptedOwnerCredentials = JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials)));
    const directCredentials = newDirectAccessCredentials(input.type, credentials.databaseName);
    const encryptedDirectCredentials = JSON.stringify(
      this.cryptoService.encryptString(JSON.stringify(directCredentials))
    );
    const queryCredentials =
      input.type === 'clickhouse' ? newClickHouseQueryCredentials(credentials.databaseName) : null;
    const encryptedQueryCredentials = queryCredentials
      ? JSON.stringify(this.cryptoService.encryptString(JSON.stringify(queryCredentials)))
      : null;
    const runtimeConfig = {
      nanoCPUs: Math.round(input.cpuCores * 1_000_000_000),
      memoryLimitBytes: input.memoryMb * MEBIBYTE,
      memorySwapBytes: (input.memoryMb + input.swapMb) * MEBIBYTE,
    };
    const publishNativeTcp = input.publishTcp && input.type === 'clickhouse' && input.publishNativeTcp !== false;
    const engineConfig = {
      ownerUsername: credentials.username,
      publishTcp: input.publishTcp,
      ...(input.type === 'clickhouse' ? { publishNativeTcp } : {}),
      ...(credentials.databaseName ? { databaseName: credentials.databaseName } : {}),
      ...(input.clickhouseConfigXml ? { clickhouseConfigXml: input.clickhouseConfigXml } : {}),
      ...(input.type === 'redis' ? { redisConfig: input.redisConfig ?? DEFAULT_MANAGED_REDIS_CONFIG } : {}),
    };
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'create' };
    const connection = await this.createCanonicalConnection(
      input.name,
      input.type,
      credentials,
      storageSizeBytesFromGb(input.storageSizeGb),
      userId,
      input.tags,
      input.tlsEnabled
    );
    let row: ManagedDatabaseRow;
    try {
      row = await writeWithAllocatedSlug({
        source: input.name,
        fallback: 'managed-database',
        constraint: 'managed_database_instances_slug_unique',
        write: async (slug) => {
          const [created] = await this.db
            .insert(managedDatabaseInstances)
            .values({
              databaseConnectionId: connection.id,
              nodeId: input.nodeId,
              name: input.name,
              slug,
              type: input.type,
              version: input.version,
              imageRef,
              engineConfig,
              encryptedOwnerCredentials,
              encryptedDirectCredentials,
              encryptedQueryCredentials,
              storageSizeBytes: storageSizeBytesFromGb(input.storageSizeGb),
              runtimeConfig,
              tlsEnabled: input.tlsEnabled,
              publishedPort: input.publishTcp ? (input.publishedPort ?? null) : null,
              publishedNativePort: publishNativeTcp ? (input.publishedNativePort ?? null) : null,
              status: 'creating',
              pendingOperation,
              createdById: userId,
              updatedById: userId,
            })
            .returning();
          return created!;
        },
      });
    } catch (error) {
      await this.db.delete(databaseConnections).where(eq(databaseConnections.id, connection.id));
      throw error;
    }
    try {
      row = await this.ensureManagedDatabaseCertificate(row, node);
    } catch (error) {
      await this.db.delete(managedDatabaseInstances).where(eq(managedDatabaseInstances.id, row.id));
      await this.db.delete(databaseConnections).where(eq(databaseConnections.id, connection.id));
      throw error;
    }
    this.emit(row, 'created');
    await this.auditService.log({
      userId,
      action: 'database.managed.create',
      resourceType: 'managed_database',
      resourceId: row.id,
      details: { name: row.name, type: row.type, version: row.version, nodeId: row.nodeId },
    });

    return this.dispatchCreate(row, credentials, input.publishTcp, publishNativeTcp, userId);
  }

  async update(id: string, input: UpdateManagedDatabaseInput, userId: string) {
    validateClickHouseFragment(input.clickhouseConfigXml);
    let existing = await this.getRow(id);
    if (existing.pendingOperation) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation is still being reconciled'
      );
    }
    if (existing.status === 'paused') {
      throw new AppError(409, 'MANAGED_DATABASE_PAUSED', 'Unpause the managed database before changing its settings');
    }
    if (input.storageSizeGb !== undefined && input.storageSizeGb * GIBIBYTE < Number(existing.storageSizeBytes)) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_STORAGE_REDUCTION_UNSUPPORTED',
        'Managed database storage can only be increased'
      );
    }
    const node = await this.assertDatabaseNode(existing.nodeId);
    existing = await this.ensureManagedDatabaseCertificate(existing, node);
    const nextPublishTcp = input.publishTcp ?? existing.publishedPort !== null;
    if (input.publishNativeTcp !== undefined && existing.type !== 'clickhouse') {
      throw new AppError(
        400,
        'MANAGED_DATABASE_NATIVE_PUBLICATION_UNSUPPORTED',
        'Only ClickHouse has a native TCP endpoint'
      );
    }
    if (input.redisConfig !== undefined && existing.type !== 'redis') {
      throw new AppError(
        400,
        'MANAGED_DATABASE_REDIS_CONFIG_UNSUPPORTED',
        'Redis configuration is only available for Redis'
      );
    }
    if (input.publishNativeTcp && !nextPublishTcp) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_NATIVE_PUBLICATION_REQUIRES_TCP',
        'Publish the ClickHouse TCP endpoint before publishing its native endpoint'
      );
    }
    const nextPublishedPort =
      input.publishTcp === false
        ? null
        : input.publishedPort === undefined
          ? existing.publishedPort
          : input.publishedPort;
    const nextPublishNativeTcp =
      nextPublishTcp &&
      existing.type === 'clickhouse' &&
      (input.publishNativeTcp ?? existing.publishedNativePort !== null);
    const nextPublishedNativePort = !nextPublishNativeTcp
      ? null
      : input.publishedNativePort === undefined
        ? existing.publishedNativePort
        : input.publishedNativePort;
    const nextEngineConfig: ManagedDatabaseEngineConfig = {
      ...existing.engineConfig,
      publishTcp: nextPublishTcp,
      ...(existing.type === 'clickhouse' ? { publishNativeTcp: nextPublishNativeTcp } : {}),
    };
    if (input.clickhouseConfigXml !== undefined) {
      if (input.clickhouseConfigXml) nextEngineConfig.clickhouseConfigXml = input.clickhouseConfigXml;
      else delete nextEngineConfig.clickhouseConfigXml;
    }
    if (input.redisConfig !== undefined) {
      nextEngineConfig.redisConfig = input.redisConfig;
    }
    const next = {
      name: input.name ?? existing.name,
      storageSizeBytes: input.storageSizeGb === undefined ? existing.storageSizeBytes : input.storageSizeGb * GIBIBYTE,
      runtimeConfig: {
        ...existing.runtimeConfig,
        ...(input.cpuCores === undefined ? {} : { nanoCPUs: Math.round(input.cpuCores * 1_000_000_000) }),
        ...(input.memoryMb === undefined ? {} : { memoryLimitBytes: input.memoryMb * MEBIBYTE }),
        ...(input.memoryMb === undefined && input.swapMb === undefined
          ? {}
          : {
              memorySwapBytes:
                ((input.memoryMb ?? Math.round((existing.runtimeConfig.memoryLimitBytes ?? 0) / MEBIBYTE)) +
                  (input.swapMb ??
                    Math.max(
                      0,
                      Math.round(
                        ((existing.runtimeConfig.memorySwapBytes ?? existing.runtimeConfig.memoryLimitBytes ?? 0) -
                          (existing.runtimeConfig.memoryLimitBytes ?? 0)) /
                          MEBIBYTE
                      )
                    ))) *
                MEBIBYTE,
            }),
      },
      tlsEnabled: input.tlsEnabled ?? existing.tlsEnabled,
      publishedPort: nextPublishedPort,
      publishedNativePort: nextPublishedNativePort,
      engineConfig: nextEngineConfig,
    };
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'update' };
    const { claimed, existingCredentials } = await this.withBindingIdentityOperation(id, async () => {
      const current = await this.getRow(id);
      if (current.pendingOperation) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_OPERATION_PENDING',
          'Managed database operation is still being reconciled'
        );
      }
      const credentials = JSON.parse(
        this.cryptoService.decryptString(parseEncryptedCredentials(current.encryptedOwnerCredentials))
      ) as OwnerCredentials;
      const [updating] = await this.db
        .update(managedDatabaseInstances)
        .set({
          ...next,
          updatedById: userId,
          updatedAt: new Date(),
          status: 'updating',
          pendingOperation,
          lastError: null,
        })
        .where(and(eq(managedDatabaseInstances.id, id), isNull(managedDatabaseInstances.pendingOperation)))
        .returning();
      return { claimed: this.requireOperationClaim(updating), existingCredentials: credentials };
    });
    await this.syncCanonicalConnectionName(claimed, existing.name);
    await this.syncCanonicalConnectionTags(claimed, input.tags);
    return this.dispatchUpdate(claimed, existingCredentials, nextPublishTcp, nextPublishNativeTcp, userId);
  }

  async rotateCertificate(id: string, userId: string) {
    const existing = await this.getRow(id);
    if (existing.pendingOperation) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation is still being reconciled'
      );
    }
    if (existing.status === 'paused') {
      throw new AppError(
        409,
        'MANAGED_DATABASE_PAUSED',
        'Unpause the managed database before rotating its certificate'
      );
    }
    if (!this.databaseCA) {
      throw new AppError(503, 'MANAGED_DATABASE_TLS_UNAVAILABLE', 'Managed database TLS is not available');
    }
    const node = await this.assertDatabaseNode(existing.nodeId);
    const serviceAddresses = managedDatabaseServiceAddresses(node);
    if (serviceAddresses.length === 0) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_TLS_IDENTITY_UNAVAILABLE',
        'Database node has no service IP addresses available for the managed TLS certificate'
      );
    }
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'update' };
    const { claimed, credentials } = await this.withBindingIdentityOperation(id, async () => {
      const current = await this.getRow(id);
      if (current.pendingOperation) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_OPERATION_PENDING',
          'Managed database operation is still being reconciled'
        );
      }
      if (current.status === 'paused') {
        throw new AppError(
          409,
          'MANAGED_DATABASE_PAUSED',
          'Unpause the managed database before rotating its certificate'
        );
      }
      const owner = JSON.parse(
        this.cryptoService.decryptString(parseEncryptedCredentials(current.encryptedOwnerCredentials))
      ) as OwnerCredentials;
      let claimedRow: ManagedDatabaseRow | undefined;
      await this.databaseCA!.issueManagedDatabaseCertificate(current.id, serviceAddresses, async (tx, certificate) => {
        const [updating] = await tx
          .update(managedDatabaseInstances)
          .set({
            certificateId: certificate.id,
            status: 'updating',
            pendingOperation,
            lastError: null,
            updatedById: userId,
            updatedAt: new Date(),
          })
          .where(and(eq(managedDatabaseInstances.id, current.id), isNull(managedDatabaseInstances.pendingOperation)))
          .returning();
        claimedRow = this.requireOperationClaim(updating);
      });
      return { claimed: claimedRow!, credentials: owner };
    });
    await this.auditService.log({
      userId,
      action: 'database.managed.tls_certificate.rotate',
      resourceType: 'managed_database',
      resourceId: existing.id,
      details: { name: existing.name, type: existing.type, serviceAddresses },
    });
    this.emit(claimed, 'tls_certificate.rotating');
    return this.dispatchUpdate(
      claimed,
      credentials,
      managedDatabasePublishTcp(claimed!),
      managedDatabasePublishNativeTcp(claimed!),
      userId
    );
  }

  async pause(id: string, userId: string) {
    return this.beginLifecycleTransition(id, userId, 'pause', 'ready', 'paused');
  }

  async unpause(id: string, userId: string) {
    return this.beginLifecycleTransition(id, userId, 'unpause', 'paused', 'ready');
  }

  async restart(id: string, userId: string) {
    const { claimed, credentials } = await this.withBindingIdentityOperation(id, async () => {
      const row = await this.getRow(id);
      if (row.pendingOperation) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_OPERATION_PENDING',
          'Managed database operation is still being reconciled'
        );
      }
      if (row.status === 'paused') {
        throw new AppError(409, 'MANAGED_DATABASE_PAUSED', 'Unpause the managed database before restarting it');
      }
      await this.assertDatabaseNode(row.nodeId);
      const owner = JSON.parse(
        this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
      ) as OwnerCredentials;
      const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'restart' };
      const [restarting] = await this.db
        .update(managedDatabaseInstances)
        .set({
          status: 'updating',
          pendingOperation,
          lastError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(managedDatabaseInstances.id, id), isNull(managedDatabaseInstances.pendingOperation)))
        .returning();
      return { claimed: this.requireOperationClaim(restarting), credentials: owner };
    });
    this.emit(claimed, 'restart.started');
    return this.dispatchRestart(claimed, credentials, userId);
  }

  async delete(id: string, userId: string) {
    const deleting = await this.withBindingIdentityOperation(id, async () => {
      const row = await this.getRow(id);
      if (row.pendingOperation) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_OPERATION_PENDING',
          'Managed database operation is still being reconciled'
        );
      }
      await this.assertDatabaseNode(row.nodeId);
      return this.db.transaction(async (tx) => {
        // This shares the same row lock as binding creation. The binding query
        // must run after acquiring it: otherwise a concurrent insertion could
        // be cascaded away while its connector and credentials are provisioning.
        const [locked] = await tx
          .select()
          .from(managedDatabaseInstances)
          .where(eq(managedDatabaseInstances.id, id))
          .for('update');
        if (!locked) throw new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found');
        if (locked.pendingOperation) {
          throw new AppError(
            409,
            'MANAGED_DATABASE_OPERATION_PENDING',
            'Managed database operation is still being reconciled'
          );
        }
        const [binding] = await tx
          .select({ id: managedDatabaseBindings.id })
          .from(managedDatabaseBindings)
          .where(eq(managedDatabaseBindings.managedDatabaseId, id))
          .limit(1);
        if (binding) {
          throw new AppError(
            409,
            'MANAGED_DATABASE_BINDINGS_EXIST',
            'Delete managed database bindings before deleting the database'
          );
        }
        const [claimed] = await tx
          .update(managedDatabaseInstances)
          .set({
            status: 'deleting',
            pendingOperation: { id: crypto.randomUUID(), action: 'delete' },
            lastError: null,
            updatedById: userId,
            updatedAt: new Date(),
          })
          .where(eq(managedDatabaseInstances.id, id))
          .returning();
        return this.requireOperationClaim(claimed);
      });
    });
    return this.dispatchDelete(deleting, userId);
  }

  async retryProvisioning(id: string, userId: string) {
    const { claimed, credentials } = await this.withBindingIdentityOperation(id, async () => {
      let row = await this.getRow(id);
      if (row.status !== 'error' || !row.lastError?.startsWith('Managed database create failed')) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_NOT_RETRYABLE',
          'Only a failed managed database deployment can be retried'
        );
      }
      const node = await this.assertDatabaseNode(row.nodeId);
      row = await this.ensureManagedDatabaseCertificate(row, node);
      const owner = JSON.parse(
        this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
      ) as OwnerCredentials;
      const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'create' };
      const [retrying] = await this.db
        .update(managedDatabaseInstances)
        .set({ status: 'creating', pendingOperation, lastError: null, updatedById: userId, updatedAt: new Date() })
        .where(
          and(
            eq(managedDatabaseInstances.id, id),
            eq(managedDatabaseInstances.status, 'error'),
            isNull(managedDatabaseInstances.pendingOperation)
          )
        )
        .returning();
      return { claimed: this.requireOperationClaim(retrying), credentials: owner };
    });
    await this.auditService.log({
      userId,
      action: 'database.managed.retry_provisioning',
      resourceType: 'managed_database',
      resourceId: id,
      details: { name: claimed.name, type: claimed.type, nodeId: claimed.nodeId },
    });
    this.emit(claimed, 'retrying');
    return this.dispatchCreate(
      claimed,
      credentials,
      managedDatabasePublishTcp(claimed),
      managedDatabasePublishNativeTcp(claimed),
      userId
    );
  }

  async revealCredentials(id: string) {
    let row = await this.getRow(id);
    if (row.publishedPort === null) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_NOT_PUBLISHED',
        'Publish a TCP port before revealing direct-access credentials'
      );
    }
    // Direct credentials are persisted encrypted at creation time. Revealing
    // an existing account must be local-only; re-running binding_create here
    // would add a daemon round trip to every UI reveal. The lifecycle and
    // reconciliation paths already re-apply the principal after recreation.
    if (row.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
      row = await this.ensureBindingIdentity(row.id, null);
    }
    const existing = this.directAccessCredentials(row);
    const { row: current, credentials } = existing
      ? { row, credentials: existing }
      : await this.ensureDirectAccessCredentials(row, null);
    const ca = row.tlsEnabled && this.databaseCA ? await this.databaseCA.getDatabaseCA() : null;
    return {
      username: credentials.username,
      password: credentials.password,
      ...(credentials.databaseName ? { databaseName: credentials.databaseName } : {}),
      publishedPort: current.publishedPort,
      publishedNativePort: current.publishedNativePort,
      tlsEnabled: current.tlsEnabled,
      ...(ca
        ? {
            caCertificate: ca.certificatePem,
            caFingerprint: crypto.createHash('sha256').update(ca.certificatePem).digest('hex'),
          }
        : {}),
    };
  }

  async rotateDirectAccessCredentials(id: string, userId: string) {
    let row = await this.getRow(id);
    if (row.publishedPort === null) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_NOT_PUBLISHED',
        'Publish a TCP port before rotating direct-access credentials'
      );
    }
    if (row.status !== 'ready' || row.pendingOperation) {
      throw new AppError(409, 'MANAGED_DATABASE_NOT_READY', 'Managed database is not ready for credential rotation');
    }
    await this.assertDatabaseNode(row.nodeId);
    if (row.bindingIdentityVersion !== MANAGED_DATABASE_BINDING_IDENTITY_VERSION) {
      row = await this.ensureBindingIdentity(row.id, userId);
    }
    const owner = this.ownerCredentials(row);
    const current = this.directAccessCredentials(row) ?? newDirectAccessCredentials(row.type, owner.databaseName);
    const credentials = { ...current, password: crypto.randomBytes(32).toString('base64url') };
    await this.provisionDirectAccessPrincipal(row, owner, credentials);
    const [updated] = await this.db
      .update(managedDatabaseInstances)
      .set({
        encryptedDirectCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials))),
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, id))
      .returning();
    await this.syncCanonicalConnectionCredentials(updated!, owner, userId);
    await this.auditService.log({
      userId,
      action: 'database.managed.direct_access.rotate',
      resourceType: 'managed_database',
      resourceId: id,
      details: { name: updated!.name, type: updated!.type },
    });
    this.emit(updated!, 'direct_access.rotated');
    return {
      username: credentials.username,
      password: credentials.password,
      ...(credentials.databaseName ? { databaseName: credentials.databaseName } : {}),
      publishedPort: updated!.publishedPort,
    };
  }

  /**
   * Managed runtime accounting is observational. A missing sample must not
   * change the engine health result, so callers get null when it is not ready.
   */
  async getRuntimeStatsByDatabaseConnectionId(
    databaseConnectionId: string
  ): Promise<ManagedDatabaseRuntimeStats | null> {
    const [row] = await this.db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        status: managedDatabaseInstances.status,
      })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    if (!row || row.status !== 'ready') return null;
    const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'stats', row.id, '', 10_000);
    return result.success ? parseManagedRuntimeStats(result) : null;
  }

  /** Reconcile unknown outcomes after reconnects or controller delivery failures. */
  async reconcilePendingOperations() {
    if (this.reconciliationInFlight) return;
    this.reconciliationInFlight = true;
    try {
      const rows = await this.db
        .select()
        .from(managedDatabaseInstances)
        .where(isNotNull(managedDatabaseInstances.pendingOperation));
      for (const row of rows) await this.reconcilePendingRow(row);
    } finally {
      this.reconciliationInFlight = false;
    }
  }
}
