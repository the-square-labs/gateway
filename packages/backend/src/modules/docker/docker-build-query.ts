import { and, asc, desc, eq, ilike, inArray, lt, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerBuildStatus,
  dockerBuildArtifacts,
  dockerBuilds,
  dockerComposeProjects,
  dockerDeployments,
  dockerSourceBindings,
  integrationConnectors,
  nodes,
  pageProjects,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

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
  constructor(private readonly db: DrizzleClient) {}

  async listInternalRegistryRepositories(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ repository: dockerBuildArtifacts.registryRepository })
      .from(dockerBuildArtifacts)
      .orderBy(asc(dockerBuildArtifacts.registryRepository));
    return rows.map((row) => row.repository);
  }

  async get(id: string) {
    const [joined] = await this.db
      .select({
        build: dockerBuilds,
        source: dockerSourceBindings,
        provider: integrationConnectors.provider,
        deploymentNodeId: dockerDeployments.nodeId,
        deploymentName: dockerDeployments.name,
        composeNodeId: dockerComposeProjects.nodeId,
        composeName: dockerComposeProjects.name,
        pageNodeId: pageProjects.nodeId,
        pageName: pageProjects.name,
      })
      .from(dockerBuilds)
      .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, dockerSourceBindings.connectorId))
      .leftJoin(dockerDeployments, eq(dockerDeployments.id, dockerSourceBindings.deploymentId))
      .leftJoin(dockerComposeProjects, eq(dockerComposeProjects.id, dockerSourceBindings.composeProjectId))
      .leftJoin(pageProjects, eq(pageProjects.id, dockerSourceBindings.pageProjectId))
      .where(eq(dockerBuilds.id, id))
      .limit(1);
    if (!joined) throw new AppError(404, 'BUILD_NOT_FOUND', 'Docker build not found');
    const [artifact] = await this.db
      .select()
      .from(dockerBuildArtifacts)
      .where(eq(dockerBuildArtifacts.buildId, id))
      .limit(1);
    const [builder] = joined.build.builderNodeId
      ? await this.db
          .select({ hostname: nodes.hostname, displayName: nodes.displayName })
          .from(nodes)
          .where(eq(nodes.id, joined.build.builderNodeId))
          .limit(1)
      : [];
    return {
      ...joined.build,
      provider: joined.provider,
      builderName: builder?.displayName || builder?.hostname || null,
      sourceAutoDeploy: joined.source.autoDeploy,
      artifact: artifact ?? null,
      target:
        joined.source.targetKind === 'container'
          ? {
              kind: 'container' as const,
              nodeId: joined.source.nodeId!,
              containerName: joined.source.containerName!,
              name: joined.source.containerName!,
            }
          : joined.source.targetKind === 'deployment'
            ? {
                kind: 'deployment' as const,
                nodeId: joined.deploymentNodeId!,
                deploymentId: joined.source.deploymentId!,
                name: joined.deploymentName!,
              }
            : joined.source.targetKind === 'compose_project'
              ? {
                  kind: 'compose_project' as const,
                  nodeId: joined.composeNodeId!,
                  composeProjectId: joined.source.composeProjectId!,
                  name: joined.composeName!,
                  serviceName: joined.build.serviceName,
                }
              : {
                  kind: 'pages_project' as const,
                  nodeId: joined.pageNodeId!,
                  pageProjectId: joined.source.pageProjectId!,
                  name: joined.pageName!,
                },
    };
  }

  async list(input: DockerBuildListInput = {}) {
    const conditions = [];
    if (input.sourceBindingId) conditions.push(eq(dockerBuilds.sourceBindingId, input.sourceBindingId));
    if (input.builderNodeId) conditions.push(eq(dockerBuilds.builderNodeId, input.builderNodeId));
    if (input.status) conditions.push(eq(dockerBuilds.status, input.status));
    if (input.provider) conditions.push(eq(integrationConnectors.provider, input.provider));
    if (input.branch) conditions.push(eq(dockerSourceBindings.branch, input.branch));
    if (input.search) {
      const pattern = `%${input.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      conditions.push(
        or(
          ilike(dockerBuilds.repositoryFullPath, pattern),
          ilike(dockerBuilds.commitSha, pattern),
          ilike(dockerBuilds.ref, pattern),
          ilike(dockerSourceBindings.containerName, pattern),
          ilike(dockerDeployments.name, pattern),
          ilike(dockerComposeProjects.name, pattern),
          ilike(pageProjects.name, pattern)
        )!
      );
    }
    if (input.beforeCreatedAt && input.beforeId) {
      conditions.push(
        or(
          lt(dockerBuilds.createdAt, input.beforeCreatedAt),
          and(eq(dockerBuilds.createdAt, input.beforeCreatedAt), lt(dockerBuilds.id, input.beforeId))
        )!
      );
    }
    const rows = await this.db
      .select({
        build: dockerBuilds,
        source: dockerSourceBindings,
        provider: integrationConnectors.provider,
        deploymentNodeId: dockerDeployments.nodeId,
        deploymentName: dockerDeployments.name,
        composeNodeId: dockerComposeProjects.nodeId,
        composeName: dockerComposeProjects.name,
        pageNodeId: pageProjects.nodeId,
        pageName: pageProjects.name,
      })
      .from(dockerBuilds)
      .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, dockerSourceBindings.connectorId))
      .leftJoin(dockerDeployments, eq(dockerDeployments.id, dockerSourceBindings.deploymentId))
      .leftJoin(dockerComposeProjects, eq(dockerComposeProjects.id, dockerSourceBindings.composeProjectId))
      .leftJoin(pageProjects, eq(pageProjects.id, dockerSourceBindings.pageProjectId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(dockerBuilds.createdAt), desc(dockerBuilds.id))
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
    const builderIds = [...new Set(rows.flatMap(({ build }) => (build.builderNodeId ? [build.builderNodeId] : [])))];
    const builders = builderIds.length
      ? await this.db
          .select({ id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName })
          .from(nodes)
          .where(inArray(nodes.id, builderIds))
      : [];
    const builderNames = new Map(
      builders.map((builder) => [builder.id, builder.displayName || builder.hostname] as const)
    );
    const buildIds = rows.map(({ build }) => build.id);
    const artifacts = buildIds.length
      ? await this.db.select().from(dockerBuildArtifacts).where(inArray(dockerBuildArtifacts.buildId, buildIds))
      : [];
    const artifactsByBuildId = new Map(artifacts.map((artifact) => [artifact.buildId, artifact] as const));
    return rows.map(
      ({
        build,
        source,
        provider,
        deploymentNodeId,
        deploymentName,
        composeNodeId,
        composeName,
        pageNodeId,
        pageName,
      }) => ({
        ...build,
        provider,
        builderName: build.builderNodeId ? (builderNames.get(build.builderNodeId) ?? null) : null,
        sourceAutoDeploy: source.autoDeploy,
        artifact: artifactsByBuildId.get(build.id) ?? null,
        target:
          source.targetKind === 'container'
            ? {
                kind: 'container' as const,
                nodeId: source.nodeId!,
                containerName: source.containerName!,
                name: source.containerName!,
              }
            : source.targetKind === 'deployment'
              ? {
                  kind: 'deployment' as const,
                  nodeId: deploymentNodeId!,
                  deploymentId: source.deploymentId!,
                  name: deploymentName!,
                }
              : source.targetKind === 'compose_project'
                ? {
                    kind: 'compose_project' as const,
                    nodeId: composeNodeId!,
                    composeProjectId: source.composeProjectId!,
                    name: composeName!,
                    serviceName: build.serviceName,
                  }
                : {
                    kind: 'pages_project' as const,
                    nodeId: pageNodeId!,
                    pageProjectId: source.pageProjectId!,
                    name: pageName!,
                  },
      })
    );
  }
}
