import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { dockerAccessResources } from '@/db/schema/index.js';
import { dockerChildScopeResourceId } from './docker-access-resource.service.js';
import { rewritePersistedDockerResourceScopes } from './docker-access-resource-scope-rewrite.js';

function networkId(network: Record<string, unknown>): string {
  return String(network.id ?? network.Id ?? '');
}

export class DockerNetworkAccessResourceService {
  constructor(private readonly db: DrizzleClient) {}

  async syncNetworks(nodeId: string, networks: Array<Record<string, unknown>>): Promise<Map<string, string>> {
    const ids = networks.map(networkId).filter(Boolean);
    for (const id of ids) await this.ensureNetwork(nodeId, id);
    const rows = await this.db
      .select({ id: dockerAccessResources.id, resourceKey: dockerAccessResources.resourceKey })
      .from(dockerAccessResources)
      .where(and(eq(dockerAccessResources.nodeId, nodeId), eq(dockerAccessResources.resourceType, 'network')));
    return new Map(rows.map((row) => [row.resourceKey, row.id]));
  }

  async ensureNetwork(nodeId: string, networkId: string, executor?: DrizzleExecutor): Promise<string> {
    const ensure = async (tx: DrizzleExecutor) => {
      await this.lockNetworkIdentity(tx, nodeId, networkId);
      const [existing] = await tx
        .select({ id: dockerAccessResources.id })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'network'),
            eq(dockerAccessResources.resourceKey, networkId)
          )
        )
        .limit(1);
      if (existing) return existing.id;
      const [created] = await tx
        .insert(dockerAccessResources)
        .values({ nodeId, resourceType: 'network', resourceKey: networkId, runtimeId: networkId })
        .returning({ id: dockerAccessResources.id });
      return created.id;
    };
    return executor ? ensure(executor) : this.db.transaction(ensure);
  }

  async resolveNetwork(nodeId: string, networkId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: dockerAccessResources.id })
      .from(dockerAccessResources)
      .where(
        and(
          eq(dockerAccessResources.nodeId, nodeId),
          eq(dockerAccessResources.resourceType, 'network'),
          eq(dockerAccessResources.resourceKey, networkId)
        )
      )
      .limit(1);
    return row?.id ?? null;
  }

  async resolveNetworkResourceKey(nodeId: string, resourceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ resourceKey: dockerAccessResources.resourceKey })
      .from(dockerAccessResources)
      .where(
        and(
          eq(dockerAccessResources.id, resourceId),
          eq(dockerAccessResources.nodeId, nodeId),
          eq(dockerAccessResources.resourceType, 'network')
        )
      )
      .limit(1);
    return row?.resourceKey ?? null;
  }

  async removeNetwork(nodeId: string, networkId: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await this.lockNetworkIdentity(tx, nodeId, networkId);
      const [row] = await tx
        .select({ id: dockerAccessResources.id })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'network'),
            eq(dockerAccessResources.resourceKey, networkId)
          )
        )
        .limit(1);
      if (!row) return null;
      await rewritePersistedDockerResourceScopes(tx, dockerChildScopeResourceId(nodeId, row.id), null);
      await tx.delete(dockerAccessResources).where(eq(dockerAccessResources.id, row.id));
      return row.id;
    });
  }

  private async lockNetworkIdentity(tx: DrizzleExecutor, nodeId: string, networkId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-network-access:${nodeId}:${networkId}`}))`);
  }
}
