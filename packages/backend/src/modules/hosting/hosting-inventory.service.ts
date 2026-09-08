import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  integrationConnectors,
  nodes,
} from '@/db/schema/index.js';
import { normalizeIp } from '@/lib/ip-cidr.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import { monthlyVmExpenses } from './hosting-account-summary.js';
import type { HostingConnectorRow, HostingConnectorsService } from './hosting-connectors.service.js';
import {
  evaluateHostingAdoption,
  HOSTING_EVIDENCE_TTL_MS,
  type HostingNodeEvidence,
  type HostingResourceEvidence,
} from './hosting-evidence.js';
import { applyHostingImagePolicy } from './hosting-image-policy.js';
import { assertHostingResourceAction, assertHostingScope, canViewHostingFinance } from './hosting-permissions.js';
import {
  HOSTING_PROVIDERS,
  type HostingAccountSummary,
  type HostingCatalog,
  type HostingProviderAdapter,
  type HostingResourceSnapshot,
} from './hosting-provider.types.js';

export const HOSTING_RESOURCE_SNAPSHOT = 'hosting-resources';
export const HOSTING_CATALOG_SNAPSHOT = 'hosting-catalog';
export const HOSTING_ACCOUNT_SUMMARY_SNAPSHOT = 'hosting-account-summary';
interface CachedHostingAccountSummary {
  configurationRevision: string;
  summary: HostingAccountSummary;
}
export interface CachedHostingCatalog {
  configurationRevision: string;
  catalog: HostingCatalog;
}
interface CachedHostingResource {
  id: string;
  observedAt: string;
  snapshot: HostingResourceSnapshot;
}
interface CachedHostingInventory {
  connector: ReturnType<HostingConnectorsService['safe']>;
  resources: CachedHostingResource[];
}

export class HostingInventoryService {
  private adoptionRefresh: Promise<void> | null = null;
  private adoptionPending = false;
  constructor(
    private readonly db: DrizzleClient,
    private readonly connectors: HostingConnectorsService,
    private readonly nodeService: Pick<NodesService, 'readFile'>,
    private readonly dispatch: Pick<NodeDispatchService, 'isNodeConnected'>,
    private readonly audit: Pick<AuditService, 'log'>,
    private readonly snapshots?: ResourceSnapshotStore
  ) {}

  async initialize(connectorId: string) {
    const result = await this.sync(connectorId, undefined, true);
    if ('skipped' in result)
      throw new AppError(
        409,
        'HOSTING_CONNECTION_INITIALIZING',
        'The hosting connection is already synchronizing. Retry once synchronization finishes.'
      );
    return result;
  }

  async accountSummary(connectorId: string, user: User): Promise<HostingAccountSummary | null> {
    assertHostingScope(user.scopes, 'hosting:billing:view', connectorId);
    const connector = await this.connectors.get(connectorId, user, true);
    const cached = await this.snapshots?.get<CachedHostingAccountSummary>(
      HOSTING_ACCOUNT_SUMMARY_SNAPSHOT,
      connectorId
    );
    return cached?.refreshStatus === 'success' &&
      cached.data.configurationRevision === connector.updatedAt.toISOString()
      ? cached.data.summary
      : null;
  }

  async refreshAccountSummary(
    connector: HostingConnectorRow,
    adapter: HostingProviderAdapter,
    resources: HostingResourceSnapshot[]
  ) {
    if (!this.snapshots) return;
    const store = this.snapshots;
    const configurationRevision = connector.updatedAt.toISOString();
    const fallback = {
      configurationRevision,
      summary: { balance: null, monthlyExpenses: null, observedAt: new Date().toISOString() },
    };
    await store.withLease(HOSTING_ACCOUNT_SUMMARY_SNAPSHOT, connector.id, async (lease) => {
      try {
        await store.markRefreshing(HOSTING_ACCOUNT_SUMMARY_SNAPSHOT, connector.id, fallback, 'unknown', lease);
        const summary = adapter.accountSummary
          ? await adapter.accountSummary(resources)
          : { ...fallback.summary, monthlyExpenses: monthlyVmExpenses(resources) };
        const current = await this.connectors.get(connector.id, undefined, true);
        if (!current.enabled || current.updatedAt.toISOString() !== configurationRevision) return;
        await store.replace<CachedHostingAccountSummary>(
          HOSTING_ACCOUNT_SUMMARY_SNAPSHOT,
          connector.id,
          {
            configurationRevision,
            summary,
          },
          { lease, availability: 'available' }
        );
      } catch {
        // Optional billing failure must neither fail VM sync nor present the last balance as fresh.
        await store.markError(
          HOSTING_ACCOUNT_SUMMARY_SNAPSHOT,
          connector.id,
          fallback,
          'Hosting account summary is unavailable',
          'unavailable',
          lease
        );
      }
    });
  }

  /** Only connection/background synchronization may fetch a provider catalog. GET is cache-only. */
  async refreshCatalog(connector: HostingConnectorRow, adapter: HostingProviderAdapter) {
    if (!this.snapshots) return;
    const configurationRevision = connector.updatedAt.toISOString();
    const result = await this.snapshots.withLease(HOSTING_CATALOG_SNAPSHOT, connector.id, async (lease) => {
      try {
        await this.snapshots!.markRefreshing<CachedHostingCatalog>(
          HOSTING_CATALOG_SNAPSHOT,
          connector.id,
          { configurationRevision, catalog: { locations: [], sizes: [], images: [] } },
          'unknown',
          lease
        );
        const catalog = applyHostingImagePolicy(await adapter.catalog(), connector.provider as typeof adapter.provider);
        const current = await this.connectors.get(connector.id, undefined, true);
        if (current.updatedAt.toISOString() !== configurationRevision)
          throw new AppError(
            409,
            'HOSTING_CATALOG_SUPERSEDED',
            'Hosting configuration changed while refreshing its catalog.'
          );
        await this.snapshots!.replace<CachedHostingCatalog>(
          HOSTING_CATALOG_SNAPSHOT,
          connector.id,
          { configurationRevision, catalog },
          { lease }
        );
      } catch (error) {
        await this.snapshots!.markError<CachedHostingCatalog>(
          HOSTING_CATALOG_SNAPSHOT,
          connector.id,
          { configurationRevision, catalog: { locations: [], sizes: [], images: [] } },
          error instanceof AppError ? error.message : 'Hosting catalog refresh failed',
          undefined,
          lease
        );
        throw error;
      }
    });
    if (!result.acquired)
      throw new AppError(409, 'HOSTING_CATALOG_REFRESHING', 'Hosting catalog is already being refreshed.');
  }

  /** Newly enrolled daemons are matched immediately against the current inventory, without provider polling. */
  reconcileAdoption(): Promise<void> {
    this.adoptionPending = true;
    if (this.adoptionRefresh) return this.adoptionRefresh;
    this.adoptionRefresh = (async () => {
      do {
        this.adoptionPending = false;
        const connectors = await this.db
          .select()
          .from(integrationConnectors)
          .where(
            and(
              eq(integrationConnectors.enabled, true),
              inArray(integrationConnectors.provider, [...HOSTING_PROVIDERS])
            )
          );
        for (const connector of connectors) {
          try {
            await this.adopt(connector, this.connectors.adapter(connector));
            await this.refreshSnapshot(connector.id);
            this.connectors.changed(connector.id);
          } catch {
            /* The scheduled sync retains retry responsibility for unavailable evidence. */
          }
        }
      } while (this.adoptionPending);
    })().finally(() => {
      this.adoptionRefresh = null;
    });
    return this.adoptionRefresh;
  }

  /** Persisted-source projection only: a cache miss never performs a provider request. */
  async refreshSnapshot(connectorId: string) {
    if (!this.snapshots) return;
    await this.snapshots.withLease(HOSTING_RESOURCE_SNAPSHOT, connectorId, async (lease) => {
      const [connector] = await this.db
        .select()
        .from(integrationConnectors)
        .where(eq(integrationConnectors.id, connectorId));
      if (!connector?.enabled) {
        await this.snapshots!.remove(HOSTING_RESOURCE_SNAPSHOT, connectorId);
        return;
      }
      const rows = await this.db.select().from(hostingResources).where(eq(hostingResources.connectorId, connectorId));
      const data: CachedHostingInventory = {
        connector: this.connectors.safe(connector),
        resources: rows.map((row) => ({
          id: row.id,
          observedAt: row.observedAt.toISOString(),
          snapshot: row.snapshot,
        })),
      };
      if (connector.syncStatus === 'error') {
        await this.snapshots!.markError(
          HOSTING_RESOURCE_SNAPSHOT,
          connectorId,
          data,
          connector.syncLastError ?? 'Hosting synchronization failed',
          undefined,
          lease
        );
        return;
      }
      // Removal invalidates the lease, so an older refresh cannot resurrect its resource snapshot.
      await this.snapshots!.replace(HOSTING_RESOURCE_SNAPSHOT, connectorId, data, { lease });
    });
  }

  async nodeBindings(user: User) {
    const rows = await this.db
      .select({ binding: hostingNodeBindings, resource: hostingResources, connector: integrationConnectors })
      .from(hostingNodeBindings)
      .innerJoin(hostingResources, eq(hostingResources.id, hostingNodeBindings.resourceId))
      .leftJoin(integrationConnectors, eq(integrationConnectors.id, hostingResources.connectorId));
    const bindings: Record<
      string,
      {
        resourceId: string | null;
        connectorId: string | null;
        provider: string;
        connectorName: string | null;
        operationPhase?: typeof hostingOperations.$inferSelect.phase;
        operationAction?: typeof hostingOperations.$inferSelect.action;
      }
    > = Object.fromEntries(
      rows
        .filter(({ binding }) => hasScope(user.scopes, `nodes:details:${binding.nodeId}`))
        .map(({ binding, resource, connector }) => [
          binding.nodeId,
          {
            resourceId: resource.id,
            connectorId: resource.connectorId,
            provider: resource.provider,
            connectorName: connector?.name ?? null,
          },
        ])
    );
    const pending = await this.db
      .select({ operation: hostingOperations, connector: integrationConnectors })
      .from(hostingOperations)
      .innerJoin(nodes, eq(nodes.id, hostingOperations.nodeId))
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, hostingOperations.connectorId))
      .where(
        and(
          inArray(hostingOperations.action, ['create', 'install']),
          or(eq(nodes.status, 'pending'), notInArray(hostingOperations.phase, ['ready', 'failed']))
        )
      )
      .orderBy(desc(hostingOperations.createdAt));
    const seen = new Set<string>();
    for (const { operation, connector } of pending) {
      const nodeId = operation.nodeId!;
      if (seen.has(nodeId) || !hasScope(user.scopes, `nodes:details:${nodeId}`)) continue;
      seen.add(nodeId);
      bindings[nodeId] = {
        resourceId: bindings[nodeId]?.resourceId ?? operation.resourceId,
        connectorId: connector.id,
        provider: connector.provider,
        connectorName: connector.name,
        operationPhase: operation.phase,
        operationAction: operation.action,
      };
    }
    const active = await this.db
      .select()
      .from(hostingOperations)
      .where(notInArray(hostingOperations.phase, ['ready', 'failed']))
      .orderBy(desc(hostingOperations.createdAt));
    for (const binding of Object.values(bindings)) {
      const operation = active.find((op) => op.resourceId && op.resourceId === binding.resourceId);
      if (operation) {
        binding.operationPhase = operation.phase;
        binding.operationAction = operation.action;
      }
    }
    return bindings;
  }

  async nodeProjection(nodeId: string, user: User) {
    assertHostingScope(user.scopes, 'nodes:details', nodeId);
    let [row] = await this.db
      .select({ resource: hostingResources, connector: integrationConnectors })
      .from(hostingNodeBindings)
      .innerJoin(hostingResources, eq(hostingResources.id, hostingNodeBindings.resourceId))
      .leftJoin(integrationConnectors, eq(integrationConnectors.id, hostingResources.connectorId))
      .where(eq(hostingNodeBindings.nodeId, nodeId));
    let awaitingBinding = false;
    let pendingNodeOperation: {
      action: typeof hostingOperations.$inferSelect.action;
      phase: typeof hostingOperations.$inferSelect.phase;
    } | null = null;
    if (!row) {
      // The accepted operation owns the pending node before enrollment establishes a binding.
      const [pending] = await this.db
        .select({ operation: hostingOperations, connector: integrationConnectors, resource: hostingResources })
        .from(hostingOperations)
        .innerJoin(integrationConnectors, eq(integrationConnectors.id, hostingOperations.connectorId))
        .leftJoin(hostingResources, eq(hostingResources.id, hostingOperations.resourceId))
        .where(and(eq(hostingOperations.nodeId, nodeId), inArray(hostingOperations.action, ['create', 'install'])))
        .orderBy(desc(hostingOperations.createdAt))
        .limit(1);
      if (!pending) return null;
      awaitingBinding = true;
      pendingNodeOperation = { action: pending.operation.action, phase: pending.operation.phase };
      if (!pending.resource)
        return {
          resourceId: null,
          connectorId: pending.connector.id,
          provider: pending.connector.provider,
          connectorName: pending.connector.name,
          remoteId: '',
          location: '',
          origin: 'created',
          kind: 'vm',
          powerState: 'unknown',
          cpu: null,
          memoryMb: null,
          diskGb: null,
          incarnation: null,
          observedAt: pending.operation.updatedAt.toISOString(),
          identityConflict: false,
          operation: { action: pending.operation.action, phase: pending.operation.phase },
          price: undefined,
          actions: Object.fromEntries(
            ['start', 'shutdown', 'reboot', 'resize', 'delete', 'recover'].map((action) => [
              action,
              { available: false, reason: 'Node enrollment has not completed' },
            ])
          ),
        };
      row = { resource: pending.resource, connector: pending.connector };
    }
    const { resource, connector } = row;
    const bound = await this.db
      .select({ nodeId: hostingNodeBindings.nodeId })
      .from(hostingNodeBindings)
      .where(eq(hostingNodeBindings.resourceId, resource.id));
    const snapshot = resource.snapshot;
    const [activeOperation] = await this.db
      .select({ action: hostingOperations.action, phase: hostingOperations.phase })
      .from(hostingOperations)
      .where(
        and(eq(hostingOperations.resourceId, resource.id), notInArray(hostingOperations.phase, ['ready', 'failed']))
      )
      .orderBy(desc(hostingOperations.createdAt))
      .limit(1);
    const identityConflict = !resource.incarnation || resource.incarnation !== snapshot.incarnation;
    const unavailable = awaitingBinding
      ? 'Node enrollment has not completed'
      : !connector?.enabled
        ? 'Hosting integration is disconnected or disabled'
        : resource.missingSince
          ? 'Provider resource is missing'
          : identityConflict
            ? 'Provider VM identity changed; management is disabled'
            : null;
    const actions = Object.fromEntries(
      (['start', 'shutdown', 'reboot', 'resize', 'delete', 'recover'] as const).map((action) => {
        let capability = snapshot.capabilities[action];
        try {
          assertHostingResourceAction(
            user.scopes,
            resource.id,
            action,
            bound.map((b) => b.nodeId)
          );
          if (connector) assertHostingScope(user.scopes, 'integrations:hosting:view', connector.id);
          if (unavailable) capability = { available: false, reason: unavailable };
          if (activeOperation) capability = { available: false, reason: 'A VM operation is in progress' };
        } catch {
          capability = { available: false, reason: 'You do not have permission for all affected nodes' };
        }
        return [action, capability];
      })
    );
    return {
      resourceId: resource.id,
      connectorId: resource.connectorId,
      provider: resource.provider,
      connectorName: connector?.name ?? null,
      remoteId: resource.remoteId,
      location: snapshot.location,
      origin: resource.origin,
      kind: resource.kind,
      powerState: snapshot.powerState,
      cpu: snapshot.cpu,
      memoryMb: snapshot.memoryMb,
      diskGb: snapshot.diskGb,
      incarnation: resource.incarnation,
      providerUrl: snapshot.providerUrl,
      observedAt: snapshot.observedAt,
      ...(connector &&
      ['hostkey', 'digitalocean'].includes(resource.provider) &&
      canViewHostingFinance(user.scopes, connector.id)
        ? { price: snapshot.price }
        : {}),
      identityConflict,
      operation: activeOperation ?? (awaitingBinding ? pendingNodeOperation : null),
      actions,
    };
  }

  async resources(connectorId: string, user: User) {
    await this.connectors.get(connectorId, user);
    const resources = await this.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.connectorId, connectorId));
    let cached = await this.snapshots?.get<CachedHostingInventory>(HOSTING_RESOURCE_SNAPSHOT, connectorId);
    if (
      !cached ||
      resources.some(
        (row) =>
          !cached?.data.resources.some((item) => item.id === row.id && item.observedAt === row.observedAt.toISOString())
      ) ||
      cached.data.resources.length !== resources.length
    ) {
      await this.refreshSnapshot(connectorId);
      cached = await this.snapshots?.get<CachedHostingInventory>(HOSTING_RESOURCE_SNAPSHOT, connectorId);
    }
    const bindings = resources.length
      ? await this.db
          .select({
            nodeId: hostingNodeBindings.nodeId,
            resourceId: hostingNodeBindings.resourceId,
            name: nodes.displayName,
            hostname: nodes.hostname,
            status: nodes.status,
            type: nodes.type,
            slug: nodes.slug,
          })
          .from(hostingNodeBindings)
          .innerJoin(nodes, eq(nodes.id, hostingNodeBindings.nodeId))
          .where(
            inArray(
              hostingNodeBindings.resourceId,
              resources.map((r) => r.id)
            )
          )
      : [];
    return resources
      .filter(
        (resource) =>
          hasScope(user.scopes, `hosting:resources:view:${resource.id}`) &&
          !resource.missingSince &&
          (bindings.some((binding) => binding.resourceId === resource.id)
            ? bindings
                .filter((binding) => binding.resourceId === resource.id)
                .every((binding) => hasScope(user.scopes, `nodes:details:${binding.nodeId}`))
            : resource.origin === 'created')
      )
      .map((resource) => ({
        id: resource.id,
        connectorId,
        origin: resource.origin,
        ...(cached?.data.resources.find(
          (item) => item.id === resource.id && item.observedAt === resource.observedAt.toISOString()
        )?.snapshot ?? resource.snapshot),
        price: canViewHostingFinance(user.scopes, connectorId) ? resource.snapshot.price : undefined,
        incarnation: resource.incarnation,
        missingSince: resource.missingSince,
        adoptionReason: resource.adoptionReason,
        nodes: bindings
          .filter(
            (binding) => binding.resourceId === resource.id && hasScope(user.scopes, `nodes:details:${binding.nodeId}`)
          )
          .map((binding) => ({
            id: binding.nodeId,
            name: binding.name || binding.hostname,
            status: binding.status,
            type: binding.type,
            slug: binding.slug,
          })),
      }));
  }

  async sync(connectorId: string, user?: User, requireCatalog = false) {
    if (user) assertHostingScope(user.scopes, 'integrations:hosting:manage', connectorId);
    const connector = await this.connectors.get(connectorId, user, true);
    await this.connectors.owner(connector);
    const now = new Date();
    const [claimed] = await this.db
      .update(integrationConnectors)
      .set({ syncStatus: 'running', syncStartedAt: now })
      .where(
        and(
          eq(integrationConnectors.id, connectorId),
          or(
            ne(integrationConnectors.syncStatus, 'running'),
            sql`${integrationConnectors.syncStartedAt} < ${new Date(now.getTime() - 10 * 60 * 1000)}`
          )
        )
      )
      .returning({ id: integrationConnectors.id });
    if (!claimed) return { skipped: true, reason: 'sync_running' };
    try {
      const adapter = this.connectors.adapter(connector);
      const account = await adapter.test();
      const settings = this.connectors.settings(connector);
      const allocationAuthority = settings.proxmoxAllocationAuthority ?? settings.authority;
      if (account.authority !== allocationAuthority)
        throw new AppError(409, 'HOSTING_ACCOUNT_CHANGED', 'Provider account identity changed');
      const inventory = await adapter.listResources();
      if (!inventory.complete)
        throw new AppError(
          502,
          'HOSTING_INVENTORY_INCOMPLETE',
          'Provider inventory is incomplete; existing bindings are preserved'
        );
      // Full accessible inventory is evidence for adoption, not a user-facing VM control panel.
      const snapshots = [...inventory.resources];
      // A connector inventories its selected physical host. Owned VMs can migrate inside the
      // cluster, though, so resolve each absent owned identity directly before declaring it missing.
      if (connector.provider === 'proxmox') {
        const owned = await this.db
          .select()
          .from(hostingResources)
          .where(and(eq(hostingResources.connectorId, connectorId), isNull(hostingResources.missingSince)));
        for (const resource of owned) {
          if (snapshots.some((snapshot) => snapshot.remoteId === resource.remoteId && snapshot.kind === resource.kind))
            continue;
          const moved = await adapter.getResource(resource.remoteId);
          if (moved && moved.kind === resource.kind) snapshots.push(moved);
        }
      }
      await this.db.transaction(async (tx) => {
        // Serialize adoption and all connector snapshots in one domain, including overlapping provider tokens.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hosting-inventory'))`);
        const [current] = await tx
          .select()
          .from(integrationConnectors)
          .where(eq(integrationConnectors.id, connector.id))
          .for('update');
        if (!current?.enabled || current.syncStartedAt?.getTime() !== now.getTime())
          throw new AppError(409, 'HOSTING_SYNC_STALE', 'Hosting sync was superseded');
        const seen: string[] = [];
        for (const snapshot of snapshots) {
          let [existing] = await tx
            .select()
            .from(hostingResources)
            .where(
              and(
                eq(hostingResources.provider, adapter.provider),
                eq(hostingResources.authority, settings.authority),
                eq(hostingResources.kind, snapshot.kind),
                eq(hostingResources.remoteId, snapshot.remoteId),
                isNull(hostingResources.missingSince)
              )
            )
            .for('update');
          if (!existing && snapshot.incarnation) {
            const history = await tx
              .select()
              .from(hostingResources)
              .where(
                and(
                  eq(hostingResources.provider, adapter.provider),
                  eq(hostingResources.authority, settings.authority),
                  eq(hostingResources.kind, snapshot.kind),
                  eq(hostingResources.remoteId, snapshot.remoteId),
                  eq(hostingResources.incarnation, snapshot.incarnation),
                  isNotNull(hostingResources.missingSince)
                )
              )
              .limit(2)
              .for('update');
            if (history.length > 1)
              throw new AppError(
                409,
                'HOSTING_RESOURCE_IDENTITY_AMBIGUOUS',
                'Multiple historical resources share this provider identity. Existing node bindings were preserved.'
              );
            existing = history[0];
          }
          if (existing?.connectorId && existing.connectorId !== connectorId)
            throw new AppError(
              409,
              'HOSTING_RESOURCE_ALREADY_CONNECTED',
              'A provider resource is already exposed by another integration'
            );
          if (existing) {
            seen.push(existing.id);
            const replaced = !!existing.incarnation && existing.incarnation !== snapshot.incarnation;
            await tx
              .update(hostingResources)
              .set({
                connectorId,
                snapshot,
                observedAt: new Date(snapshot.observedAt),
                missingSince: null,
                // Never transfer ownership through provider ID reuse or an OS rebuild.
                incarnation: existing.origin === 'discovered' ? snapshot.incarnation : existing.incarnation,
                adoptionReason:
                  replaced && existing.origin !== 'discovered' ? 'resource_identity_changed' : existing.adoptionReason,
                updatedAt: now,
              })
              .where(eq(hostingResources.id, existing.id));
          } else {
            const [created] = await tx
              .insert(hostingResources)
              .values({
                connectorId,
                provider: adapter.provider,
                authority: settings.authority,
                remoteId: snapshot.remoteId,
                kind: snapshot.kind,
                snapshot,
                incarnation: snapshot.incarnation,
                observedAt: new Date(snapshot.observedAt),
              })
              .returning({ id: hostingResources.id });
            seen.push(created.id);
          }
        }
        await tx
          .update(hostingResources)
          .set({ missingSince: now, updatedAt: now })
          .where(
            and(
              eq(hostingResources.connectorId, connectorId),
              isNull(hostingResources.missingSince),
              ...(seen.length ? [notInArray(hostingResources.id, seen)] : [])
            )
          );
      });
      await this.adopt(connector, adapter);
      try {
        await this.refreshCatalog(connector, adapter);
      } catch (error) {
        // Inventory remains usable when a periodic catalog request fails; retain the last good catalog.
        if (requireCatalog) throw error;
      }
      await this.db
        .update(integrationConnectors)
        .set({
          syncStatus: 'success',
          capabilities: Object.fromEntries(
            Object.entries(account.capabilities).map(([key, value]) => [key, value.available])
          ),
          syncFinishedAt: new Date(),
          syncLastError: null,
          syncFailureCount: 0,
          syncNextRetryAt: null,
        })
        .where(and(eq(integrationConnectors.id, connectorId), eq(integrationConnectors.syncStartedAt, now)));
      await this.refreshSnapshot(connectorId);
      await this.refreshAccountSummary(connector, adapter, snapshots);
      this.connectors.changed(connectorId);
      return { resourceCount: snapshots.length };
    } catch (error) {
      await this.db
        .update(integrationConnectors)
        .set({
          syncStatus: 'error',
          syncLastError: error instanceof AppError ? error.message : 'Hosting synchronization failed',
          syncFailureCount: sql`${integrationConnectors.syncFailureCount} + 1`,
          syncNextRetryAt: new Date(Date.now() + 60_000),
        })
        .where(and(eq(integrationConnectors.id, connectorId), eq(integrationConnectors.syncStartedAt, now)));
      await this.refreshSnapshot(connectorId);
      this.connectors.changed(connectorId);
      throw error;
    }
  }

  private async nodeEvidence(connector: HostingConnectorRow): Promise<HostingNodeEvidence[]> {
    const settings = this.connectors.settings(connector);
    const owner = await this.connectors.owner(connector);
    const candidates = await this.db.select().from(nodes).where(isNotNull(nodes.hostIdentityId));
    const evidence: HostingNodeEvidence[] = [];
    for (const node of candidates) {
      if (settings.adoptionNodeIds.length && !settings.adoptionNodeIds.includes(node.id)) continue;
      if (
        !hasScope(owner.scopes, `nodes:config:edit:${node.id}`) ||
        !hasScope(owner.scopes, `nodes:details:${node.id}`)
      )
        continue;
      const connected = this.dispatch.isNodeConnected(node.id);
      const interfaces: HostingNodeEvidence['interfaces'] = [];
      for (const iface of connected ? (node.lastHealthReport?.networkInterfaces ?? []) : []) {
        if (!/^[a-zA-Z0-9_.:-]{1,32}$/.test(iface.name) || iface.name === 'lo') continue;
        let mac: string | undefined;
        if (iface.ipAddresses?.length) {
          try {
            // Fixed known sysfs leaf only. Never arbitrary shell, never a new telemetry protocol.
            const value = (await this.nodeService.readFile(node.id, `/sys/class/net/${iface.name}/address`))
              .toString('utf8')
              .trim();
            if (/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) mac = value;
          } catch {
            /* Without MAC only direct globally-routable interface IP can match. */
          }
        }
        for (const value of iface.ipAddresses ?? []) {
          const ip = normalizeIp(value.split('/')[0]);
          if (ip) interfaces.push({ ip, mac });
        }
      }
      evidence.push({
        nodeId: node.id,
        hostIdentityId: node.hostIdentityId,
        observedAt: connected ? (node.lastSeenAt?.toISOString() ?? null) : null,
        interfaces,
        interfaceSnapshot: JSON.stringify(node.lastHealthReport?.networkInterfaces ?? []),
      });
    }
    return evidence;
  }

  private async adopt(connector: HostingConnectorRow, adapter: HostingProviderAdapter) {
    const settings = this.connectors.settings(connector);
    if (!connector.enabled || !settings.adoptionEnabled) return;
    const ownRows = await this.db
      .select()
      .from(hostingResources)
      .where(and(eq(hostingResources.connectorId, connector.id), isNull(hostingResources.missingSince)));
    // Include other attached scopes so duplicate private interfaces/public IPs cannot look unique locally.
    const allRows = await this.db
      .select()
      .from(hostingResources)
      .where(and(isNotNull(hostingResources.connectorId), isNull(hostingResources.missingSince)));
    const evidence = await this.nodeEvidence(connector);
    const resources: HostingResourceEvidence[] = allRows.map((resource) => ({
      id: resource.id,
      snapshot: resource.snapshot,
      managedHostIdentity: resource.managedHostIdentity,
    }));
    for (const resource of resources) {
      if (ownRows.some((row) => row.id === resource.id) && adapter.guestIdentity)
        resource.guestHostIdentity = await adapter.guestIdentity(resource.snapshot);
    }
    const bindings = await this.db
      .select({ nodeId: hostingNodeBindings.nodeId, resourceId: hostingNodeBindings.resourceId })
      .from(hostingNodeBindings);
    const decisions = evaluateHostingAdoption({
      resources,
      nodes: evidence,
      inventoryComplete: true,
      existingBindings: bindings,
    });
    // Scope limits admission, not the inventory used to disprove ambiguous matches.
    const ownIds = new Set(
      ownRows.filter((r) => !settings.resourceIds.length || settings.resourceIds.includes(r.remoteId)).map((r) => r.id)
    );
    for (const decision of decisions.filter((decision) => ownIds.has(decision.resourceId))) {
      if (!decision.hostIdentityId || !decision.evidenceDigest) {
        await this.db
          .update(hostingResources)
          .set({ adoptionReason: decision.reason })
          .where(and(eq(hostingResources.id, decision.resourceId), eq(hostingResources.origin, 'discovered')));
        continue;
      }
      const original = ownRows.find((row) => row.id === decision.resourceId)!;
      if (original.adoptionReason === 'resource_identity_changed' || !original.incarnation) continue;
      let changed = false;
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hosting-inventory'))`);
        // Same lock order as inventory sync. Connector updates/removal lock this row too.
        const [currentConnector] = await tx
          .select()
          .from(integrationConnectors)
          .where(eq(integrationConnectors.id, connector.id))
          .for('update');
        if (
          !currentConnector?.enabled ||
          currentConnector.updatedAt.getTime() !== connector.updatedAt.getTime() ||
          JSON.stringify(this.connectors.settings(currentConnector)) !== JSON.stringify(settings)
        )
          return;
        const owner = await this.connectors.owner(currentConnector);
        if (
          decision.nodeIds.some(
            (id) => !hasScope(owner.scopes, `nodes:config:edit:${id}`) || !hasScope(owner.scopes, `nodes:details:${id}`)
          )
        )
          return;
        // Re-evaluate freshness at commit time; a long account scan cannot extend evidence TTL.
        const freshDecision = evaluateHostingAdoption({
          resources,
          nodes: evidence,
          inventoryComplete: true,
          existingBindings: bindings,
          now: Date.now(),
        }).find((item) => item.resourceId === decision.resourceId);
        if (
          freshDecision?.hostIdentityId !== decision.hostIdentityId ||
          freshDecision.evidenceDigest !== decision.evidenceDigest
        )
          return;
        const [current] = await tx
          .select()
          .from(hostingResources)
          .where(eq(hostingResources.id, original.id))
          .for('update');
        if (
          !current ||
          current.connectorId !== connector.id ||
          current.missingSince ||
          current.incarnation !== original.incarnation ||
          current.snapshot.incarnation !== original.snapshot.incarnation ||
          current.observedAt.getTime() !== original.observedAt.getTime()
        )
          return;
        if (current.managedHostIdentity && current.managedHostIdentity !== decision.hostIdentityId) return;
        const [conflict] = await tx
          .select({ id: hostingResources.id })
          .from(hostingResources)
          .where(
            and(eq(hostingResources.managedHostIdentity, decision.hostIdentityId!), ne(hostingResources.id, current.id))
          )
          .limit(1);
        if (conflict) return;
        const nodeRows = await tx.select().from(nodes).where(inArray(nodes.id, decision.nodeIds)).for('update');
        if (
          nodeRows.length !== decision.nodeIds.length ||
          nodeRows.some((node) => node.hostIdentityId !== decision.hostIdentityId)
        )
          return;
        if (
          decision.reason !== 'guest_identity' &&
          nodeRows.some((node) => {
            const source = evidence.find((item) => item.nodeId === node.id);
            // Offline sibling roles can share independently confirmed host identity; only the roles
            // whose interfaces contributed evidence must still expose that exact current report.
            if (!source?.interfaces.length) return false;
            return (
              !this.dispatch.isNodeConnected(node.id) ||
              !node.lastSeenAt ||
              Date.now() - node.lastSeenAt.getTime() > HOSTING_EVIDENCE_TTL_MS ||
              source.interfaceSnapshot !== JSON.stringify(node.lastHealthReport?.networkInterfaces ?? [])
            );
          })
        )
          return;
        const currentCandidates = await tx
          .select({
            id: hostingResources.id,
            observedAt: hostingResources.observedAt,
            missingSince: hostingResources.missingSince,
            connectorId: hostingResources.connectorId,
          })
          .from(hostingResources)
          .where(and(isNotNull(hostingResources.connectorId), isNull(hostingResources.missingSince)));
        // A newly added, removed or refreshed competing inventory invalidates the uniqueness proof.
        if (
          currentCandidates.length !== allRows.length ||
          currentCandidates.some((candidate) => {
            const source = allRows.find((item) => item.id === candidate.id);
            return (
              !source ||
              source.connectorId !== candidate.connectorId ||
              source.observedAt.getTime() !== candidate.observedAt.getTime()
            );
          })
        )
          return;
        const existing = await tx
          .select()
          .from(hostingNodeBindings)
          .where(inArray(hostingNodeBindings.nodeId, decision.nodeIds));
        if (existing.some((binding) => binding.resourceId !== current.id)) return;
        changed = current.origin === 'discovered' || existing.length !== decision.nodeIds.length;
        await tx
          .update(hostingResources)
          .set({
            managedHostIdentity: decision.hostIdentityId,
            origin: current.origin === 'created' ? 'created' : 'adopted',
            adoptionReason: null,
            updatedAt: new Date(),
          })
          .where(eq(hostingResources.id, current.id));
        for (const nodeId of decision.nodeIds) {
          await tx
            .insert(hostingNodeBindings)
            .values({
              nodeId,
              resourceId: current.id,
              hostIdentityId: decision.hostIdentityId!,
              evidenceType: decision.reason,
              evidenceDigest: decision.evidenceDigest!,
              observedAt: new Date(),
            })
            .onConflictDoNothing({ target: hostingNodeBindings.nodeId });
        }
      });
      if (changed)
        await this.audit.log({
          userId: null,
          action: 'hosting.node.adopted',
          resourceType: 'hosting-resource',
          resourceId: original.id,
          details: { evidenceType: decision.reason, nodeCount: decision.nodeIds.length },
        });
    }
  }

  async reconcileDue() {
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(
        and(eq(integrationConnectors.enabled, true), inArray(integrationConnectors.provider, [...HOSTING_PROVIDERS]))
      );
    for (const row of rows) {
      const settings = this.connectors.settings(row);
      const inventoryDue =
        settings.autoSyncEnabled &&
        (!row.syncNextRetryAt || row.syncNextRetryAt.getTime() <= Date.now()) &&
        !(
          row.syncStatus === 'success' &&
          row.syncFinishedAt &&
          Date.now() - row.syncFinishedAt.getTime() < settings.autoSyncIntervalSeconds * 1000
        );
      if (inventoryDue) {
        try {
          await this.sync(row.id);
        } catch {
          /* Sync persists safe diagnostic state. Continue other accounts. */
        }
        continue;
      }
      const catalog = await this.snapshots?.get<CachedHostingCatalog>(HOSTING_CATALOG_SNAPSHOT, row.id);
      const catalogDue =
        this.snapshots &&
        (!catalog ||
          catalog.data.configurationRevision !== row.updatedAt.toISOString() ||
          Date.now() - Date.parse(catalog.lastAttemptAt ?? '1970-01-01') >=
            (catalog.refreshStatus === 'error' ? 60_000 : 15 * 60_000));
      if (catalogDue) {
        try {
          await this.connectors.owner(row);
          await this.refreshCatalog(row, this.connectors.adapter(row));
          this.connectors.changed(row.id);
        } catch {
          /* A failed catalog refresh retains the last good snapshot and is retried by this job. */
        }
      }
    }
  }
}
