import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuilds, dockerRegistryNodeBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';

const REGISTRY_PROXY_PORT = 5443;
const TOKEN_REFRESH_MS = 15_000;
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

type RegistryBindingRole = 'builder' | 'runtime';
type RegistryBindingContext = 'build' | 'container' | 'deployment';

export class RelayRegistryService {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly nodeSyncs = new Map<string, Promise<void>>();

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
      void this.syncNode(event.id).catch(() => undefined);
    });
  }

  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.refreshAll().catch(() => undefined), TOKEN_REFRESH_MS);
    this.refreshTimer.unref?.();
    void this.refreshAll().catch(() => undefined);
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
    await Promise.allSettled(
      bindings.map((binding) =>
        this.relayPolicy.revokeOwner('registry_secure_link', binding.id, { allowDeferredSnapshot: true })
      )
    );
    await Promise.all([...new Set(bindings.map(({ nodeId }) => nodeId))].map((nodeId) => this.syncNode(nodeId)));
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
    const previous = this.nodeSyncs.get(nodeId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.syncNodeLocked(nodeId));
    this.nodeSyncs.set(nodeId, current);
    try {
      await current;
    } finally {
      if (this.nodeSyncs.get(nodeId) === current) this.nodeSyncs.delete(nodeId);
    }
  }

  private async syncNodeLocked(nodeId: string): Promise<void> {
    const bindings = await this.db
      .select()
      .from(dockerRegistryNodeBindings)
      .where(and(eq(dockerRegistryNodeBindings.nodeId, nodeId), eq(dockerRegistryNodeBindings.status, 'active')));
    const desired = [];
    for (const binding of bindings) {
      await this.relayPolicy.ensureInternalRegistryRoute(binding.id, nodeId, 'registry_secure_link');
      const requested = [{ repository: binding.repository, actions: binding.actions as Array<'pull' | 'push'> }];
      const issued = await this.registry.issueToken({
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
    if (!result.success) {
      const message = result.error || 'Docker daemon rejected internal registry bindings';
      if (bindings.length) {
        await this.db
          .update(dockerRegistryNodeBindings)
          .set({ lastError: message, updatedAt: now })
          .where(
            inArray(
              dockerRegistryNodeBindings.id,
              bindings.map(({ id }) => id)
            )
          );
      }
      throw new Error(message);
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

  private async refreshAll(): Promise<void> {
    await this.revokeAbandonedBuildBindings();
    const rows = await this.db
      .select({ nodeId: dockerRegistryNodeBindings.nodeId })
      .from(dockerRegistryNodeBindings)
      .where(eq(dockerRegistryNodeBindings.status, 'active'));
    await Promise.allSettled([...new Set(rows.map(({ nodeId }) => nodeId))].map((nodeId) => this.syncNode(nodeId)));
  }

  private async revokeAbandonedBuildBindings(): Promise<void> {
    const bindings = await this.db
      .select({
        id: dockerRegistryNodeBindings.id,
        nodeId: dockerRegistryNodeBindings.nodeId,
        buildId: dockerRegistryNodeBindings.contextId,
      })
      .from(dockerRegistryNodeBindings)
      .where(and(eq(dockerRegistryNodeBindings.contextKind, 'build'), eq(dockerRegistryNodeBindings.status, 'active')));
    if (!bindings.length) return;
    const buildIds = bindings.map(({ buildId }) => buildId).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const builds = buildIds.length
      ? await this.db
          .select({ id: dockerBuilds.id, status: dockerBuilds.status, builderNodeId: dockerBuilds.builderNodeId })
          .from(dockerBuilds)
          .where(inArray(dockerBuilds.id, buildIds))
      : [];
    const active = new Map(builds.map((build) => [build.id, build]));
    const activeStatuses = new Set(['claimed', 'checking_out', 'building', 'scanning', 'pushing']);
    const abandoned = bindings.filter((binding) => {
      const build = active.get(binding.buildId);
      return !build || !activeStatuses.has(build.status) || build.builderNodeId !== binding.nodeId;
    });
    for (const binding of abandoned) {
      await this.revokeBinding(binding.id);
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
