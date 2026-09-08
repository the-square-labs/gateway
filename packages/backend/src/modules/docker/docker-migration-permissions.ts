import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';

export interface DockerMigrationPermissionPlan {
  sourceNodeId: string;
  sourceResourceId: string;
  targetNodeId: string;
  targetFolderId: string | null;
  keepSource: boolean;
  hasVolumes: boolean;
  createsNetworks: boolean;
  hasProxyHosts: boolean;
  volumes?: Array<{ resourceId: string; folderId: string | null }>;
  networks?: Array<{
    resourceId: string;
    resourceKey: string;
    folderId: string | null;
    targetResourceId: string | null;
  }>;
  proxyHostIds?: string[];
}

export function requiredDockerMigrationScopes(plan: DockerMigrationPermissionPlan): string[] {
  const sourceResource = `${plan.sourceNodeId}/${plan.sourceResourceId}`;
  const required = new Set([
    `docker:containers:migrate:${sourceResource}`,
    `docker:containers:view:${sourceResource}`,
    `docker:containers:manage:${sourceResource}`,
    `docker:containers:environment:${sourceResource}`,
    `docker:containers:secrets:${sourceResource}`,
    `docker:containers:migrate:${plan.targetNodeId}`,
    `docker:containers:create:${plan.targetNodeId}`,
    `docker:containers:manage:${plan.targetNodeId}`,
    `docker:containers:environment:${plan.targetNodeId}`,
    `docker:containers:secrets:${plan.targetNodeId}`,
  ]);

  if (!plan.keepSource) required.add(`docker:containers:delete:${sourceResource}`);
  if (plan.hasVolumes && !plan.volumes) {
    required.add(`docker:volumes:view:${plan.sourceNodeId}`);
    required.add(`docker:volumes:create:${plan.targetNodeId}`);
    if (!plan.keepSource) required.add(`docker:volumes:delete:${plan.sourceNodeId}`);
  }
  if (plan.createsNetworks && !plan.networks) {
    required.add(`docker:networks:view:${plan.sourceNodeId}`);
    required.add(`docker:networks:create:${plan.targetNodeId}`);
  }
  for (const volume of plan.volumes ?? []) {
    required.add(`docker:volumes:view:${plan.sourceNodeId}/${volume.resourceId}`);
    required.add(`docker:volumes:create:${volume.folderId ? `folder/${volume.folderId}` : plan.targetNodeId}`);
    if (!plan.keepSource) required.add(`docker:volumes:delete:${plan.sourceNodeId}/${volume.resourceId}`);
  }
  for (const network of plan.networks ?? []) {
    required.add(`docker:networks:view:${plan.sourceNodeId}/${network.resourceId}`);
    required.add(
      network.targetResourceId
        ? `docker:networks:edit:${plan.targetNodeId}/${network.targetResourceId}`
        : `docker:networks:create:${network.folderId ? `folder/${network.folderId}` : plan.targetNodeId}`
    );
  }
  if (plan.proxyHostIds) for (const id of plan.proxyHostIds) required.add(`proxy:edit:${id}`);
  else if (plan.hasProxyHosts) required.add('proxy:edit');
  return [...required];
}

export function missingDockerMigrationScopes(scopes: string[], plan: DockerMigrationPermissionPlan): string[] {
  const sourceResource = `${plan.sourceNodeId}/${plan.sourceResourceId}`;
  const sourceBases = [
    'docker:containers:migrate',
    'docker:containers:view',
    'docker:containers:manage',
    'docker:containers:environment',
    'docker:containers:secrets',
  ];
  const missing = sourceBases
    .filter((base) => !hasDockerResourceScope(scopes, base, plan.sourceNodeId, plan.sourceResourceId))
    .map((base) => `${base}:${sourceResource}`);
  const targetBases = [
    'docker:containers:migrate',
    'docker:containers:create',
    'docker:containers:manage',
    'docker:containers:environment',
    'docker:containers:secrets',
  ];
  missing.push(
    ...targetBases
      .filter((base) => !hasScopeForCreation(scopes, base, plan.targetFolderId, plan.targetNodeId))
      .map((base) => `${base}:${plan.targetNodeId}`)
  );
  if (
    !plan.keepSource &&
    !hasDockerResourceScope(scopes, 'docker:containers:delete', plan.sourceNodeId, plan.sourceResourceId)
  ) {
    missing.push(`docker:containers:delete:${sourceResource}`);
  }
  if (plan.hasVolumes && !plan.volumes) {
    if (!hasScope(scopes, `docker:volumes:view:${plan.sourceNodeId}`))
      missing.push(`docker:volumes:view:${plan.sourceNodeId}`);
    if (!hasScope(scopes, `docker:volumes:create:${plan.targetNodeId}`))
      missing.push(`docker:volumes:create:${plan.targetNodeId}`);
    if (!plan.keepSource && !hasScope(scopes, `docker:volumes:delete:${plan.sourceNodeId}`))
      missing.push(`docker:volumes:delete:${plan.sourceNodeId}`);
  }
  if (plan.createsNetworks && !plan.networks) {
    if (!hasScope(scopes, `docker:networks:view:${plan.sourceNodeId}`))
      missing.push(`docker:networks:view:${plan.sourceNodeId}`);
    if (!hasScope(scopes, `docker:networks:create:${plan.targetNodeId}`))
      missing.push(`docker:networks:create:${plan.targetNodeId}`);
  }
  for (const volume of plan.volumes ?? []) {
    for (const base of ['docker:volumes:view', ...(!plan.keepSource ? ['docker:volumes:delete'] : [])]) {
      if (!hasDockerResourceScope(scopes, base, plan.sourceNodeId, volume.resourceId))
        missing.push(`${base}:${plan.sourceNodeId}/${volume.resourceId}`);
    }
    if (!hasScopeForCreation(scopes, 'docker:volumes:create', volume.folderId, plan.targetNodeId))
      missing.push(`docker:volumes:create:${volume.folderId ? `folder/${volume.folderId}` : plan.targetNodeId}`);
  }
  for (const network of plan.networks ?? []) {
    if (!hasDockerResourceScope(scopes, 'docker:networks:view', plan.sourceNodeId, network.resourceId))
      missing.push(`docker:networks:view:${plan.sourceNodeId}/${network.resourceId}`);
    if (network.targetResourceId) {
      if (!hasDockerResourceScope(scopes, 'docker:networks:edit', plan.targetNodeId, network.targetResourceId))
        missing.push(`docker:networks:edit:${plan.targetNodeId}/${network.targetResourceId}`);
    } else if (!hasScopeForCreation(scopes, 'docker:networks:create', network.folderId, plan.targetNodeId)) {
      missing.push(`docker:networks:create:${network.folderId ? `folder/${network.folderId}` : plan.targetNodeId}`);
    }
  }
  if (plan.proxyHostIds) {
    for (const id of plan.proxyHostIds)
      if (!hasScopeForResource(scopes, 'proxy:edit', id)) missing.push(`proxy:edit:${id}`);
  } else if (plan.hasProxyHosts && !hasScope(scopes, 'proxy:edit')) missing.push('proxy:edit');
  return missing;
}

export function assertDockerMigrationPermissions(scopes: string[], plan: DockerMigrationPermissionPlan): void {
  const missingScopes = missingDockerMigrationScopes(scopes, plan);
  if (missingScopes.length > 0) {
    throw new AppError(403, 'MIGRATION_PERMISSION_DENIED', 'Missing permissions required for this migration', {
      missingScopes,
    });
  }
}

export function assertDockerMigrationReadAccess(
  scopes: string[],
  sourceNodeId: string,
  targetNodeId: string,
  resourceId: string
): void {
  const canViewResource =
    hasDockerResourceScope(scopes, 'docker:containers:view', sourceNodeId, resourceId) ||
    hasDockerResourceScope(scopes, 'docker:containers:view', targetNodeId, resourceId);
  const canViewTasks =
    hasScopeForResource(scopes, 'docker:tasks', sourceNodeId) ||
    hasScopeForResource(scopes, 'docker:tasks', targetNodeId);
  if (!canViewTasks || !canViewResource) {
    throw new AppError(403, 'FORBIDDEN', 'Docker migration history requires task and node visibility');
  }
}

export function assertDockerMigrationManageAccess(
  scopes: string[],
  sourceNodeId: string,
  targetNodeId: string,
  resourceId: string
): void {
  assertDockerMigrationReadAccess(scopes, sourceNodeId, targetNodeId, resourceId);
  const canMigrateResource =
    hasDockerResourceScope(scopes, 'docker:containers:migrate', sourceNodeId, resourceId) ||
    hasDockerResourceScope(scopes, 'docker:containers:migrate', targetNodeId, resourceId);
  const canManageTasks =
    hasScopeForResource(scopes, 'docker:tasks:manage', sourceNodeId) ||
    hasScopeForResource(scopes, 'docker:tasks:manage', targetNodeId);
  if (!canManageTasks || !canMigrateResource) {
    throw new AppError(403, 'FORBIDDEN', 'Managing a migration requires task management and migration permissions');
  }
}

export function assertDockerMigrationCleanupAccess(
  scopes: string[],
  sourceNodeId: string,
  targetNodeId: string,
  resourceId: string,
  hasVolumes: boolean,
  hasProxyHosts: boolean,
  dependencies?: Pick<DockerMigrationPermissionPlan, 'volumes' | 'proxyHostIds'>
): void {
  const canDeleteResource =
    hasDockerResourceScope(scopes, 'docker:containers:delete', sourceNodeId, resourceId) ||
    hasDockerResourceScope(scopes, 'docker:containers:delete', targetNodeId, resourceId);
  const required: string[] = [];
  if (dependencies?.volumes) {
    for (const volume of dependencies.volumes) {
      if (!hasDockerResourceScope(scopes, 'docker:volumes:delete', sourceNodeId, volume.resourceId))
        required.push(`docker:volumes:delete:${sourceNodeId}/${volume.resourceId}`);
    }
  } else if (hasVolumes) required.push(`docker:volumes:delete:${sourceNodeId}`);
  if (dependencies?.proxyHostIds) required.push(...dependencies.proxyHostIds.map((id) => `proxy:edit:${id}`));
  else if (hasProxyHosts) required.push('proxy:edit');
  if (!canDeleteResource || required.some((scope) => !hasScope(scopes, scope))) {
    throw new AppError(403, 'MIGRATION_PERMISSION_DENIED', 'Missing permissions required for migration cleanup');
  }
}
