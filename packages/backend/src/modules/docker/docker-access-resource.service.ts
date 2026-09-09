import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { dockerAccessResources, dockerBuilds, dockerDeployments, dockerSourceBindings } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import { rewritePersistedDockerResourceScopes } from './docker-access-resource-scope-rewrite.js';

export function dockerChildScopeResourceId(nodeId: string, resourceId: string): string {
  return `${nodeId}/${resourceId}`;
}

export function parseDockerChildScopeResourceId(value: string): { nodeId: string; resourceId: string } | null {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { nodeId: value.slice(0, separator), resourceId: value.slice(separator + 1) };
}

export function hasDockerResourceScope(
  scopes: string[],
  baseScope: string,
  nodeId: string,
  resourceId: string
): boolean {
  return (
    hasScope(scopes, baseScope) ||
    hasScope(scopes, `${baseScope}:${nodeId}`) ||
    hasScope(scopes, `${baseScope}:${dockerChildScopeResourceId(nodeId, resourceId)}`)
  );
}

export function dockerScopedNodeIds(scopes: readonly string[], baseScopes: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) {
    const base = extractBaseScope(scope);
    if (scope === base) continue;
    const resourceId = scope.slice(base.length + 1);
    if (resourceId.startsWith('folder/') || resourceId.startsWith('provider/') || resourceId.startsWith('account/'))
      continue;
    if (!baseScopes.some((requiredBase) => hasScope([scope], `${requiredBase}:${resourceId}`))) continue;
    if (resourceId.startsWith('node/')) {
      ids.add(resourceId.slice('node/'.length));
      continue;
    }
    const child = parseDockerChildScopeResourceId(resourceId);
    ids.add(child?.nodeId ?? resourceId);
  }
  return [...ids];
}

type ContainerIdentity = {
  name: string;
  runtimeId: string;
};

function containerName(container: Record<string, unknown>): string {
  return String(container.name ?? container.Name ?? '').replace(/^\/+/, '');
}

function containerRuntimeId(container: Record<string, unknown>): string {
  return String(container.id ?? container.Id ?? '');
}

export class DockerAccessResourceService {
  private readonly containerIdsByName = new Map<string, string>();
  private readonly containerIdsByRuntime = new Map<string, string>();

  constructor(private readonly db: DrizzleClient) {}

  cachedContainerResourceId(nodeId: string, options: { name?: string; runtimeId?: string }): string | null {
    if (options.runtimeId) {
      const byRuntime = this.containerIdsByRuntime.get(`${nodeId}:${options.runtimeId}`);
      if (byRuntime) return byRuntime;
    }
    return options.name ? (this.containerIdsByName.get(`${nodeId}:${options.name}`) ?? null) : null;
  }

  async syncContainers(
    nodeId: string,
    containers: Array<Record<string, unknown>>,
    preserveRuntimeChanges: ReadonlySet<string> = new Set()
  ): Promise<Map<string, string>> {
    const normalized = containers
      .filter((container) => container.pendingSourceBuild !== true)
      .map((container) => ({ name: containerName(container), runtimeId: containerRuntimeId(container) }))
      .filter((container): container is ContainerIdentity => !!container.name && !!container.runtimeId);

    for (const identity of normalized) {
      await this.ensureContainer(nodeId, identity.name, identity.runtimeId, preserveRuntimeChanges.has(identity.name));
    }

    const rows = await this.db
      .select()
      .from(dockerAccessResources)
      .where(and(eq(dockerAccessResources.nodeId, nodeId), eq(dockerAccessResources.resourceType, 'container')));
    for (const row of rows) this.rememberContainer(row.nodeId, row.resourceKey, row.runtimeId, row.id);
    return new Map(rows.map((row) => [row.resourceKey, row.id]));
  }

  async ensureContainer(
    nodeId: string,
    name: string,
    runtimeId: string,
    preserveExisting = false,
    executor?: DrizzleExecutor
  ): Promise<string> {
    const ensure = async (tx: DrizzleExecutor) => {
      await this.lockContainerIdentity(tx, nodeId, name);
      const [existing] = await tx
        .select()
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'container'),
            eq(dockerAccessResources.resourceKey, name)
          )
        )
        .limit(1);

      if (!existing) {
        const [created] = await tx
          .insert(dockerAccessResources)
          .values({ nodeId, resourceType: 'container', resourceKey: name, runtimeId })
          .returning({ id: dockerAccessResources.id });
        return created.id;
      }

      if (!runtimeId && existing.runtimeId) {
        throw new AppError(409, 'CONTAINER_NAME_CONFLICT', 'A runtime already owns this container identity');
      }

      if (!existing.runtimeId || existing.runtimeId === runtimeId || preserveExisting) {
        if (existing.runtimeId !== runtimeId) {
          await tx
            .update(dockerAccessResources)
            .set({ runtimeId, updatedAt: new Date() })
            .where(eq(dockerAccessResources.id, existing.id));
        }
        return existing.id;
      }

      await this.rewritePersistedScopes(tx, dockerChildScopeResourceId(nodeId, existing.id), null);
      await tx.delete(dockerAccessResources).where(eq(dockerAccessResources.id, existing.id));
      const [created] = await tx
        .insert(dockerAccessResources)
        .values({ nodeId, resourceType: 'container', resourceKey: name, runtimeId })
        .returning({ id: dockerAccessResources.id });
      return created.id;
    };
    const resourceId = executor ? await ensure(executor) : await this.db.transaction(ensure);
    this.rememberContainer(nodeId, name, runtimeId, resourceId);
    return resourceId;
  }

  async resolveContainer(nodeId: string, options: { name?: string; runtimeId?: string }): Promise<string | null> {
    const conditions = [eq(dockerAccessResources.nodeId, nodeId), eq(dockerAccessResources.resourceType, 'container')];
    if (options.runtimeId) conditions.push(eq(dockerAccessResources.runtimeId, options.runtimeId));
    else if (options.name) conditions.push(eq(dockerAccessResources.resourceKey, options.name));
    else return null;
    const [row] = await this.db
      .select({ id: dockerAccessResources.id })
      .from(dockerAccessResources)
      .where(and(...conditions))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Resolve existing container access resources without reconciling runtime
   * identities. Read-only callers use this before any daemon inspection so an
   * inaccessible container cannot cause a scope rewrite as a side effect.
   */
  async listContainerResourceIdentities(nodeId: string) {
    const rows = await this.db
      .select({
        id: dockerAccessResources.id,
        name: dockerAccessResources.resourceKey,
        runtimeId: dockerAccessResources.runtimeId,
      })
      .from(dockerAccessResources)
      .where(and(eq(dockerAccessResources.nodeId, nodeId), eq(dockerAccessResources.resourceType, 'container')));
    for (const row of rows) this.rememberContainer(nodeId, row.name, row.runtimeId, row.id);
    return rows;
  }

  async resolveResourceByName(nodeId: string, name: string): Promise<string | null> {
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.name, name)))
      .limit(1);
    return deployment?.id ?? this.resolveContainer(nodeId, { name });
  }

  async preserveContainerRuntimeId(nodeId: string, name: string, runtimeId: string): Promise<string> {
    return this.ensureContainer(nodeId, name, runtimeId, true);
  }

  async assertContainerRenameAllowed(
    nodeId: string,
    oldName: string,
    newName: string,
    executor: DrizzleExecutor = this.db
  ): Promise<void> {
    const bindings = await executor
      .select({ id: dockerSourceBindings.id, containerName: dockerSourceBindings.containerName })
      .from(dockerSourceBindings)
      .where(
        and(
          eq(dockerSourceBindings.targetKind, 'container'),
          eq(dockerSourceBindings.nodeId, nodeId),
          inArray(dockerSourceBindings.containerName, [oldName, newName])
        )
      );
    if (bindings.some((binding) => binding.containerName === newName && newName !== oldName))
      throw new AppError(409, 'NAME_IN_USE', 'This name is reserved by another build source');
    for (const binding of bindings) {
      const [active] = await executor
        .select({ id: dockerBuilds.id })
        .from(dockerBuilds)
        .where(
          and(
            eq(dockerBuilds.sourceBindingId, binding.id),
            inArray(dockerBuilds.status, [
              'queued',
              'claimed',
              'checking_out',
              'building',
              'scanning',
              'pushing',
              'deploying',
            ])
          )
        )
        .limit(1);
      if (active)
        throw new AppError(
          409,
          'BUILD_IN_PROGRESS',
          'Wait for the current build to finish before renaming this container'
        );
    }
  }

  async renameContainer(nodeId: string, oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    await this.db.transaction(async (tx) => {
      for (const name of [oldName, newName].sort()) await this.lockContainerIdentity(tx, nodeId, name);
      const bindings = await tx
        .select({ id: dockerSourceBindings.id })
        .from(dockerSourceBindings)
        .where(
          and(
            eq(dockerSourceBindings.targetKind, 'container'),
            eq(dockerSourceBindings.nodeId, nodeId),
            eq(dockerSourceBindings.containerName, oldName)
          )
        );
      for (const binding of bindings)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${binding.id}`}))`);
      await this.assertContainerRenameAllowed(nodeId, oldName, newName, tx);
      const [target] = await tx
        .select({ id: dockerAccessResources.id })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'container'),
            eq(dockerAccessResources.resourceKey, newName)
          )
        )
        .limit(1);
      if (target) {
        await this.rewritePersistedScopes(tx, dockerChildScopeResourceId(nodeId, target.id), null);
        await tx.delete(dockerAccessResources).where(eq(dockerAccessResources.id, target.id));
      }
      await tx
        .update(dockerAccessResources)
        .set({ resourceKey: newName, updatedAt: new Date() })
        .where(
          and(
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'container'),
            eq(dockerAccessResources.resourceKey, oldName)
          )
        );
      await tx
        .update(dockerSourceBindings)
        .set({
          containerName: newName,
          initialConfig: sql`CASE WHEN ${dockerSourceBindings.initialConfig} IS NULL THEN NULL ELSE jsonb_set(${dockerSourceBindings.initialConfig}, '{name}', to_jsonb(${newName}::text), true) END`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dockerSourceBindings.targetKind, 'container'),
            eq(dockerSourceBindings.nodeId, nodeId),
            eq(dockerSourceBindings.containerName, oldName)
          )
        );
    });
    const resourceId = this.containerIdsByName.get(`${nodeId}:${oldName}`);
    const replacedResourceId = this.containerIdsByName.get(`${nodeId}:${newName}`);
    if (replacedResourceId && replacedResourceId !== resourceId) {
      this.forgetContainer(nodeId, newName, replacedResourceId);
    }
    this.containerIdsByName.delete(`${nodeId}:${oldName}`);
    if (resourceId) this.containerIdsByName.set(`${nodeId}:${newName}`, resourceId);
  }

  async removeContainer(nodeId: string, name: string): Promise<string | null> {
    const removed = await this.db.transaction(async (tx) => {
      await this.lockContainerIdentity(tx, nodeId, name);
      const [row] = await tx
        .select({ id: dockerAccessResources.id })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'container'),
            eq(dockerAccessResources.resourceKey, name)
          )
        )
        .limit(1);
      if (!row) return null;
      await this.rewritePersistedScopes(tx, dockerChildScopeResourceId(nodeId, row.id), null);
      await tx.delete(dockerAccessResources).where(eq(dockerAccessResources.id, row.id));
      return row.id;
    });
    if (removed) this.forgetContainer(nodeId, name, removed);
    return removed;
  }

  /** Delete a logical reservation only; an identity adopted by a runtime is retained. */
  async removePendingContainer(nodeId: string, name: string, tx: DrizzleExecutor): Promise<string | null> {
    await this.lockContainerIdentity(tx, nodeId, name);
    const [row] = await tx
      .select()
      .from(dockerAccessResources)
      .where(
        and(
          eq(dockerAccessResources.nodeId, nodeId),
          eq(dockerAccessResources.resourceType, 'container'),
          eq(dockerAccessResources.resourceKey, name)
        )
      )
      .limit(1);
    if (!row || row.runtimeId) return null;
    await this.rewritePersistedScopes(tx, dockerChildScopeResourceId(nodeId, row.id), null);
    await tx.delete(dockerAccessResources).where(eq(dockerAccessResources.id, row.id));
    this.forgetContainer(nodeId, name, row.id);
    return row.id;
  }

  async moveContainer(nodeId: string, targetNodeId: string, name: string, runtimeId?: string): Promise<void> {
    if (nodeId === targetNodeId) return;
    await this.db.transaction((tx) => this.moveContainerWithExecutor(tx, nodeId, targetNodeId, name, runtimeId));
  }

  async moveContainerWithExecutor(
    tx: DrizzleExecutor,
    nodeId: string,
    targetNodeId: string,
    name: string,
    runtimeId?: string
  ): Promise<void> {
    if (nodeId === targetNodeId) return;
    for (const lockNodeId of [nodeId, targetNodeId].sort()) {
      await this.lockContainerIdentity(tx, lockNodeId, name);
    }
    const [row] = await tx
      .select()
      .from(dockerAccessResources)
      .where(
        and(
          eq(dockerAccessResources.nodeId, nodeId),
          eq(dockerAccessResources.resourceType, 'container'),
          eq(dockerAccessResources.resourceKey, name)
        )
      )
      .limit(1);
    if (!row) return;

    const [target] = await tx
      .select({ id: dockerAccessResources.id })
      .from(dockerAccessResources)
      .where(
        and(
          eq(dockerAccessResources.nodeId, targetNodeId),
          eq(dockerAccessResources.resourceType, 'container'),
          eq(dockerAccessResources.resourceKey, name)
        )
      )
      .limit(1);
    if (target) {
      await this.rewritePersistedScopes(tx, dockerChildScopeResourceId(targetNodeId, target.id), null);
      await tx.delete(dockerAccessResources).where(eq(dockerAccessResources.id, target.id));
    }

    await tx
      .update(dockerAccessResources)
      .set({ nodeId: targetNodeId, runtimeId: runtimeId ?? row.runtimeId, updatedAt: new Date() })
      .where(eq(dockerAccessResources.id, row.id));
    await this.rewritePersistedScopes(
      tx,
      dockerChildScopeResourceId(nodeId, row.id),
      dockerChildScopeResourceId(targetNodeId, row.id)
    );
    this.forgetContainer(nodeId, name, row.id);
    this.rememberContainer(targetNodeId, name, runtimeId ?? row.runtimeId, row.id);
  }

  async removeDeployment(nodeId: string, deploymentId: string): Promise<void> {
    await this.db.transaction((tx) =>
      this.rewritePersistedScopes(tx, dockerChildScopeResourceId(nodeId, deploymentId), null)
    );
  }

  async moveDeployment(nodeId: string, targetNodeId: string, deploymentId: string): Promise<void> {
    if (nodeId === targetNodeId) return;
    await this.db.transaction((tx) => this.moveDeploymentWithExecutor(tx, nodeId, targetNodeId, deploymentId));
  }

  async moveDeploymentWithExecutor(
    tx: DrizzleExecutor,
    nodeId: string,
    targetNodeId: string,
    deploymentId: string
  ): Promise<void> {
    if (nodeId === targetNodeId) return;
    await this.rewritePersistedScopes(
      tx,
      dockerChildScopeResourceId(nodeId, deploymentId),
      dockerChildScopeResourceId(targetNodeId, deploymentId)
    );
  }

  private async lockContainerIdentity(tx: DrizzleExecutor, nodeId: string, name: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-access:${nodeId}:${name}`}))`);
  }

  private rememberContainer(nodeId: string, name: string, runtimeId: string | null, resourceId: string): void {
    const previousResourceId = this.containerIdsByName.get(`${nodeId}:${name}`);
    if (previousResourceId && previousResourceId !== resourceId) {
      this.forgetContainer(nodeId, name, previousResourceId);
    }
    for (const [key, value] of this.containerIdsByRuntime) {
      if (key.startsWith(`${nodeId}:`) && value === resourceId) this.containerIdsByRuntime.delete(key);
    }
    this.containerIdsByName.set(`${nodeId}:${name}`, resourceId);
    if (runtimeId) this.containerIdsByRuntime.set(`${nodeId}:${runtimeId}`, resourceId);
  }

  private forgetContainer(nodeId: string, name: string, resourceId: string): void {
    this.containerIdsByName.delete(`${nodeId}:${name}`);
    for (const [key, value] of this.containerIdsByRuntime) {
      if (key.startsWith(`${nodeId}:`) && value === resourceId) this.containerIdsByRuntime.delete(key);
    }
  }

  private async rewritePersistedScopes(
    tx: DrizzleExecutor,
    fromResourceId: string,
    toResourceId: string | null
  ): Promise<void> {
    await rewritePersistedDockerResourceScopes(tx, fromResourceId, toResourceId);
  }
}
