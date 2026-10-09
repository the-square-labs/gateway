import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerRegistryNodeBindings, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';
import { abandonedBuildBindings, purgeRevokedRegistryBindings } from './relay-registry-bindings.js';
import { RegistrySyncFailureLog, withinNodeSyncBound } from './relay-registry-sync.js';

const REGISTRY_PROXY_PORT = 5443;
const TOKEN_REFRESH_MS = 15_000;
const REVOKED_BINDING_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

type RegistryBindingRole = 'builder' | 'runtime' | 'mirror';
type RegistryBindingContext = 'build' | 'container' | 'deployment' | 'compose_project' | 'availability';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RelayRegistryService {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRevokedPurgeAt = 0;
  private readonly failures = new RegistrySyncFailureLog();
  private readonly nodeSyncs = new Map<string, Promise<void>>();
  private readonly queuedNodeSyncs = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly relayPolicy: RelayPolicyService,
    private readonly dispatch: NodeDispatchService,
    private readonly registry: DockerInternalRegistryService
  ) {}

  setEventBus(events: EventBusService): void {
    events.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; action?: unknown; status?: unknown } | null;
      if (typeof event?.id !== 'string' || event.action === 'deleted') return;
      if (event.status !== undefined && event.status !== 'online') return;
      // A new connection starts a new queue: a sync queued for the connection before it must not hold this one.
      if (event.status === 'online') {
        this.nodeSyncs.delete(event.id);
        this.queuedNodeSyncs.delete(event.id);
      }
      const nodeId = event.id;
      void this.syncNode(nodeId).then(
        () => this.failures.clear(nodeId),
        (error) => this.failures.report(nodeId, error, { nodeId })
      );
    });
  }

  start(): void {
    if (this.refreshTimer) return;
    const refresh = () => void this.refreshAll().catch((error) => this.failures.report('refresh', error));
    this.refreshTimer = setInterval(refresh, TOKEN_REFRESH_MS);
    this.refreshTimer.unref?.();
    refresh();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async ensureBinding(input: {
    nodeId: string;
    role: RegistryBindingRole;
    repository: string;
    actions: Array<'pull' | 'push'>;
    contextKind: RegistryBindingContext;
    contextId: string;
  }) {
    this.validate(input);
    const [existing] = await this.db
      .select()
      .from(dockerRegistryNodeBindings)
      .where(
        and(
          eq(dockerRegistryNodeBindings.nodeId, input.nodeId),
          eq(dockerRegistryNodeBindings.role, input.role),
          eq(dockerRegistryNodeBindings.contextKind, input.contextKind),
          eq(dockerRegistryNodeBindings.contextId, input.contextId),
          eq(dockerRegistryNodeBindings.repository, input.repository)
        )
      )
      .limit(1);
    const actions = [...new Set(input.actions)].sort();
    const [binding] = existing
      ? await this.db
          .update(dockerRegistryNodeBindings)
          .set({
            actions,
            status: 'active',
            generation: existing.generation + 1,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(dockerRegistryNodeBindings.id, existing.id))
          .returning()
      : await this.db
          .insert(dockerRegistryNodeBindings)
          .values({ ...input, actions })
          .returning();
    await this.syncNode(input.nodeId);
    return binding;
  }

  async revokeBinding(bindingId: string): Promise<void> {
    const [binding] = await this.db
      .select()
      .from(dockerRegistryNodeBindings)
      .where(eq(dockerRegistryNodeBindings.id, bindingId))
      .limit(1);
    if (!binding) return;
    await this.db
      .update(dockerRegistryNodeBindings)
      .set({ status: 'revoked', generation: binding.generation + 1, updatedAt: new Date() })
      .where(eq(dockerRegistryNodeBindings.id, binding.id));
    await this.relayPolicy.revokeOwner('registry_secure_link', binding.id, { allowDeferredSnapshot: true });
    await this.syncNode(binding.nodeId);
  }

  /**
   * Revokes the context's active bindings for repositories it no longer uses (an Availability policy keeps the ones
   * its pinned images live in): each rollout binds a new repository on every node, and the bindings of earlier ones
   * stayed active, so every sync of the node carried all of them (stand: 19 and 35 per node). Returns the count.
   */
  async retainContextBindings(input: {
    contextKind: RegistryBindingContext;
    contextId: string;
    repositories: readonly string[];
  }): Promise<number> {
    const keep = new Set(input.repositories);
    const active = await this.db
      .select()
      .from(dockerRegistryNodeBindings)
      .where(
        and(
          eq(dockerRegistryNodeBindings.contextKind, input.contextKind),
          eq(dockerRegistryNodeBindings.contextId, input.contextId),
          eq(dockerRegistryNodeBindings.status, 'active')
        )
      );
    const stale = active.filter((binding) => !keep.has(binding.repository));
    if (stale.length === 0) return 0;
    await this.db
      .update(dockerRegistryNodeBindings)
      .set({ status: 'revoked', generation: sql`${dockerRegistryNodeBindings.generation} + 1`, updatedAt: new Date() })
      .where(
        and(
          inArray(
            dockerRegistryNodeBindings.id,
            stale.map(({ id }) => id)
          ),
          eq(dockerRegistryNodeBindings.status, 'active')
        )
      );
    for (const binding of stale) {
      await this.relayPolicy.revokeOwner('registry_secure_link', binding.id, { allowDeferredSnapshot: true });
    }
    for (const nodeId of new Set(stale.map(({ nodeId }) => nodeId))) {
      await this.syncNode(nodeId).catch(() => undefined);
    }
    return stale.length;
  }

  async revokeContextBinding(input: {
    contextKind: RegistryBindingContext;
    contextId: string;
    nodeId?: string;
  }): Promise<void> {
    const conditions = [
      eq(dockerRegistryNodeBindings.contextKind, input.contextKind),
      eq(dockerRegistryNodeBindings.contextId, input.contextId),
      eq(dockerRegistryNodeBindings.status, 'active'),
    ];
    if (input.nodeId) conditions.push(eq(dockerRegistryNodeBindings.nodeId, input.nodeId));
    const bindings = await this.db
      .select()
      .from(dockerRegistryNodeBindings)
      .where(and(...conditions));
    if (!bindings.length) return;
    await this.db
      .update(dockerRegistryNodeBindings)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(
        inArray(
          dockerRegistryNodeBindings.id,
          bindings.map(({ id }) => id)
        )
      );
    const revocations = await Promise.allSettled(
      bindings.map((binding) =>
        this.relayPolicy.revokeOwner('registry_secure_link', binding.id, { allowDeferredSnapshot: true })
      )
    );
    // The route of a revoked binding is removed by the orphan sweep (removeOrphanedRelayState) if this failed.
    revocations.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.failures.report('revoke', result.reason, { bindingId: bindings[index]!.id });
      }
    });
    await Promise.allSettled([...new Set(bindings.map(({ nodeId }) => nodeId))].map((nodeId) => this.syncNode(nodeId)));
  }

  async moveRuntimeContextBinding(input: {
    contextKind: Exclude<RegistryBindingContext, 'build'>;
    sourceContextId: string;
    targetContextId: string;
    sourceNodeId: string;
    targetNodeId: string;
  }): Promise<void> {
    const revokedOwnerIds = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`docker-registry-runtime:${input.contextKind}:${input.sourceContextId}`}))`
      );
      const bindings = await tx
        .select()
        .from(dockerRegistryNodeBindings)
        .where(
          and(
            eq(dockerRegistryNodeBindings.role, 'runtime'),
            eq(dockerRegistryNodeBindings.contextKind, input.contextKind),
            or(
              and(
                eq(dockerRegistryNodeBindings.nodeId, input.sourceNodeId),
                eq(dockerRegistryNodeBindings.contextId, input.sourceContextId)
              ),
              and(
                eq(dockerRegistryNodeBindings.nodeId, input.targetNodeId),
                eq(dockerRegistryNodeBindings.contextId, input.targetContextId)
              )
            )
          )
        );
      const targetsByRepository = new Map(
        bindings
          .filter((binding) => binding.nodeId === input.targetNodeId && binding.contextId === input.targetContextId)
          .map((binding) => [binding.repository, binding])
      );
      const revoked: string[] = [];
      for (const source of bindings.filter(
        (binding) =>
          binding.status === 'active' &&
          binding.nodeId === input.sourceNodeId &&
          binding.contextId === input.sourceContextId
      )) {
        const target = targetsByRepository.get(source.repository);
        if (target && target.id !== source.id) {
          await tx
            .update(dockerRegistryNodeBindings)
            .set({
              actions: source.actions,
              status: 'active',
              generation: target.generation + 1,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(dockerRegistryNodeBindings.id, target.id));
          await tx
            .update(dockerRegistryNodeBindings)
            .set({ status: 'revoked', generation: source.generation + 1, updatedAt: new Date() })
            .where(eq(dockerRegistryNodeBindings.id, source.id));
          revoked.push(source.id);
          continue;
        }
        await tx
          .update(dockerRegistryNodeBindings)
          .set({
            nodeId: input.targetNodeId,
            contextId: input.targetContextId,
            generation: source.generation + 1,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(dockerRegistryNodeBindings.id, source.id));
      }
      return revoked;
    });

    await Promise.all(
      revokedOwnerIds.map((bindingId) =>
        this.relayPolicy.revokeOwner('registry_secure_link', bindingId, { allowDeferredSnapshot: true })
      )
    );
    await this.syncNode(input.sourceNodeId);
    await this.syncNode(input.targetNodeId);

    const [stale] = await this.db
      .select({ id: dockerRegistryNodeBindings.id })
      .from(dockerRegistryNodeBindings)
      .where(
        and(
          eq(dockerRegistryNodeBindings.role, 'runtime'),
          eq(dockerRegistryNodeBindings.contextKind, input.contextKind),
          eq(dockerRegistryNodeBindings.contextId, input.sourceContextId),
          eq(dockerRegistryNodeBindings.nodeId, input.sourceNodeId),
          eq(dockerRegistryNodeBindings.status, 'active')
        )
      )
      .limit(1);
    if (stale) throw new Error('Source node retained an active internal registry binding after migration');
  }

  async syncNode(nodeId: string): Promise<void> {
    // A sync that has not started yet reads the bindings when it starts, so it serves every later caller too.
    // Without this, refresh ticks queued behind a slow sync without bound and a new binding waited for all of them.
    const queued = this.queuedNodeSyncs.get(nodeId);
    if (queued) return queued;
    const previous = this.nodeSyncs.get(nodeId) ?? Promise.resolve();
    const current: Promise<void> = previous
      .catch(() => undefined)
      .then(() => {
        if (this.queuedNodeSyncs.get(nodeId) === current) this.queuedNodeSyncs.delete(nodeId);
        return withinNodeSyncBound(this.syncNodeLocked(nodeId), nodeId);
      });
    this.queuedNodeSyncs.set(nodeId, current);
    this.nodeSyncs.set(nodeId, current);
    try {
      await current;
    } finally {
      if (this.nodeSyncs.get(nodeId) === current) this.nodeSyncs.delete(nodeId);
      if (this.queuedNodeSyncs.get(nodeId) === current) this.queuedNodeSyncs.delete(nodeId);
    }
  }

  /** Every failure of a node's sync is recorded on its active bindings, not only a rejection by the daemon. */
  private async syncNodeLocked(nodeId: string): Promise<void> {
    try {
      await this.syncNodeBindings(nodeId);
    } catch (error) {
      await this.db
        .update(dockerRegistryNodeBindings)
        .set({ lastError: errorMessage(error), updatedAt: new Date() })
        .where(and(eq(dockerRegistryNodeBindings.nodeId, nodeId), eq(dockerRegistryNodeBindings.status, 'active')))
        .catch(() => undefined);
      throw error;
    }
  }

  private async syncNodeBindings(nodeId: string): Promise<void> {
    const bindings = await this.db
      .select()
      .from(dockerRegistryNodeBindings)
      .where(and(eq(dockerRegistryNodeBindings.nodeId, nodeId), eq(dockerRegistryNodeBindings.status, 'active')));
    // Nothing to sync to a node that cannot hold bindings: nginx, monitoring, relay and storage nodes, or a Docker
    // daemon without registry access support (it never got a binding, so there is none to clear either).
    if (bindings.length === 0 && !(await this.supportsRegistryBindings(nodeId))) return;
    // Context rows are independently revocable grants, not daemon transport rows.
    // Git releases and HA can legitimately share a repository on the same node.
    const repositories = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      this.validate({ ...binding, actions: binding.actions as Array<'pull' | 'push'> });
      const group = repositories.get(binding.repository) ?? [];
      group.push(binding);
      repositories.set(binding.repository, group);
    }
    const transportBindings = [...repositories.values()].map((group) => {
      // Never hide a builder/runtime profile conflict or synthesize broader grants.
      const builder = group.some((binding) => binding.role === 'builder');
      const mixedProfiles = builder && group.some((binding) => binding.role !== 'builder');
      const representative = [...group]
        .sort((a, b) => a.id.localeCompare(b.id))
        .find((candidate) =>
          group.every((binding) => binding.actions.every((action) => candidate.actions.includes(action)))
        );
      if (mixedProfiles || !representative) {
        throw new AppError(409, 'REGISTRY_BINDING_CONFLICT', 'Registry repository has incompatible active grants');
      }
      return representative;
    });
    // One policy publish and one grant sync for all routes, then tokens: each lives its full lifetime once sent.
    if (transportBindings.length > 0) {
      await this.relayPolicy.ensureInternalRegistryRoutes(
        transportBindings.map(({ id }) => id),
        nodeId,
        'registry_secure_link'
      );
    }
    const desired = [];
    for (const binding of transportBindings) {
      const actions = binding.actions as Array<'pull' | 'push'>;
      const issue = (granted: Array<'pull' | 'push'>) => {
        const requested = [{ repository: binding.repository, actions: granted }];
        return this.registry.issueToken({
          subject: `${binding.role}:${nodeId}:${binding.contextKind}:${binding.contextId}`,
          requested,
          allowed: requested,
          context:
            binding.contextKind === 'build'
              ? { nodeId, buildId: binding.contextId }
              : binding.contextKind === 'container'
                ? { nodeId, containerId: binding.contextId }
                : { nodeId, deploymentId: binding.contextId },
          ttlSeconds: 120,
        });
      };
      let issued: Awaited<ReturnType<typeof issue>>;
      try {
        issued = await issue(actions);
      } catch (error) {
        // While the registry takes no writes (garbage collection), a grant that may push is renewed for pulls only.
        // Failing the whole sync instead let every token of the node expire: its pulls failed too, and every
        // Availability change on it waited for the collection although it pulls images that are mirrored already.
        if (
          !(error instanceof AppError && error.code === 'INTERNAL_REGISTRY_NOT_WRITABLE') ||
          !actions.includes('pull')
        ) {
          throw error;
        }
        issued = await issue(actions.filter((action) => action !== 'push'));
      }
      desired.push({
        bindingId: binding.id,
        role: binding.role,
        generation: binding.generation,
        repository: binding.repository,
        actions: binding.actions as Array<'pull' | 'push'>,
        localAddress: '127.0.0.1' as const,
        localPort: REGISTRY_PROXY_PORT,
        relayOwnerKind: 'registry_secure_link' as const,
        relayOwnerId: binding.id,
        authorization: `Bearer ${issued.token}`,
        authorizationExpiresAtUnix: Math.floor(Date.parse(issued.issuedAt) / 1000) + issued.expiresIn,
      });
    }
    const result = await this.dispatch.sendDockerRegistryBindings(nodeId, desired);
    const now = new Date();
    if (!result.success) throw new Error(result.error || 'Docker daemon rejected internal registry bindings');
    // Replace the daemon snapshot before retiring old transport routes. Keep the
    // context grants active so revoking one owner cannot revoke another's access.
    const transportIds = new Set(transportBindings.map(({ id }) => id));
    for (const binding of bindings) {
      if (!transportIds.has(binding.id)) {
        await this.relayPolicy.revokeOwner('registry_secure_link', binding.id, { allowDeferredSnapshot: true });
      }
    }
    if (bindings.length) {
      await this.db
        .update(dockerRegistryNodeBindings)
        .set({ lastSyncedAt: now, lastError: null, updatedAt: now })
        .where(
          inArray(
            dockerRegistryNodeBindings.id,
            bindings.map(({ id }) => id)
          )
        );
    }
  }

  private async supportsRegistryBindings(nodeId: string): Promise<boolean> {
    const [node] = await this.db
      .select({ type: nodes.type, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    const reported = (node?.capabilities as Record<string, unknown> | null)?.capabilities;
    return node?.type === 'docker' && Array.isArray(reported) && reported.includes('docker_registry_proxy_v1');
  }

  private async refreshAll(): Promise<void> {
    await this.revokeAbandonedBuildBindings();
    await this.purgeRevokedBindings();
    const rows = await this.db
      .select({ nodeId: dockerRegistryNodeBindings.nodeId })
      .from(dockerRegistryNodeBindings)
      .where(eq(dockerRegistryNodeBindings.status, 'active'));
    const nodeIds = [...new Set(rows.map(({ nodeId }) => nodeId))];
    const results = await Promise.allSettled(nodeIds.map((nodeId) => this.syncNode(nodeId)));
    results.forEach((result, index) => {
      const nodeId = nodeIds[index]!;
      if (result.status === 'rejected') this.failures.report(nodeId, result.reason, { nodeId });
      else this.failures.clear(nodeId);
    });
    this.failures.clear('refresh');
  }

  private async purgeRevokedBindings(now = Date.now()): Promise<void> {
    if (now - this.lastRevokedPurgeAt < REVOKED_BINDING_PURGE_INTERVAL_MS) return;
    this.lastRevokedPurgeAt = now;
    await purgeRevokedRegistryBindings(this.db, now);
  }

  private async revokeAbandonedBuildBindings(): Promise<void> {
    // One binding that cannot be revoked (its builder offline) must not hold back the others or the token refresh.
    for (const binding of await abandonedBuildBindings(this.db)) {
      await this.revokeBinding(binding.id).catch((error) =>
        this.failures.report('revoke', error, { bindingId: binding.id, nodeId: binding.nodeId })
      );
    }
  }

  private validate(input: { role: RegistryBindingRole; repository: string; actions: Array<'pull' | 'push'> }): void {
    if (!REPOSITORY_PATTERN.test(input.repository)) {
      throw new AppError(400, 'INVALID_REGISTRY_REPOSITORY', 'Internal registry repository is invalid');
    }
    const actions = new Set(input.actions);
    if (!actions.size || [...actions].some((action) => action !== 'pull' && action !== 'push')) {
      throw new AppError(400, 'INVALID_REGISTRY_ACTIONS', 'Registry binding actions are invalid');
    }
    if (input.role === 'runtime' && (actions.size !== 1 || !actions.has('pull'))) {
      throw new AppError(403, 'REGISTRY_RUNTIME_PULL_ONLY', 'Runtime registry bindings are pull-only');
    }
  }
}
