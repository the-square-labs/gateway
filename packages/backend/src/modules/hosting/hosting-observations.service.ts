import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingFirewalls, hostingResources, integrationConnectors } from '@/db/schema/index.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { HostingConnectorsService } from './hosting-connectors.service.js';
import { HOSTING_ACCOUNT_SUMMARY_SNAPSHOT } from './hosting-inventory.service.js';
import { HOSTING_PROVIDERS, type HostingAccountSummary } from './hosting-provider.types.js';

export interface HostingAccountObservation {
  connectorId: string;
  name: string;
  provider: string;
  syncStatus: string;
  observedAt: string;
  summary: HostingAccountSummary | null;
}
/** Read persisted provider observations only. These internal channels are not WebSocket subscriptions. */
export class HostingObservationsService {
  constructor(
    private db: DrizzleClient,
    private connectors: HostingConnectorsService,
    private snapshots: ResourceSnapshotStore,
    private events: EventBusService
  ) {}
  async publish(connectorId?: string) {
    const accounts = await this.db
      .select()
      .from(integrationConnectors)
      .where(
        and(
          eq(integrationConnectors.enabled, true),
          inArray(integrationConnectors.provider, [...HOSTING_PROVIDERS]),
          connectorId ? eq(integrationConnectors.id, connectorId) : undefined
        )
      );
    for (const account of accounts) {
      const revision = (value: typeof account) =>
        JSON.stringify([value.enabled, value.updatedAt, value.syncStatus, value.syncFinishedAt, value.syncStartedAt]);
      const capturedRevision = revision(account);
      const pending: Array<{ channel: string; payload: unknown }> = [];
      const queue = (channel: string, payload: unknown) => pending.push({ channel, payload });
      const publishCurrent = async () => {
        const current = await this.connectors.get(account.id).catch(() => null);
        if (!current || revision(current) !== capturedRevision) return;
        // No asynchronous work between the final revision fence and publication.
        for (const event of pending) this.events.publish(event.channel, event.payload);
      };
      const settings = this.connectors.settings(account);
      const maxAge = Math.max(180_000, settings.autoSyncIntervalSeconds * 2000);
      const observedAt = account.syncFinishedAt;
      const fresh = !!observedAt && Date.now() - observedAt.getTime() <= maxAge;
      const cached = await this.snapshots.get<{ configurationRevision: string; summary: HostingAccountSummary }>(
        HOSTING_ACCOUNT_SUMMARY_SNAPSHOT,
        account.id
      );
      const summary =
        cached?.refreshStatus === 'success' &&
        cached.data.configurationRevision === account.updatedAt.toISOString() &&
        Number.isFinite(Date.parse(cached.data.summary.observedAt)) &&
        Date.now() - Date.parse(cached.data.summary.observedAt) <= maxAge
          ? cached.data.summary
          : null;
      if (fresh || account.syncStatus === 'error')
        queue('hosting.account.observed', {
          connectorId: account.id,
          name: account.name,
          provider: account.provider,
          syncStatus: account.syncStatus,
          observedAt: (account.syncFinishedAt ?? account.updatedAt).toISOString(),
          summary: account.syncStatus === 'success' ? summary : null,
        } satisfies HostingAccountObservation);
      if (!fresh || account.syncStatus !== 'success') {
        await publishCurrent();
        continue;
      }
      const resources = await this.db
        .select()
        .from(hostingResources)
        .where(eq(hostingResources.connectorId, account.id));
      for (const resource of resources) {
        if (settings.resourceIds.length && !settings.resourceIds.includes(resource.remoteId)) continue;
        if (resource.incarnation !== resource.snapshot.incarnation) continue;
        if (!resource.missingSince && Date.now() - resource.observedAt.getTime() > maxAge) continue;
        queue('hosting.vm.observed', {
          connectorId: account.id,
          resourceId: resource.id,
          name: resource.snapshot.name,
          provider: account.provider,
          remoteId: resource.remoteId,
          powerState: resource.missingSince ? 'missing' : resource.snapshot.powerState,
          observedAt: resource.observedAt.toISOString(),
        });
        const [firewall] = await this.db
          .select()
          .from(hostingFirewalls)
          .where(eq(hostingFirewalls.resourceId, resource.id));
        if (
          firewall &&
          firewall.connectorRevision === account.updatedAt.toISOString() &&
          Date.now() - (firewall.observedAt ?? firewall.updatedAt).getTime() <= maxAge
        )
          queue('hosting.firewall.observed', {
            connectorId: account.id,
            resourceId: resource.id,
            name: resource.snapshot.name,
            provider: account.provider,
            status: firewall.status,
            error: firewall.error,
          });
      }
      await publishCurrent();
    }
  }
}
