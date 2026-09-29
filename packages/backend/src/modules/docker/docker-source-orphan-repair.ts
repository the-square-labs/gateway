import { and, eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { DockerSourceService } from './docker-source.service.js';

const logger = createChildLogger('DockerSourceOrphanRepair');

export interface DockerSourceOrphanRepairDeps {
  /** True only while the node's daemon is connected. */
  isNodeOnline(nodeId: string): boolean;
  /** Live container list of the node (the same command Gateway's container lists use). */
  listContainers(nodeId: string): Promise<{ success: boolean; detail?: string }>;
}

function listedNames(result: { success: boolean; detail?: string }): Set<string> | null {
  if (!result.success || !result.detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.detail);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    const name = String(entry.name ?? entry.Name ?? '').replace(/^\/+/, '');
    if (name) names.add(name);
    const listedNamesArray = entry.Names;
    if (Array.isArray(listedNamesArray)) {
      for (const alias of listedNamesArray) names.add(String(alias).replace(/^\/+/, ''));
    }
  }
  return names;
}

/**
 * Container source bindings whose container no longer exists: older releases
 * left the binding behind when a container was removed, so its auto-build kept
 * polling and a later container of the same name inherited it. A binding is
 * removed only when its node is online, the node's live container list was read
 * successfully and has no such container, and the binding is not a Git source
 * container that legitimately has no container yet (first build pending or a
 * rollout in flight). Offline nodes and unknown inventory are never touched.
 * Idempotent; returns the number of removed bindings.
 */
export async function repairOrphanedContainerSourceBindings(
  db: DrizzleClient,
  deps: DockerSourceOrphanRepairDeps
): Promise<number> {
  const rows = await db
    .select({
      id: dockerSourceBindings.id,
      nodeId: dockerSourceBindings.nodeId,
      containerName: dockerSourceBindings.containerName,
      initialConfig: dockerSourceBindings.initialConfig,
      deployedCommitSha: dockerSourceBindings.deployedCommitSha,
      deployingCommitSha: dockerSourceBindings.deployingCommitSha,
    })
    .from(dockerSourceBindings)
    .where(eq(dockerSourceBindings.targetKind, 'container'));

  const byNode = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.nodeId || !row.containerName) continue;
    byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  }

  let removed = 0;
  for (const [nodeId, bindings] of byNode) {
    try {
      if (!deps.isNodeOnline(nodeId)) continue;
      const names = listedNames(await deps.listContainers(nodeId));
      if (!names) continue;
      const service = container.isRegistered(DockerSourceService) ? container.resolve(DockerSourceService) : null;
      const pendingNames = new Set(
        (service ? await service.listPendingContainers(nodeId) : []).map((p) => p.containerName)
      );

      for (const binding of bindings) {
        const containerName = binding.containerName as string;
        if (names.has(containerName) || pendingNames.has(containerName)) continue;
        // A Git source waiting for its first build owns its name without a container; a rollout in flight
        // removes the old container before creating the new one.
        const awaitingFirstBuild = binding.initialConfig != null && binding.deployedCommitSha == null;
        if (awaitingFirstBuild || binding.deployingCommitSha != null) continue;
        try {
          if (service) {
            await service.remove({ kind: 'container', nodeId, containerName }, 'system');
          } else {
            await db
              .delete(dockerSourceBindings)
              .where(and(eq(dockerSourceBindings.id, binding.id), eq(dockerSourceBindings.targetKind, 'container')));
          }
          removed += 1;
          logger.info('Removed the Git source binding of a container that no longer exists', {
            nodeId,
            containerName,
            bindingId: binding.id,
          });
        } catch (error) {
          logger.warn('Failed to remove an orphaned container source binding', {
            nodeId,
            containerName,
            bindingId: binding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('Skipped orphaned container source binding check for a node', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}
