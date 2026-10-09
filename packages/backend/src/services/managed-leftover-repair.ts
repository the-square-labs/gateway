import { inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedDatabaseInstances, managedStorageClusters, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('ManagedLeftoverRepair');

export type ManagedLeftoverKind = 'storage' | 'database';

/** One id a node keeps something of without a readable record (docker daemon `leftovers`). */
export interface ManagedLeftover {
  id: string;
  record: 'unreadable' | 'missing';
  readError?: string;
  containers?: string[];
  imageBytes: number;
  allocatedBytes: number;
}

export interface ManagedLeftoverRepairDeps {
  /** True only while the node's daemon is connected. */
  isNodeOnline(nodeId: string): boolean;
  /** The node's leftovers of one kind; an older daemon answers that it does not know the action. */
  listLeftovers(
    nodeId: string,
    kind: ManagedLeftoverKind
  ): Promise<{ success: boolean; detail?: string; error?: string }>;
  /** Removes everything of the id the node keeps, as a leftover Gateway has no instance of. */
  removeLeftover(nodeId: string, kind: ManagedLeftoverKind, id: string): Promise<{ success: boolean; error?: string }>;
  /** Records a removal in the audit log. */
  audit(entry: { nodeId: string; kind: ManagedLeftoverKind; leftover: ManagedLeftover }): Promise<void>;
  now?(): number;
}

/** A leftover must be seen without a Gateway instance in two passes at least this far apart before it is removed. */
export const LEFTOVER_CONFIRMATION_MS = 5 * 60 * 1000;

function parseLeftovers(result: { success: boolean; detail?: string }): ManagedLeftover[] | null {
  if (!result.success || !result.detail) return null;
  try {
    const parsed = JSON.parse(result.detail) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.filter(
      (item): item is ManagedLeftover =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as ManagedLeftover).id === 'string' &&
        ((item as ManagedLeftover).record === 'unreadable' || (item as ManagedLeftover).record === 'missing')
    );
  } catch {
    return null;
  }
}

/**
 * What managed databases and storage leave on their nodes without a record:
 * a container a delete or an interrupted recreation left behind, or a record
 * zeroed by a crash with its image and mount point (the rc.8 stand: an exited
 * container of a deleted storage, and a zeroed record whose 2 GiB image kept
 * counting toward the node's promised capacity). The node cannot tell such an
 * id from a live instance whose record it lost; Gateway can.
 *
 * An id is removed only when its node is online, its daemon listed it, and
 * Gateway has no managed database (or storage cluster, on any node) of that id
 * in two passes at least {@link LEFTOVER_CONFIRMATION_MS} apart, checked
 * again right before the removal. The daemon refuses the removal of an id it
 * has a readable record of. Each removal is audited. Sightings are kept in
 * memory only; an offline node or a failed listing forgets them. Idempotent.
 */
export class ManagedLeftoverRepair {
  private readonly firstSeen = new Map<string, number>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly deps: ManagedLeftoverRepairDeps
  ) {}

  private forget(prefix: string) {
    for (const key of this.firstSeen.keys()) if (key.startsWith(prefix)) this.firstSeen.delete(key);
  }

  private async instanceIds(kind: ManagedLeftoverKind): Promise<Set<string>> {
    const table = kind === 'storage' ? managedStorageClusters : managedDatabaseInstances;
    return new Set((await this.db.select({ id: table.id }).from(table)).map((row) => row.id));
  }

  /** Runs one pass; returns the number of removed leftovers. */
  async run(): Promise<number> {
    const now = (this.deps.now ?? Date.now)();
    const managedNodes = await this.db
      .select({ id: nodes.id, type: nodes.type })
      .from(nodes)
      .where(inArray(nodes.type, ['storage', 'databases']));
    const storageIds = await this.instanceIds('storage');
    const databaseIds = await this.instanceIds('database');
    const managedNodeIds = new Set(managedNodes.map((node) => node.id));
    for (const key of this.firstSeen.keys()) if (!managedNodeIds.has(key.split('|')[1]!)) this.firstSeen.delete(key);

    let removed = 0;
    for (const node of managedNodes) {
      if (!this.deps.isNodeOnline(node.id)) {
        this.forget(`storage|${node.id}|`);
        this.forget(`database|${node.id}|`);
        continue;
      }
      const kinds: ManagedLeftoverKind[] = node.type === 'storage' ? ['database', 'storage'] : ['database'];
      for (const kind of kinds) {
        const prefix = `${kind}|${node.id}|`;
        let leftovers: ManagedLeftover[] | null;
        try {
          leftovers = parseLeftovers(await this.deps.listLeftovers(node.id, kind));
        } catch {
          leftovers = null;
        }
        if (!leftovers) {
          // Offline meanwhile, busy, or a daemon without the action: nothing is known.
          this.forget(prefix);
          continue;
        }
        const known = kind === 'storage' ? storageIds : databaseIds;
        const listed = new Set(leftovers.map((item) => item.id));
        for (const key of this.firstSeen.keys()) {
          if (key.startsWith(prefix) && !listed.has(key.slice(prefix.length))) this.firstSeen.delete(key);
        }
        for (const leftover of leftovers) {
          const key = prefix + leftover.id;
          if (known.has(leftover.id)) {
            // A live instance whose record the node cannot read: not a leftover, and not Gateway's to remove.
            this.firstSeen.delete(key);
            if (leftover.record === 'unreadable') {
              logger.warn(
                'A managed instance record on its node cannot be read; the instance needs a restart or repair',
                {
                  nodeId: node.id,
                  kind,
                  id: leftover.id,
                  error: leftover.readError,
                }
              );
            }
            continue;
          }
          const first = this.firstSeen.get(key);
          if (first === undefined) {
            this.firstSeen.set(key, now);
            continue;
          }
          if (now - first < LEFTOVER_CONFIRMATION_MS) continue;
          try {
            // Checked again right before the removal: a create may have taken the id since the pass began.
            if ((await this.instanceIds(kind)).has(leftover.id)) {
              this.firstSeen.delete(key);
              continue;
            }
            const result = await this.deps.removeLeftover(node.id, kind, leftover.id);
            if (!result.success) throw new Error(result.error || 'the node did not remove it');
            this.firstSeen.delete(key);
            removed += 1;
            logger.info('Removed what a managed instance Gateway no longer has left on its node', {
              nodeId: node.id,
              kind,
              id: leftover.id,
              record: leftover.record,
              containers: leftover.containers ?? [],
              imageBytes: leftover.imageBytes,
              allocatedBytes: leftover.allocatedBytes,
            });
            await this.deps.audit({ nodeId: node.id, kind, leftover }).catch((error) =>
              logger.warn('The removal of a managed leftover could not be audited', {
                nodeId: node.id,
                id: leftover.id,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          } catch (error) {
            logger.warn('A managed leftover on a node could not be removed; retried on the next pass', {
              nodeId: node.id,
              kind,
              id: leftover.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    return removed;
  }
}
