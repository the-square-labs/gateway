import { and, eq, type SQL } from 'drizzle-orm';
import { dockerSourceBindings } from '@/db/schema/index.js';
import type { DockerSourceTarget } from './docker-build.schemas.js';

export type SourceBindingRow = typeof dockerSourceBindings.$inferSelect;
export type SupportedSourceProvider = 'gitlab' | 'github' | 'git';

export function dockerSourceTargetWhere(target: DockerSourceTarget): SQL {
  return target.kind === 'container'
    ? and(
        eq(dockerSourceBindings.targetKind, 'container'),
        eq(dockerSourceBindings.nodeId, target.nodeId),
        eq(dockerSourceBindings.containerName, target.containerName)
      )!
    : and(
        eq(dockerSourceBindings.targetKind, 'deployment'),
        eq(dockerSourceBindings.deploymentId, target.deploymentId)
      )!;
}

export function dockerSourceTargetColumns(target: DockerSourceTarget) {
  return target.kind === 'container'
    ? {
        targetKind: 'container' as const,
        nodeId: target.nodeId,
        containerName: target.containerName,
        deploymentId: null,
      }
    : { targetKind: 'deployment' as const, nodeId: null, containerName: null, deploymentId: target.deploymentId };
}

export function toPublicDockerSource(row: SourceBindingRow, provider: SupportedSourceProvider) {
  return {
    id: row.id,
    target:
      row.targetKind === 'container'
        ? { kind: 'container' as const, nodeId: row.nodeId!, containerName: row.containerName! }
        : { kind: 'deployment' as const, deploymentId: row.deploymentId! },
    connectorId: row.connectorId,
    projectId: row.projectId,
    provider,
    repositoryRemoteId: row.repositoryRemoteId,
    repositoryFullPath: row.repositoryFullPath,
    repositoryCloneUrl: row.repositoryCloneUrl,
    branch: row.branch,
    dockerfilePath: row.dockerfilePath,
    contextPath: row.contextPath,
    autoBuild: row.autoBuild,
    autoDeploy: row.autoDeploy,
    buildArgs: row.buildArgs,
    buildSecretNames: row.buildSecretNames,
    policy: row.policy,
    desiredCommitSha: row.desiredCommitSha,
    deployedCommitSha: row.deployedCommitSha,
    lastResolvedAt: row.lastResolvedAt,
    lastPollAt: row.lastPollAt,
    lastPollError: row.lastPollError,
    webhookConfiguredAt: row.webhookConfiguredAt,
    lastWebhookAt: row.lastWebhookAt,
    lastWebhookError: row.lastWebhookError,
    webhookPath: `/api/webhooks/docker-source/${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
