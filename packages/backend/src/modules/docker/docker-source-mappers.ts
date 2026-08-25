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
    : target.kind === 'deployment'
      ? and(
          eq(dockerSourceBindings.targetKind, 'deployment'),
          eq(dockerSourceBindings.deploymentId, target.deploymentId)
        )!
      : target.kind === 'compose_project'
        ? and(
            eq(dockerSourceBindings.targetKind, 'compose_project'),
            eq(dockerSourceBindings.composeProjectId, target.composeProjectId)
          )!
        : and(
            eq(dockerSourceBindings.targetKind, 'pages_project'),
            eq(dockerSourceBindings.pageProjectId, target.pageProjectId)
          )!;
}

export function dockerSourceTargetColumns(target: DockerSourceTarget) {
  return target.kind === 'container'
    ? {
        targetKind: 'container' as const,
        nodeId: target.nodeId,
        containerName: target.containerName,
        deploymentId: null,
        composeProjectId: null,
        pageProjectId: null,
      }
    : target.kind === 'deployment'
      ? {
          targetKind: 'deployment' as const,
          nodeId: null,
          containerName: null,
          deploymentId: target.deploymentId,
          composeProjectId: null,
          pageProjectId: null,
        }
      : target.kind === 'compose_project'
        ? {
            targetKind: 'compose_project' as const,
            nodeId: null,
            containerName: null,
            deploymentId: null,
            composeProjectId: target.composeProjectId,
            pageProjectId: null,
          }
        : {
            targetKind: 'pages_project' as const,
            nodeId: null,
            containerName: null,
            deploymentId: null,
            composeProjectId: null,
            pageProjectId: target.pageProjectId,
          };
}

export function toPublicDockerSource(row: SourceBindingRow, provider: SupportedSourceProvider) {
  return {
    id: row.id,
    target:
      row.targetKind === 'container'
        ? { kind: 'container' as const, nodeId: row.nodeId!, containerName: row.containerName! }
        : row.targetKind === 'deployment'
          ? { kind: 'deployment' as const, deploymentId: row.deploymentId! }
          : row.targetKind === 'compose_project'
            ? { kind: 'compose_project' as const, composeProjectId: row.composeProjectId! }
            : { kind: 'pages_project' as const, pageProjectId: row.pageProjectId! },
    connectorId: row.connectorId,
    projectId: row.projectId,
    provider,
    repositoryRemoteId: row.repositoryRemoteId,
    repositoryFullPath: row.repositoryFullPath,
    repositoryCloneUrl: row.repositoryCloneUrl,
    branch: row.branch,
    dockerfilePath: row.dockerfilePath,
    contextPath: row.contextPath,
    composeFilePath: row.composeFilePath,
    composeVariables: row.composeVariables,
    composeSecretKeys: row.composeSecretKeys,
    autoBuild: row.autoBuild,
    autoDeploy: row.autoDeploy,
    buildArgs: row.buildArgs,
    buildSecretNames: row.buildSecretNames,
    applicationRoot: row.applicationRoot,
    packageManager: row.packageManager,
    packageManagerVersion: row.packageManagerVersion,
    nodeVersion: row.nodeVersion,
    buildScript: row.buildScript,
    artifactDirectory: row.artifactDirectory,
    publishTag: row.publishTag,
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
