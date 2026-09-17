import type { DrizzleClient } from '@/db/client.js';
import type { DockerBuildStatus } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
export interface DockerBuildListInput {
  sourceBindingId?: string;
  builderNodeId?: string;
  status?: DockerBuildStatus;
  provider?: 'gitlab' | 'github' | 'git';
  branch?: string;
  search?: string;
  beforeCreatedAt?: Date;
  beforeId?: string;
  limit?: number;
}
export class DockerBuildQuery {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient) {}
  async listInternalRegistryRepositories(): Promise<string[]> {
    return [];
  }
  async get(_id: string): Promise<{
    provider: import('@/db/schema/index.js').IntegrationProvider;
    builderName: string | null;
    sourceAutoDeploy: boolean;
    artifact: {
      id: string;
      buildId: string | null;
      sourceBindingId: string | null;
      ownerKind: import('@/db/schema/index.js').DockerArtifactOwnerKind;
      ownerKey: string | null;
      sourceImageReference: string | null;
      registryRepository: string;
      digest: string;
      platform: string;
      sizeBytes: number;
      status: import('@/db/schema/index.js').DockerArtifactStatus;
      sbomDigest: string | null;
      provenanceDigest: string | null;
      scanSummary: import('@/db/schema/index.js').DockerBuildScanSummary | null;
      policyDecision: import('@/db/schema/index.js').DockerArtifactPolicyDecision;
      policyReason: string | null;
      verifiedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
    target:
      | {
          kind: 'container';
          nodeId: string;
          containerName: string;
          name: string;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          serviceName?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'deployment';
          nodeId: string;
          deploymentId: string;
          name: string;
          containerName?: undefined;
          composeProjectId?: undefined;
          serviceName?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'compose_project';
          nodeId: string;
          composeProjectId: string;
          name: string;
          serviceName: string | null;
          containerName?: undefined;
          deploymentId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'pages_project';
          nodeId: string | undefined;
          pageProjectId: string;
          name: string;
          containerName?: undefined;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          serviceName?: undefined;
        };
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: import('@/db/schema/index.js').DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async list(_input?: DockerBuildListInput): Promise<
    {
      provider: import('@/db/schema/index.js').IntegrationProvider;
      builderName: string | null;
      sourceAutoDeploy: boolean;
      artifact: {
        id: string;
        buildId: string | null;
        sourceBindingId: string | null;
        ownerKind: import('@/db/schema/index.js').DockerArtifactOwnerKind;
        ownerKey: string | null;
        sourceImageReference: string | null;
        registryRepository: string;
        digest: string;
        platform: string;
        sizeBytes: number;
        status: import('@/db/schema/index.js').DockerArtifactStatus;
        sbomDigest: string | null;
        provenanceDigest: string | null;
        scanSummary: import('@/db/schema/index.js').DockerBuildScanSummary | null;
        policyDecision: import('@/db/schema/index.js').DockerArtifactPolicyDecision;
        policyReason: string | null;
        verifiedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      } | null;
      target:
        | {
            kind: 'container';
            nodeId: string;
            containerName: string;
            name: string;
            deploymentId?: undefined;
            composeProjectId?: undefined;
            serviceName?: undefined;
            pageProjectId?: undefined;
          }
        | {
            kind: 'deployment';
            nodeId: string;
            deploymentId: string;
            name: string;
            containerName?: undefined;
            composeProjectId?: undefined;
            serviceName?: undefined;
            pageProjectId?: undefined;
          }
        | {
            kind: 'compose_project';
            nodeId: string;
            composeProjectId: string;
            name: string;
            serviceName: string | null;
            containerName?: undefined;
            deploymentId?: undefined;
            pageProjectId?: undefined;
          }
        | {
            kind: 'pages_project';
            nodeId: string | undefined;
            pageProjectId: string;
            name: string;
            containerName?: undefined;
            deploymentId?: undefined;
            composeProjectId?: undefined;
            serviceName?: undefined;
          };
      id: string;
      sourceBindingId: string;
      batchId: string | null;
      dedupeKey: string;
      trigger: import('@/db/schema/index.js').DockerBuildTrigger;
      triggerDeliveryId: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      ref: string;
      commitSha: string;
      serviceName: string | null;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceConfigGeneration: number;
      status: DockerBuildStatus;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      progress: Record<string, unknown>;
      createdById: string | null;
      createdAt: Date;
      queuedAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    }[]
  > {
    return [];
  }
}
