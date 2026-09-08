import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingResources } from '@/db/schema/index.js';
import type { ResourceSnapshotEnvelope, ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import type { HostingConnectorRow, HostingConnectorsService } from './hosting-connectors.service.js';
import type { HostingResourceSnapshot } from './hosting-provider.types.js';
import type { HostingVmSnapshot } from './hosting-snapshot.types.js';

export const HOSTING_VM_SNAPSHOT_READ_MODEL = 'hosting-vm-snapshots';
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 180_000;
type Target = { resource: typeof hostingResources.$inferSelect; connector: HostingConnectorRow };
export interface CachedHostingVmSnapshots {
  connectorId: string;
  configurationRevision: string;
  incarnation: string;
  remoteId: string;
  powerState: HostingResourceSnapshot['powerState'];
  snapshots: HostingVmSnapshot[];
}
export function snapshotCacheMatches(
  cached: ResourceSnapshotEnvelope<CachedHostingVmSnapshots> | null,
  target: Target
): boolean {
  return (
    !!cached &&
    cached.data.connectorId === target.connector.id &&
    cached.data.configurationRevision === target.connector.updatedAt.toISOString() &&
    cached.data.incarnation === target.resource.incarnation &&
    cached.data.remoteId === target.resource.remoteId
  );
}
export function snapshotCacheFresh(
  cached: ResourceSnapshotEnvelope<CachedHostingVmSnapshots> | null,
  target: Target
): boolean {
  return (
    snapshotCacheMatches(cached, target) &&
    cached!.refreshStatus === 'success' &&
    cached!.availability === 'available' &&
    Number.isFinite(Date.parse(cached!.observedAt ?? '')) &&
    Date.now() - Date.parse(cached!.observedAt!) < MAX_AGE_MS
  );
}
/** Provider reads belong to background refresh, never to the snapshot view GET. */
export class HostingSnapshotReadModel {
  private refreshes = new Map<string, Promise<void>>();
  constructor(
    private db: DrizzleClient,
    private connectors: HostingConnectorsService,
    private store: ResourceSnapshotStore | undefined,
    private authorize: (id: string, user: User) => Promise<Target>,
    private onInventory?: (target: Target, snapshots: HostingVmSnapshot[], startedAt: Date) => Promise<void>
  ) {}
  async get(id: string) {
    return (await this.store?.get<CachedHostingVmSnapshots>(HOSTING_VM_SNAPSHOT_READ_MODEL, id)) ?? null;
  }
  async invalidate(id: string) {
    await this.store?.remove(HOSTING_VM_SNAPSHOT_READ_MODEL, id);
  }
  private async target(id: string): Promise<Target | null> {
    const [resource] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, id));
    if (!resource?.connectorId || resource.missingSince || resource.origin === 'discovered' || !resource.incarnation)
      return null;
    try {
      const connector = await this.connectors.get(resource.connectorId, undefined, true);
      if (!connector.enabled) return null;
      return await this.authorize(id, await this.connectors.owner(connector));
    } catch {
      return null;
    }
  }
  refresh(id: string): Promise<void> {
    const running = this.refreshes.get(id);
    if (running) return running;
    const work = this.refreshOne(id).finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, work);
    return work;
  }
  /** A refresh started before completion may still contain the old inventory. */
  async refreshAfterOperation(id: string): Promise<void> {
    await this.refreshes.get(id);
    await this.refresh(id);
  }
  private async refreshOne(id: string): Promise<void> {
    if (!this.store) return;
    const target = await this.target(id);
    if (!target) {
      await this.invalidate(id);
      return;
    }
    const data: CachedHostingVmSnapshots = {
      connectorId: target.connector.id,
      configurationRevision: target.connector.updatedAt.toISOString(),
      incarnation: target.resource.incarnation!,
      remoteId: target.resource.remoteId,
      powerState: target.resource.snapshot.powerState,
      snapshots: [],
    };
    await this.store.withLease(HOSTING_VM_SNAPSHOT_READ_MODEL, id, async (lease) => {
      const current = async () => {
        const next = await this.target(id);
        return next &&
          next.connector.id === data.connectorId &&
          next.connector.updatedAt.toISOString() === data.configurationRevision &&
          next.resource.incarnation === data.incarnation &&
          next.resource.remoteId === data.remoteId
          ? next
          : null;
      };
      try {
        await this.store!.markRefreshing(HOSTING_VM_SNAPSHOT_READ_MODEL, id, data, 'unknown', lease);
        const adapter = this.connectors.adapter(target.connector);
        if (!adapter.snapshots) {
          await this.invalidate(id);
          return;
        }
        const live = await adapter.getResource(data.remoteId);
        if (!live || live.incarnation !== data.incarnation) throw Error('VM identity changed');
        const startedAt = new Date();
        data.snapshots = await adapter.snapshots().list(live);
        data.powerState = live.powerState;
        if (!(await current())) return;
        await this.onInventory?.(target, data.snapshots, startedAt);
        await this.store!.replace(HOSTING_VM_SNAPSHOT_READ_MODEL, id, data, { lease, availability: 'available' });
      } catch {
        if (!(await current())) return;
        await this.store!.markError(
          HOSTING_VM_SNAPSHOT_READ_MODEL,
          id,
          data,
          'Snapshot refresh failed',
          'unavailable',
          lease
        );
      }
      this.connectors.changed(target.connector.id);
    });
  }
  async refreshDue() {
    if (!this.store) return;
    // Includes detached resources so connector removal clears their old read models too.
    const resources = await this.db.select({ id: hostingResources.id }).from(hostingResources);
    for (const { id } of resources) {
      const target = await this.target(id);
      if (!target) {
        await this.invalidate(id);
        continue;
      }
      if (!this.connectors.adapter(target.connector).snapshots) {
        await this.invalidate(id);
        continue;
      }
      const cached = await this.get(id);
      if (snapshotCacheMatches(cached, target) && Date.now() - Date.parse(cached?.lastAttemptAt ?? '') < REFRESH_MS)
        continue;
      await this.refresh(id);
    }
  }
}
