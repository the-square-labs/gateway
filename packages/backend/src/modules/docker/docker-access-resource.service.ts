import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  apiTokens,
  dockerAccessResources,
  dockerDeployments,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  permissionGroups,
  users,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { extractBaseScope } from '@/lib/scopes.js';

const DOCKER_CONTAINER_SCOPE_PREFIX = 'docker:containers:';

export function dockerChildScopeResourceId(nodeId: string, resourceId: string): string {
  return `${nodeId}/${resourceId}`;
}

export function parseDockerChildScopeResourceId(value: string): { nodeId: string; resourceId: string } | null {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { nodeId: value.slice(0, separator), resourceId: value.slice(separator + 1) };
}

export function isDockerContainerScope(scope: string): boolean {
  return extractBaseScope(scope).startsWith(DOCKER_CONTAINER_SCOPE_PREFIX);
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
    if (!baseScopes.some((requiredBase) => hasScope([scope], `${requiredBase}:${resourceId}`))) continue;
    const child = parseDockerChildScopeResourceId(resourceId);
    ids.add(child?.nodeId ?? resourceId);
  }
  return [...ids];
}

export function rewriteDockerResourceScopes(
  scopes: readonly string[],
  fromResourceId: string,
  toResourceId: string | null
): string[] {
  let changed = false;
  const rewritten = scopes.flatMap((scope) => {
    if (!isDockerContainerScope(scope)) return [scope];
    const base = extractBaseScope(scope);
    if (scope !== `${base}:${fromResourceId}`) return [scope];
    changed = true;
    return toResourceId ? [`${base}:${toResourceId}`] : [];
  });
  return changed ? [...new Set(rewritten)].sort() : [...scopes];
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

  async ensureContainer(nodeId: string, name: string, runtimeId: string, preserveExisting = false): Promise<string> {
    const resourceId = await this.db.transaction(async (tx) => {
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
    });
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

  async renameContainer(nodeId: string, oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    await this.db.transaction(async (tx) => {
      for (const name of [oldName, newName].sort()) await this.lockContainerIdentity(tx, nodeId, name);
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
    const groupRows = await tx
      .select({ id: permissionGroups.id, scopes: permissionGroups.scopes })
      .from(permissionGroups);
    for (const row of groupRows) {
      const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
      if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
        await tx.update(permissionGroups).set({ scopes, updatedAt: new Date() }).where(eq(permissionGroups.id, row.id));
      }
    }

    const userRows = await tx.select({ id: users.id, scopes: users.additionalScopes }).from(users);
    for (const row of userRows) {
      const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
      if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
        await tx.update(users).set({ additionalScopes: scopes, updatedAt: new Date() }).where(eq(users.id, row.id));
      }
    }

    const tokenRows = await tx.select({ id: apiTokens.id, scopes: apiTokens.scopes }).from(apiTokens);
    for (const row of tokenRows) {
      const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
      if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
        await tx.update(apiTokens).set({ scopes }).where(eq(apiTokens.id, row.id));
      }
    }

    const authorizationRows = await tx
      .select({
        id: oauthAuthorizationCodes.id,
        scopes: oauthAuthorizationCodes.scopes,
        requestedScopes: oauthAuthorizationCodes.requestedScopes,
      })
      .from(oauthAuthorizationCodes);
    for (const row of authorizationRows) {
      const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
      const requestedScopes = rewriteDockerResourceScopes(row.requestedScopes, fromResourceId, toResourceId);
      if (
        scopes.join('\u0000') !== row.scopes.join('\u0000') ||
        requestedScopes.join('\u0000') !== row.requestedScopes.join('\u0000')
      ) {
        await tx
          .update(oauthAuthorizationCodes)
          .set({ scopes, requestedScopes })
          .where(eq(oauthAuthorizationCodes.id, row.id));
      }
    }

    const refreshRows = await tx
      .select({ id: oauthRefreshTokens.id, scopes: oauthRefreshTokens.scopes })
      .from(oauthRefreshTokens);
    for (const row of refreshRows) {
      const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
      if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
        await tx.update(oauthRefreshTokens).set({ scopes }).where(eq(oauthRefreshTokens.id, row.id));
      }
    }

    const accessRows = await tx
      .select({ id: oauthAccessTokens.id, scopes: oauthAccessTokens.scopes })
      .from(oauthAccessTokens);
    for (const row of accessRows) {
      const scopes = rewriteDockerResourceScopes(row.scopes, fromResourceId, toResourceId);
      if (scopes.join('\u0000') !== row.scopes.join('\u0000')) {
        await tx.update(oauthAccessTokens).set({ scopes }).where(eq(oauthAccessTokens.id, row.id));
      }
    }
  }
}
