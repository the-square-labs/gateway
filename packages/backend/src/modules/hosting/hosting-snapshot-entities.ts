import { and, desc, eq, lt, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingSnapshotEntities } from '@/db/schema/index.js';
import type { HostingVmSnapshot } from './hosting-snapshot.types.js';
import { snapshotLayoutId } from './hosting-snapshot-folders.js';

export const HOSTING_SNAPSHOT_ENTITY_STATUSES = ['pending', 'ready', 'failed', 'deleting', 'deleted'] as const;
export type HostingSnapshotEntityStatus = (typeof HOSTING_SNAPSHOT_ENTITY_STATUSES)[number];

export type HostingSnapshotEntityRow = typeof hostingSnapshotEntities.$inferSelect;
type EntityExecutor = Pick<DrizzleClient, 'insert' | 'select' | 'update'>;

export interface HostingSnapshotEntityDto extends HostingVmSnapshot {
  entityId: string;
  status: HostingSnapshotEntityStatus;
  error: string | null;
  operationId: string | null;
  includeRam: boolean;
  providerSnapshotId: string | null;
  revision: string;
}

export interface PendingHostingSnapshotEntity {
  id: string;
  resourceId: string;
  incarnation: string;
  operationId: string | null;
  name: string;
  includeRam: boolean;
}

export interface HostingSnapshotEntityTransition {
  status?: HostingSnapshotEntityStatus;
  error?: string | null;
  data?: HostingVmSnapshot;
  providerSnapshotId?: string | null;
  fingerprint?: string | null;
  operationId?: string | null;
}

function pendingData(input: PendingHostingSnapshotEntity): HostingVmSnapshot {
  return {
    id: input.id,
    name: input.name,
    createdAt: null,
    fingerprint: input.id,
    sizeGb: null,
    minDiskGb: null,
    ready: false,
  };
}

function providerData(snapshot: HostingVmSnapshot): HostingVmSnapshot {
  const {
    entityId: _entityId,
    status: _status,
    providerSnapshotId: _providerSnapshotId,
    operationId: _operationId,
    error: _error,
    includeRam: _includeRam,
    revision: _revision,
    layoutId: _layoutId,
    folderId: _folderId,
    sortOrder: _sortOrder,
    ...data
  } = snapshot;
  return data;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function snapshotEntityNeedsTransition(
  row: HostingSnapshotEntityRow,
  patch: HostingSnapshotEntityTransition
): boolean {
  return (
    (patch.status !== undefined && patch.status !== row.status) ||
    ('error' in patch && patch.error !== row.error) ||
    ('providerSnapshotId' in patch && patch.providerSnapshotId !== row.providerSnapshotId) ||
    ('fingerprint' in patch && patch.fingerprint !== row.fingerprint) ||
    ('operationId' in patch && patch.operationId !== row.operationId) ||
    (patch.data !== undefined && !sameJson(patch.data, row.data))
  );
}

export function shouldTombstoneMissingSnapshot(row: HostingSnapshotEntityRow): boolean {
  return row.status === 'ready';
}

export function shouldMergeProviderSnapshot(row: HostingSnapshotEntityRow): boolean {
  return row.status !== 'failed' && row.status !== 'deleting' && row.status !== 'deleted';
}

export function snapshotPredatesObservation(
  row: Pick<HostingSnapshotEntityRow, 'updatedAt'>,
  startedAt?: Date
): boolean {
  // Equality is ambiguous at millisecond precision: lifecycle state wins.
  return !startedAt || row.updatedAt.getTime() < startedAt.getTime();
}

export function hasUnresolvedPendingSnapshotName(rows: HostingSnapshotEntityRow[], name: string): boolean {
  return rows.some((row) => row.status === 'pending' && !row.providerSnapshotId && row.name === name);
}

export function publicHostingSnapshotEntity(row: HostingSnapshotEntityRow): HostingSnapshotEntityDto {
  const entityId = row.id;
  return {
    ...row.data,
    id: row.providerSnapshotId ?? entityId,
    entityId,
    status: row.status,
    error: row.error,
    operationId: row.operationId,
    includeRam: row.includeRam,
    providerSnapshotId: row.providerSnapshotId,
    fingerprint: row.fingerprint ?? entityId,
    name: row.name,
    ready: row.status === 'ready',
    createdAt: row.data.createdAt ?? row.createdAt.toISOString(),
    layoutId: entityId,
    revision: row.updatedAt.toISOString(),
  };
}

function transitionValues(
  row: HostingSnapshotEntityRow,
  patch: HostingSnapshotEntityTransition
): Partial<typeof hostingSnapshotEntities.$inferInsert> {
  const values: Partial<typeof hostingSnapshotEntities.$inferInsert> = {
    updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
  };
  if (patch.status !== undefined) values.status = patch.status;
  if ('error' in patch) values.error = patch.error;
  if (patch.data !== undefined) values.data = patch.data;
  if ('providerSnapshotId' in patch) values.providerSnapshotId = patch.providerSnapshotId;
  if ('fingerprint' in patch) values.fingerprint = patch.fingerprint;
  if ('operationId' in patch) values.operationId = patch.operationId;
  return values;
}

export class HostingSnapshotEntities {
  constructor(private readonly db: DrizzleClient) {}

  async list(resourceId: string, incarnation: string): Promise<HostingSnapshotEntityDto[]> {
    const rows = await this.db
      .select()
      .from(hostingSnapshotEntities)
      .where(
        and(
          eq(hostingSnapshotEntities.resourceId, resourceId),
          eq(hostingSnapshotEntities.incarnation, incarnation),
          ne(hostingSnapshotEntities.status, 'deleted')
        )
      )
      .orderBy(desc(hostingSnapshotEntities.createdAt));
    return rows.map(publicHostingSnapshotEntity);
  }

  /** Raw durable row for workers that need provider data and lifecycle state. */
  async get(resourceId: string, incarnation: string, entityId: string): Promise<HostingSnapshotEntityRow | null> {
    const [row] = await this.db
      .select()
      .from(hostingSnapshotEntities)
      .where(
        and(
          eq(hostingSnapshotEntities.id, entityId),
          eq(hostingSnapshotEntities.resourceId, resourceId),
          eq(hostingSnapshotEntities.incarnation, incarnation)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /** Idempotent entity insert before operation reservation/provider dispatch. */
  async pending(tx: EntityExecutor, input: PendingHostingSnapshotEntity): Promise<HostingSnapshotEntityRow> {
    const [created] = await tx
      .insert(hostingSnapshotEntities)
      .values({
        id: input.id,
        resourceId: input.resourceId,
        incarnation: input.incarnation,
        operationId: input.operationId,
        name: input.name,
        status: 'pending',
        includeRam: input.includeRam,
        data: pendingData(input),
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [existing] = await tx
      .select()
      .from(hostingSnapshotEntities)
      .where(
        and(
          eq(hostingSnapshotEntities.id, input.id),
          eq(hostingSnapshotEntities.resourceId, input.resourceId),
          eq(hostingSnapshotEntities.incarnation, input.incarnation)
        )
      )
      .limit(1);
    if (!existing) throw new Error('Snapshot entity idempotency conflict');
    return existing;
  }

  private async updateIfCurrent(
    db: EntityExecutor,
    row: HostingSnapshotEntityRow,
    patch: HostingSnapshotEntityTransition,
    observedSince?: Date
  ): Promise<HostingSnapshotEntityRow | null> {
    if (!snapshotPredatesObservation(row, observedSince)) return row;
    if (!snapshotEntityNeedsTransition(row, patch)) return row;
    const [updated] = await db
      .update(hostingSnapshotEntities)
      .set(transitionValues(row, patch))
      .where(
        and(
          eq(hostingSnapshotEntities.id, row.id),
          eq(hostingSnapshotEntities.resourceId, row.resourceId),
          eq(hostingSnapshotEntities.incarnation, row.incarnation),
          eq(hostingSnapshotEntities.updatedAt, row.updatedAt),
          ...(observedSince ? [lt(hostingSnapshotEntities.updatedAt, observedSince)] : [])
        )
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Revision-guarded public transition. If a provider refresh/worker update
   * wins the race, null tells the caller to use the newer durable row.
   */
  async transition(
    resourceId: string,
    incarnation: string,
    entityId: string,
    patch: HostingSnapshotEntityTransition
  ): Promise<HostingSnapshotEntityDto | null> {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as DrizzleClient;
      const [row] = await db
        .select()
        .from(hostingSnapshotEntities)
        .where(
          and(
            eq(hostingSnapshotEntities.id, entityId),
            eq(hostingSnapshotEntities.resourceId, resourceId),
            eq(hostingSnapshotEntities.incarnation, incarnation)
          )
        )
        .for('update');
      if (!row) return null;

      if (patch.providerSnapshotId && patch.providerSnapshotId !== row.providerSnapshotId) {
        const [duplicate] = await db
          .select()
          .from(hostingSnapshotEntities)
          .where(
            and(
              eq(hostingSnapshotEntities.resourceId, resourceId),
              eq(hostingSnapshotEntities.incarnation, incarnation),
              eq(hostingSnapshotEntities.providerSnapshotId, patch.providerSnapshotId),
              ne(hostingSnapshotEntities.id, row.id)
            )
          )
          .for('update');
        // A stale inventory import must yield to the original optimistic row,
        // retaining its entity/layout ID and any folder placement.
        if (duplicate) {
          if (row.status !== 'pending') return null;
          const retired = await this.updateIfCurrent(db, duplicate, {
            status: 'deleted',
            providerSnapshotId: null,
            error: null,
          });
          if (!retired) return null;
        }
      }

      const updated = await this.updateIfCurrent(db, row, patch);
      return updated ? publicHostingSnapshotEntity(updated) : null;
    });
  }

  /**
   * Merge a complete provider inventory captured after observedSince. Rows
   * newer than that pre-fetch timestamp are immutable to this stale read.
   */
  async mergeInventory(
    resourceId: string,
    incarnation: string,
    snapshots: HostingVmSnapshot[],
    observedSince?: Date
  ): Promise<HostingSnapshotEntityDto[]> {
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as DrizzleClient;
      const current = await db
        .select()
        .from(hostingSnapshotEntities)
        .where(
          and(eq(hostingSnapshotEntities.resourceId, resourceId), eq(hostingSnapshotEntities.incarnation, incarnation))
        )
        .for('update');
      const byProviderId = new Map(
        current.filter((row) => row.providerSnapshotId).map((row) => [row.providerSnapshotId!, row])
      );
      const seenProviderIds = new Set<string>();

      for (const incoming of snapshots) {
        const providerSnapshotId = incoming.providerSnapshotId ?? incoming.id;
        seenProviderIds.add(providerSnapshotId);
        const existing = byProviderId.get(providerSnapshotId);
        if (existing) {
          if (!shouldMergeProviderSnapshot(existing)) continue;
          // A known Proxmox gw<operationId> marker attaches provider evidence
          // to the pending entity but the worker alone resolves terminal state.
          await this.updateIfCurrent(
            db,
            existing,
            {
              ...(existing.status === 'pending' ? {} : { status: 'ready' as const, error: null }),
              data: providerData(incoming),
              providerSnapshotId,
              fingerprint: incoming.fingerprint,
            },
            observedSince
          );
          continue;
        }

        // DigitalOcean/Hetzner have no durable provider marker before the
        // task completes. Avoid inventing a duplicate while worker correlation
        // still owns a same-name unresolved pending entity.
        if (hasUnresolvedPendingSnapshotName(current, incoming.name)) continue;

        await db
          .insert(hostingSnapshotEntities)
          .values({
            id: snapshotLayoutId(resourceId, incoming.fingerprint),
            resourceId,
            incarnation,
            providerSnapshotId,
            fingerprint: incoming.fingerprint,
            name: incoming.name,
            status: 'ready',
            includeRam: incoming.includeRam ?? false,
            data: providerData(incoming),
          })
          .onConflictDoNothing();
      }

      for (const entity of current) {
        if (
          !shouldTombstoneMissingSnapshot(entity) ||
          !entity.providerSnapshotId ||
          seenProviderIds.has(entity.providerSnapshotId)
        )
          continue;
        // Pending/failed/deleting are deliberately never tombstoned by
        // absence. observedSince prevents an old list deleting a just-ready row.
        await this.updateIfCurrent(db, entity, { status: 'deleted', error: null }, observedSince);
      }
    });
    return this.list(resourceId, incarnation);
  }
}
