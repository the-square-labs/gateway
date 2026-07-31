import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';

export interface DockerMigrationPermissionPlan {
  sourceNodeId: string;
  sourceResourceId: string;
  targetNodeId: string;
  keepSource: boolean;
  hasVolumes: boolean;
  createsNetworks: boolean;
  hasProxyHosts: boolean;
}

export function requiredDockerMigrationScopes(plan: DockerMigrationPermissionPlan): string[] {
  const sourceResource = `${plan.sourceNodeId}/${plan.sourceResourceId}`;
  const required = new Set([
    `docker:containers:migrate:${sourceResource}`,
    `docker:containers:migrate:${plan.targetNodeId}`,
    `docker:containers:view:${sourceResource}`,
    `docker:containers:manage:${sourceResource}`,
    `docker:containers:environment:${sourceResource}`,
    `docker:containers:secrets:${sourceResource}`,
    `docker:containers:create:${plan.targetNodeId}`,
    `docker:containers:manage:${plan.targetNodeId}`,
    `docker:containers:environment:${plan.targetNodeId}`,
    `docker:containers:secrets:${plan.targetNodeId}`,
  ]);

  if (!plan.keepSource) required.add(`docker:containers:delete:${sourceResource}`);
  if (plan.hasVolumes) {
    required.add(`docker:volumes:view:${plan.sourceNodeId}`);
    required.add(`docker:volumes:create:${plan.targetNodeId}`);
    if (!plan.keepSource) required.add(`docker:volumes:delete:${plan.sourceNodeId}`);
  }
  if (plan.createsNetworks) {
    required.add(`docker:networks:view:${plan.sourceNodeId}`);
    required.add(`docker:networks:create:${plan.targetNodeId}`);
  }
  if (plan.hasProxyHosts) required.add('proxy:edit');
  return [...required];
}

export function missingDockerMigrationScopes(scopes: string[], plan: DockerMigrationPermissionPlan): string[] {
  return requiredDockerMigrationScopes(plan).filter((scope) => !hasScope(scopes, scope));
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
  if (!hasScope(scopes, 'docker:tasks') || !canViewResource) {
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
  if (!hasScope(scopes, 'docker:tasks:manage') || !canMigrateResource) {
    throw new AppError(403, 'FORBIDDEN', 'Managing a migration requires task management and migration permissions');
  }
}

export function assertDockerMigrationCleanupAccess(
  scopes: string[],
  sourceNodeId: string,
  targetNodeId: string,
  resourceId: string,
  hasVolumes: boolean,
  hasProxyHosts: boolean
): void {
  const canDeleteResource =
    hasDockerResourceScope(scopes, 'docker:containers:delete', sourceNodeId, resourceId) ||
    hasDockerResourceScope(scopes, 'docker:containers:delete', targetNodeId, resourceId);
  const required: string[] = [];
  if (hasVolumes) required.push(`docker:volumes:delete:${sourceNodeId}`);
  if (hasProxyHosts) required.push('proxy:edit');
  if (!canDeleteResource || required.some((scope) => !hasScope(scopes, scope))) {
    throw new AppError(403, 'MIGRATION_PERMISSION_DENIED', 'Missing permissions required for migration cleanup');
  }
}
