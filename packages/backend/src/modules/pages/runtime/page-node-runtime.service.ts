import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize, sep } from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  domains,
  pageDeploymentReplicas,
  pageDeployments,
  pageProjects,
  pageRuntimeConfigs,
  pageWildcardProfiles,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import type { PageProfileRuntimeAdapter } from '../profile/page-profile.service.js';
import { renderPageHostname } from '../profile/page-profile.service.js';
import { withPageDefaultRuntimeConfigLock } from '../runtime-config/page-runtime-config.service.js';

const PROFILE_ID = 'default';

type ReplicaPurpose = 'preview' | 'route' | 'migration';
export type PageRuntimeConfigBindingKind = 'route' | 'preview';
export interface PagePreviewRuntimeConfigProgress {
  replicaId: string;
  deploymentId: string;
  nodeId: string;
  hostname: string;
  fromGeneration: number;
  toGeneration: number;
}

function failureCode(error: unknown): string {
  return error instanceof AppError ? error.code.slice(0, 128) : 'PAGES_NODE_MATERIALIZATION_FAILED';
}

export function validatePageRouteIncludePath(routeId: string, value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || !/^\/[A-Za-z0-9._/-]+$/.test(value)) {
    throw new AppError(502, 'PAGES_ROUTE_INCLUDE_INVALID', 'Nginx daemon returned an invalid Route include path');
  }
  const path = normalize(value);
  const expectedSuffix = `${sep}pages${sep}routes${sep}${routeId}.inc`;
  if (!path.endsWith(expectedSuffix)) {
    throw new AppError(502, 'PAGES_ROUTE_INCLUDE_INVALID', 'Nginx daemon returned an unexpected Route include path');
  }
  return path;
}

export function validatePageRuntimeConfigPath(
  bindingKind: PageRuntimeConfigBindingKind,
  bindingId: string,
  value: unknown
): string {
  if (typeof value !== 'string' || !isAbsolute(value) || !/^\/[A-Za-z0-9._/-]+$/.test(value)) {
    throw new AppError(
      502,
      'PAGES_RUNTIME_CONFIG_PATH_INVALID',
      'Nginx daemon returned an invalid runtime config path'
    );
  }
  const path = normalize(value);
  const directory = bindingKind === 'route' ? 'routes' : 'previews';
  if (bindingKind === 'route') {
    const expectedSuffix = `${sep}runtime-configs${sep}${directory}${sep}${bindingId}${sep}current.js`;
    if (!path.endsWith(expectedSuffix)) {
      throw new AppError(
        502,
        'PAGES_RUNTIME_CONFIG_PATH_INVALID',
        'Nginx daemon returned an unexpected runtime config path'
      );
    }
  } else if (!path.endsWith(`${sep}runtime-configs${sep}${directory}${sep}${path.split(sep).at(-2)}${sep}current.js`)) {
    throw new AppError(
      502,
      'PAGES_RUNTIME_CONFIG_PATH_INVALID',
      'Nginx daemon returned an unexpected runtime config path'
    );
  }
  return path;
}

export class PageNodeRuntimeService implements PageProfileRuntimeAdapter {
  private readonly deploymentLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly artifacts: PageArtifactStore,
    private readonly dispatch: NodeDispatchService,
    private readonly certificates: NginxCertificateDistributionService
  ) {}

  async preflight(nodeId: string, requiredBytes: number): Promise<void> {
    const result = await this.dispatch.sendPagesCommand<{ available?: boolean }>(nodeId, {
      pagesStoragePreflight: { requiredBytes: String(requiredBytes) },
    });
    if (result.available !== true) {
      throw new AppError(409, 'PAGES_NODE_STORAGE_UNAVAILABLE', 'Nginx node does not have enough Pages storage');
    }
  }

  async publish(deploymentId: string): Promise<void> {
    const target = await this.previewTarget(deploymentId);
    if (!target) return;
    const certificate = await this.certificates.deployForPages(target.nodeId, target.certificateId);
    await this.materializePreview(target.nodeId, deploymentId, target.hostname, certificate);
  }

  async apply(profile: { domain: string; certificateId: string; labelTemplate: string }): Promise<void> {
    const rows = await this.db
      .select({ deployment: pageDeployments, projectSlug: pageProjects.slug, nodeId: pageProjects.nodeId })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .where(eq(pageDeployments.status, 'ready'));
    const certificates = new Map<string, { certificateId: string; certificateVersion: string }>();
    for (const row of rows) {
      if (!row.nodeId) continue;
      let certificate = certificates.get(row.nodeId);
      if (!certificate) {
        certificate = await this.certificates.deployForPages(row.nodeId, profile.certificateId);
        certificates.set(row.nodeId, certificate);
      }
      const hostname =
        row.deployment.previewHostname ??
        renderPageHostname(profile.labelTemplate, row.deployment.publicSlug, row.projectSlug, profile.domain);
      if (!row.deployment.previewHostname) {
        const [assigned] = await this.db
          .update(pageDeployments)
          .set({ previewHostname: hostname, updatedAt: new Date() })
          .where(and(eq(pageDeployments.id, row.deployment.id), isNull(pageDeployments.previewHostname)))
          .returning({ previewHostname: pageDeployments.previewHostname });
        if (!assigned) {
          const [current] = await this.db
            .select({ previewHostname: pageDeployments.previewHostname })
            .from(pageDeployments)
            .where(eq(pageDeployments.id, row.deployment.id))
            .limit(1);
          if (!current?.previewHostname)
            throw new AppError(409, 'PAGES_PREVIEW_ASSIGNMENT_FAILED', 'Preview hostname changed');
          await this.materializePreview(row.nodeId, row.deployment.id, current.previewHostname, certificate);
          continue;
        }
      }
      await this.materializePreview(row.nodeId, row.deployment.id, hostname, certificate);
    }
  }

  async disable(profile: { domain: string }): Promise<void> {
    const rows = await this.db
      .select({
        replicaId: pageDeploymentReplicas.id,
        deploymentId: pageDeployments.id,
        hostname: pageDeploymentReplicas.referenceId,
        nodeId: pageDeploymentReplicas.nodeId,
      })
      .from(pageDeploymentReplicas)
      .innerJoin(pageDeployments, eq(pageDeploymentReplicas.deploymentId, pageDeployments.id))
      .where(
        and(
          eq(pageDeploymentReplicas.purpose, 'preview'),
          eq(pageDeploymentReplicas.status, 'ready'),
          eq(pageDeployments.status, 'ready')
        )
      );
    for (const row of rows) {
      if (!row.hostname?.endsWith(`.${profile.domain}`)) continue;
      await this.dispatch.sendPagesCommand(row.nodeId, { pagesRemovePreview: { hostname: row.hostname } });
      await this.removeRuntimeConfig(row.nodeId, 'preview', row.hostname);
      await this.db
        .update(pageDeploymentReplicas)
        .set({ status: 'cleanup_pending', cleanupAfter: new Date(), updatedAt: new Date() })
        .where(eq(pageDeploymentReplicas.id, row.replicaId));
    }
  }

  async cleanupNode(profile: { domain: string; nodeId: string }): Promise<void> {
    const rows = await this.db
      .select({
        deploymentId: pageDeployments.id,
        hostname: pageDeployments.previewHostname,
        projectNodeId: pageProjects.nodeId,
      })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .where(sql`${pageDeployments.previewHostname} is not null`);
    for (const row of rows) {
      if (!row.hostname?.endsWith(`.${profile.domain}`) || row.projectNodeId === profile.nodeId) continue;
      await this.dispatch.sendPagesCommand(profile.nodeId, { pagesRemovePreview: { hostname: row.hostname } });
      await this.removeRuntimeConfig(profile.nodeId, 'preview', row.hostname);
      await this.db
        .update(pageDeploymentReplicas)
        .set({ status: 'cleanup_pending', cleanupAfter: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(pageDeploymentReplicas.deploymentId, row.deploymentId),
            eq(pageDeploymentReplicas.nodeId, profile.nodeId),
            eq(pageDeploymentReplicas.purpose, 'preview'),
            eq(pageDeploymentReplicas.referenceId, row.hostname)
          )
        );
    }
  }

  async activateRoute(nodeId: string, routeId: string, deploymentId: string): Promise<string> {
    await this.ensureRelease(nodeId, deploymentId, 'route', routeId);
    try {
      const result = await this.dispatch.sendPagesCommand<{ includePath?: unknown }>(nodeId, {
        pagesActivateTagRoute: { routeId, deploymentId },
      });
      const includePath = validatePageRouteIncludePath(routeId, result.includePath);
      await this.markReplica(nodeId, deploymentId, 'route', routeId, 'ready');
      return includePath;
    } catch (error) {
      await this.markReplica(nodeId, deploymentId, 'route', routeId, 'failed', failureCode(error));
      throw error;
    }
  }

  async publishRuntimeConfig(
    nodeId: string,
    bindingKind: PageRuntimeConfigBindingKind,
    bindingId: string,
    generation: number,
    value: Record<string, unknown>
  ): Promise<string> {
    const protoBindingKind =
      bindingKind === 'route' ? 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE' : 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW';
    const base = { bindingKind: protoBindingKind, bindingId, generation: String(generation) } as const;
    await this.dispatch.sendPagesRuntimeConfigCommand(nodeId, {
      pagesStageRuntimeConfig: { ...base, json: Buffer.from(JSON.stringify(value), 'utf8') },
    });
    try {
      const result = await this.dispatch.sendPagesRuntimeConfigCommand<{ configPath?: unknown }>(nodeId, {
        pagesActivateRuntimeConfig: base,
      });
      return validatePageRuntimeConfigPath(bindingKind, bindingId, result.configPath);
    } catch (activationError) {
      try {
        await this.discardRuntimeConfigGeneration(nodeId, bindingKind, bindingId, generation);
      } catch (cleanupError) {
        throw new AggregateError(
          [activationError, cleanupError],
          'Pages runtime configuration activation recovery failed'
        );
      }
      throw activationError;
    }
  }

  async activateRuntimeConfig(
    nodeId: string,
    bindingKind: PageRuntimeConfigBindingKind,
    bindingId: string,
    generation: number
  ): Promise<string> {
    const protoBindingKind =
      bindingKind === 'route' ? 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE' : 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW';
    const result = await this.dispatch.sendPagesRuntimeConfigCommand<{ configPath?: unknown }>(nodeId, {
      pagesActivateRuntimeConfig: { bindingKind: protoBindingKind, bindingId, generation: String(generation) },
    });
    return validatePageRuntimeConfigPath(bindingKind, bindingId, result.configPath);
  }

  async removeRuntimeConfig(
    nodeId: string,
    bindingKind: PageRuntimeConfigBindingKind,
    bindingId: string
  ): Promise<void> {
    const protoBindingKind =
      bindingKind === 'route' ? 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE' : 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW';
    await this.dispatch.sendPagesRuntimeConfigCommand(nodeId, {
      pagesRemoveRuntimeConfig: { bindingKind: protoBindingKind, bindingId },
    });
  }

  private async discardRuntimeConfigGeneration(
    nodeId: string,
    bindingKind: PageRuntimeConfigBindingKind,
    bindingId: string,
    generation: number
  ): Promise<void> {
    const protoBindingKind =
      bindingKind === 'route' ? 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE' : 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW';
    await this.dispatch.sendPagesRuntimeConfigCommand(nodeId, {
      pagesRemoveRuntimeConfig: {
        bindingKind: protoBindingKind,
        bindingId,
        generation: String(generation),
      },
    });
  }

  async publishPreviewRuntimeConfig(
    projectId: string,
    value: Record<string, unknown>
  ): Promise<PagePreviewRuntimeConfigProgress[]> {
    const replicas = await this.db
      .select({
        replicaId: pageDeploymentReplicas.id,
        deploymentId: pageDeploymentReplicas.deploymentId,
        nodeId: pageDeploymentReplicas.nodeId,
        hostname: pageDeploymentReplicas.referenceId,
      })
      .from(pageDeploymentReplicas)
      .innerJoin(pageDeployments, eq(pageDeploymentReplicas.deploymentId, pageDeployments.id))
      .where(
        and(
          eq(pageDeployments.projectId, projectId),
          eq(pageDeploymentReplicas.purpose, 'preview'),
          eq(pageDeploymentReplicas.status, 'ready')
        )
      );
    const applied: PagePreviewRuntimeConfigProgress[] = [];
    try {
      for (const replica of replicas.sort((left, right) => left.replicaId.localeCompare(right.replicaId))) {
        await this.withDeploymentLock(`${replica.nodeId}:${replica.deploymentId}`, async () => {
          const [current] = await this.db
            .select({ generation: pageDeploymentReplicas.runtimeConfigGeneration })
            .from(pageDeploymentReplicas)
            .where(and(eq(pageDeploymentReplicas.id, replica.replicaId), eq(pageDeploymentReplicas.status, 'ready')))
            .limit(1);
          if (!current) return;
          const nextGeneration = current.generation + 1;
          await this.publishRuntimeConfig(replica.nodeId, 'preview', replica.hostname, nextGeneration, value);
          try {
            const [updated] = await this.db
              .update(pageDeploymentReplicas)
              .set({ runtimeConfigGeneration: nextGeneration, updatedAt: new Date() })
              .where(
                and(
                  eq(pageDeploymentReplicas.id, replica.replicaId),
                  eq(pageDeploymentReplicas.runtimeConfigGeneration, current.generation),
                  eq(pageDeploymentReplicas.status, 'ready')
                )
              )
              .returning({ id: pageDeploymentReplicas.id });
            if (!updated) {
              throw new AppError(
                409,
                'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT',
                'Preview runtime configuration changed concurrently'
              );
            }
            applied.push({
              ...replica,
              fromGeneration: current.generation,
              toGeneration: nextGeneration,
            });
          } catch (error) {
            try {
              await this.restoreRuntimeConfig(
                replica.nodeId,
                'preview',
                replica.hostname,
                current.generation,
                nextGeneration
              );
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], 'Preview runtime configuration recovery failed');
            }
            throw error;
          }
        });
      }
      return applied;
    } catch (error) {
      await this.rollbackPreviewRuntimeConfig(applied);
      throw error;
    }
  }

  async rollbackPreviewRuntimeConfig(progress: PagePreviewRuntimeConfigProgress[]): Promise<void> {
    for (const item of [...progress].reverse()) {
      await this.withDeploymentLock(`${item.nodeId}:${item.deploymentId}`, async () => {
        const [current] = await this.db
          .select({ generation: pageDeploymentReplicas.runtimeConfigGeneration })
          .from(pageDeploymentReplicas)
          .where(eq(pageDeploymentReplicas.id, item.replicaId))
          .limit(1);
        if (current?.generation !== item.toGeneration) return;
        await this.restoreRuntimeConfig(item.nodeId, 'preview', item.hostname, item.fromGeneration, item.toGeneration);
        await this.db
          .update(pageDeploymentReplicas)
          .set({ runtimeConfigGeneration: item.fromGeneration, updatedAt: new Date() })
          .where(
            and(
              eq(pageDeploymentReplicas.id, item.replicaId),
              eq(pageDeploymentReplicas.runtimeConfigGeneration, item.toGeneration)
            )
          );
      });
    }
  }

  private async restoreRuntimeConfig(
    nodeId: string,
    bindingKind: PageRuntimeConfigBindingKind,
    bindingId: string,
    generation: number,
    stagedGeneration = 0
  ): Promise<void> {
    if (generation > 0) {
      await this.activateRuntimeConfig(nodeId, bindingKind, bindingId, generation);
    } else {
      await this.removeRuntimeConfig(nodeId, bindingKind, bindingId);
    }
    if (stagedGeneration > 0 && stagedGeneration !== generation) {
      await this.discardRuntimeConfigGeneration(nodeId, bindingKind, bindingId, stagedGeneration);
    }
  }

  async deactivateRoute(nodeId: string, routeId: string): Promise<void> {
    await this.dispatch.sendPagesCommand(nodeId, { pagesDeactivateTagRoute: { routeId } });
    await this.removeRuntimeConfig(nodeId, 'route', routeId);
  }

  async cleanupDeployment(nodeId: string, deploymentId: string): Promise<void> {
    await this.dispatch.sendPagesCommand(nodeId, { pagesCleanupDeployment: { deploymentId } });
    await this.db
      .delete(pageDeploymentReplicas)
      .where(and(eq(pageDeploymentReplicas.nodeId, nodeId), eq(pageDeploymentReplicas.deploymentId, deploymentId)));
  }

  async cleanupRetainedDeployment(deploymentId: string): Promise<void> {
    const replicas = await this.db
      .select()
      .from(pageDeploymentReplicas)
      .where(eq(pageDeploymentReplicas.deploymentId, deploymentId));
    const byNode = new Map<string, typeof replicas>();
    for (const replica of replicas) {
      const current = byNode.get(replica.nodeId) ?? [];
      current.push(replica);
      byNode.set(replica.nodeId, current);
    }
    for (const [nodeId, nodeReplicas] of byNode) {
      for (const preview of nodeReplicas.filter((replica) => replica.purpose === 'preview')) {
        await this.dispatch.sendPagesCommand(nodeId, {
          pagesRemovePreview: { hostname: preview.referenceId },
        });
        await this.removeRuntimeConfig(nodeId, 'preview', preview.referenceId);
      }
      await this.dispatch.sendPagesCommand(nodeId, { pagesCleanupDeployment: { deploymentId } });
    }
    await this.db.delete(pageDeploymentReplicas).where(eq(pageDeploymentReplicas.deploymentId, deploymentId));
  }

  async stageProjectMigration(projectId: string, targetNodeId: string): Promise<void> {
    const [profile] = await this.db
      .select({
        domain: domains.domain,
        certificateId: pageWildcardProfiles.certificateId,
        labelTemplate: pageWildcardProfiles.labelTemplate,
      })
      .from(pageWildcardProfiles)
      .innerJoin(domains, eq(pageWildcardProfiles.domainId, domains.id))
      .where(and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true)))
      .limit(1);
    if (!profile?.certificateId) {
      throw new AppError(409, 'PAGES_PROFILE_INVALID', 'Configure the Pages wildcard profile before migrating');
    }
    const deployments = await this.db
      .select({ deployment: pageDeployments, projectSlug: pageProjects.slug })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .where(and(eq(pageDeployments.projectId, projectId), eq(pageDeployments.status, 'ready')));
    const requiredBytes = deployments.reduce((total, row) => total + row.deployment.compressedSizeBytes, 0);
    await this.preflight(targetNodeId, requiredBytes);
    const certificate = await this.certificates.deployForPages(targetNodeId, profile.certificateId);
    for (const row of deployments) {
      const hostname =
        row.deployment.previewHostname ??
        renderPageHostname(profile.labelTemplate, row.deployment.publicSlug, row.projectSlug, profile.domain);
      if (!row.deployment.previewHostname) {
        await this.db
          .update(pageDeployments)
          .set({ previewHostname: hostname, updatedAt: new Date() })
          .where(and(eq(pageDeployments.id, row.deployment.id), isNull(pageDeployments.previewHostname)));
      }
      await this.materializePreview(targetNodeId, row.deployment.id, hostname, certificate);
    }
  }

  async cleanupProjectNode(projectId: string, nodeId: string): Promise<void> {
    const replicas = await this.db
      .select({
        id: pageDeploymentReplicas.id,
        deploymentId: pageDeploymentReplicas.deploymentId,
        hostname: pageDeploymentReplicas.referenceId,
      })
      .from(pageDeploymentReplicas)
      .innerJoin(pageDeployments, eq(pageDeploymentReplicas.deploymentId, pageDeployments.id))
      .where(
        and(
          eq(pageDeployments.projectId, projectId),
          eq(pageDeploymentReplicas.nodeId, nodeId),
          eq(pageDeploymentReplicas.purpose, 'preview')
        )
      );
    for (const replica of replicas) {
      await this.dispatch.sendPagesCommand(nodeId, { pagesRemovePreview: { hostname: replica.hostname } });
      await this.removeRuntimeConfig(nodeId, 'preview', replica.hostname);
      await this.db.delete(pageDeploymentReplicas).where(eq(pageDeploymentReplicas.id, replica.id));
      const [remaining] = await this.db
        .select({ id: pageDeploymentReplicas.id })
        .from(pageDeploymentReplicas)
        .where(
          and(eq(pageDeploymentReplicas.deploymentId, replica.deploymentId), eq(pageDeploymentReplicas.nodeId, nodeId))
        )
        .limit(1);
      if (!remaining) {
        await this.dispatch.sendPagesCommand(nodeId, {
          pagesCleanupDeployment: { deploymentId: replica.deploymentId },
        });
      }
    }
  }

  private async materializePreview(
    nodeId: string,
    deploymentId: string,
    hostname: string,
    certificate: { certificateId: string; certificateVersion: string }
  ): Promise<void> {
    await this.ensureRelease(nodeId, deploymentId, 'preview', hostname);
    try {
      const projectId = await this.previewProjectId(deploymentId);
      // Take the project lock before the deployment lock. Default publication
      // takes the same order when it updates existing preview replicas.
      await withPageDefaultRuntimeConfigLock(this.db, projectId, () =>
        this.withDeploymentLock(`${nodeId}:${deploymentId}`, async () => {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const { sourceGeneration } = await this.ensurePreviewRuntimeConfig(nodeId, deploymentId, hostname);
            await this.dispatch.sendPagesCommand(nodeId, {
              pagesMaterializePreview: {
                profileId: PROFILE_ID,
                deploymentId,
                hostname,
                certificateId: certificate.certificateId,
                certificateVersion: certificate.certificateVersion,
              },
            });

            const [latest] = await this.db
              .select({ generation: pageRuntimeConfigs.generation })
              .from(pageDeploymentReplicas)
              .innerJoin(pageDeployments, eq(pageDeploymentReplicas.deploymentId, pageDeployments.id))
              .innerJoin(
                pageRuntimeConfigs,
                and(eq(pageRuntimeConfigs.projectId, pageDeployments.projectId), isNull(pageRuntimeConfigs.tagId))
              )
              .where(
                and(
                  eq(pageDeploymentReplicas.deploymentId, deploymentId),
                  eq(pageDeploymentReplicas.nodeId, nodeId),
                  eq(pageDeploymentReplicas.purpose, 'preview'),
                  eq(pageDeploymentReplicas.referenceId, hostname)
                )
              )
              .limit(1);
            if (latest?.generation !== sourceGeneration) continue;
            // This UPDATE has a PostgreSQL statement snapshot. Holding the
            // shared lock makes that snapshot mutually exclusive with Default
            // mutation and publication, so it cannot claim stale readiness.
            const ready = await this.markPreviewReplicaReady(nodeId, deploymentId, hostname, sourceGeneration);
            if (!ready) continue;
            return;
          }
          throw new AppError(
            409,
            'PAGE_RUNTIME_CONFIG_CHANGED_CONCURRENTLY',
            'Default runtime configuration changed while materializing the preview'
          );
        })
      );
    } catch (error) {
      await this.markReplica(nodeId, deploymentId, 'preview', hostname, 'failed', failureCode(error));
      throw error;
    }
  }

  private async ensurePreviewRuntimeConfig(
    nodeId: string,
    deploymentId: string,
    hostname: string
  ): Promise<{ sourceGeneration: number }> {
    const [state] = await this.db
      .select({
        replicaId: pageDeploymentReplicas.id,
        runtimeConfigGeneration: pageDeploymentReplicas.runtimeConfigGeneration,
        defaultGeneration: pageRuntimeConfigs.generation,
        value: pageRuntimeConfigs.value,
      })
      .from(pageDeploymentReplicas)
      .innerJoin(pageDeployments, eq(pageDeploymentReplicas.deploymentId, pageDeployments.id))
      .innerJoin(
        pageRuntimeConfigs,
        and(eq(pageRuntimeConfigs.projectId, pageDeployments.projectId), isNull(pageRuntimeConfigs.tagId))
      )
      .where(
        and(
          eq(pageDeploymentReplicas.deploymentId, deploymentId),
          eq(pageDeploymentReplicas.nodeId, nodeId),
          eq(pageDeploymentReplicas.purpose, 'preview'),
          eq(pageDeploymentReplicas.referenceId, hostname)
        )
      )
      .limit(1);
    if (!state)
      throw new AppError(500, 'PAGE_RUNTIME_CONFIG_DEFAULT_MISSING', 'Default runtime configuration is missing');
    // Replica generations are independent immutable daemon files. Keep them
    // monotonic while also catching up to a newer Default source generation.
    const generation = Math.max(state.runtimeConfigGeneration, state.defaultGeneration, 1);
    await this.publishRuntimeConfig(nodeId, 'preview', hostname, generation, state.value);
    try {
      const [updated] = await this.db
        .update(pageDeploymentReplicas)
        .set({ runtimeConfigGeneration: generation, updatedAt: new Date() })
        .where(
          and(
            eq(pageDeploymentReplicas.id, state.replicaId),
            eq(pageDeploymentReplicas.runtimeConfigGeneration, state.runtimeConfigGeneration),
            eq(pageDeploymentReplicas.status, 'materializing')
          )
        )
        .returning({ id: pageDeploymentReplicas.id });
      if (!updated) {
        throw new AppError(
          409,
          'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT',
          'Preview runtime configuration changed concurrently'
        );
      }
    } catch (error) {
      try {
        await this.restoreRuntimeConfig(nodeId, 'preview', hostname, state.runtimeConfigGeneration, generation);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Preview runtime configuration recovery failed');
      }
      throw error;
    }
    return { sourceGeneration: state.defaultGeneration };
  }

  private async markPreviewReplicaReady(
    nodeId: string,
    deploymentId: string,
    hostname: string,
    expectedDefaultGeneration: number
  ): Promise<boolean> {
    const [updated] = await this.db
      .update(pageDeploymentReplicas)
      .set({
        status: 'ready',
        appliedSha256: sql`(select artifact_sha256 from page_deployments where id = ${deploymentId})`,
        lastErrorCode: null,
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pageDeploymentReplicas.deploymentId, deploymentId),
          eq(pageDeploymentReplicas.nodeId, nodeId),
          eq(pageDeploymentReplicas.purpose, 'preview'),
          eq(pageDeploymentReplicas.referenceId, hostname),
          eq(pageDeploymentReplicas.status, 'materializing'),
          sql`exists (
            select 1
            from ${pageDeployments}
            inner join ${pageRuntimeConfigs}
              on ${pageRuntimeConfigs.projectId} = ${pageDeployments.projectId}
            where ${pageDeployments.id} = ${pageDeploymentReplicas.deploymentId}
              and ${pageRuntimeConfigs.tagId} is null
              and ${pageRuntimeConfigs.generation} = ${expectedDefaultGeneration}
          )`
        )
      )
      .returning({ id: pageDeploymentReplicas.id });
    return Boolean(updated);
  }

  private async ensureRelease(
    nodeId: string,
    deploymentId: string,
    purpose: ReplicaPurpose,
    referenceId: string
  ): Promise<void> {
    await this.withDeploymentLock(`${nodeId}:${deploymentId}`, async () => {
      const [deployment] = await this.db
        .select()
        .from(pageDeployments)
        .where(
          and(eq(pageDeployments.id, deploymentId), inArray(pageDeployments.status, ['stored', 'staging', 'ready']))
        )
        .limit(1);
      if (!deployment?.artifactKey || !deployment.artifactSha256 || deployment.compressedSizeBytes <= 0) {
        throw new AppError(409, 'PAGE_DEPLOYMENT_NOT_MATERIALIZABLE', 'Deployment artifact is unavailable');
      }

      await this.upsertReplica(nodeId, deploymentId, purpose, referenceId, 'uploading');
      try {
        await this.preflight(nodeId, deployment.compressedSizeBytes);
        try {
          await this.dispatch.sendPagesCommand(nodeId, {
            pagesVerifyRelease: { deploymentId, sha256: deployment.artifactSha256 },
          });
        } catch {
          const uploadId = randomUUID();
          await this.dispatch.sendPagesCommand(nodeId, {
            pagesUploadInit: {
              uploadId,
              deploymentId,
              expectedSize: String(deployment.compressedSizeBytes),
              sha256: deployment.artifactSha256,
            },
          });
          let offset = 0;
          for await (const rawChunk of this.artifacts.read(deployment.artifactKey)) {
            const content = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            const result = await this.dispatch.sendPagesCommand<{ nextOffset?: number }>(nodeId, {
              pagesUploadChunk: { uploadId, offset: String(offset), content },
            });
            const nextOffset = Number(result.nextOffset);
            if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + content.byteLength) {
              throw new AppError(502, 'PAGES_UPLOAD_ACK_INVALID', 'Nginx daemon returned an invalid upload offset');
            }
            offset = nextOffset;
          }
          if (offset !== deployment.compressedSizeBytes) {
            throw new AppError(409, 'PAGES_ARTIFACT_SIZE_CHANGED', 'Deployment artifact size changed during transfer');
          }
          await this.dispatch.sendPagesCommand(nodeId, {
            pagesUploadFinalize: { uploadId, deploymentId },
          });
        }
        await this.markReplica(nodeId, deploymentId, purpose, referenceId, 'materializing');
      } catch (error) {
        await this.markReplica(nodeId, deploymentId, purpose, referenceId, 'failed', failureCode(error));
        throw error;
      }
    });
  }

  private async previewTarget(deploymentId: string) {
    const [row] = await this.db
      .select({
        deployment: pageDeployments,
        projectSlug: pageProjects.slug,
        projectNodeId: pageProjects.nodeId,
        profile: pageWildcardProfiles,
        domain: domains,
      })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .innerJoin(
        pageWildcardProfiles,
        and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true))
      )
      .innerJoin(domains, eq(pageWildcardProfiles.domainId, domains.id))
      .where(eq(pageDeployments.id, deploymentId))
      .limit(1);
    if (!row?.projectNodeId || !row.profile.certificateId) return null;
    const computed = renderPageHostname(
      row.profile.labelTemplate,
      row.deployment.publicSlug,
      row.projectSlug,
      row.domain.domain
    );
    let hostname = row.deployment.previewHostname;
    if (!hostname) {
      const [assigned] = await this.db
        .update(pageDeployments)
        .set({ previewHostname: computed, updatedAt: new Date() })
        .where(and(eq(pageDeployments.id, deploymentId), sql`${pageDeployments.previewHostname} is null`))
        .returning({ previewHostname: pageDeployments.previewHostname });
      hostname = assigned?.previewHostname ?? null;
      if (!hostname) {
        const [current] = await this.db
          .select({ previewHostname: pageDeployments.previewHostname })
          .from(pageDeployments)
          .where(eq(pageDeployments.id, deploymentId))
          .limit(1);
        hostname = current?.previewHostname ?? null;
      }
    }
    if (!hostname) throw new AppError(409, 'PAGES_PREVIEW_ASSIGNMENT_FAILED', 'Preview hostname was not assigned');
    return { hostname, nodeId: row.projectNodeId, certificateId: row.profile.certificateId };
  }

  private async previewProjectId(deploymentId: string): Promise<string> {
    const [deployment] = await this.db
      .select({ projectId: pageDeployments.projectId })
      .from(pageDeployments)
      .where(eq(pageDeployments.id, deploymentId))
      .limit(1);
    if (!deployment) throw new AppError(409, 'PAGE_DEPLOYMENT_NOT_MATERIALIZABLE', 'Deployment is unavailable');
    return deployment.projectId;
  }

  private async upsertReplica(
    nodeId: string,
    deploymentId: string,
    purpose: ReplicaPurpose,
    referenceId: string,
    status: 'uploading'
  ): Promise<void> {
    await this.db
      .insert(pageDeploymentReplicas)
      .values({ nodeId, deploymentId, purpose, referenceId, status, generation: 1 })
      .onConflictDoUpdate({
        target: [
          pageDeploymentReplicas.deploymentId,
          pageDeploymentReplicas.nodeId,
          pageDeploymentReplicas.purpose,
          pageDeploymentReplicas.referenceId,
        ],
        set: {
          status,
          generation: sql`${pageDeploymentReplicas.generation} + 1`,
          cleanupAfter: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        },
      });
  }

  private async markReplica(
    nodeId: string,
    deploymentId: string,
    purpose: ReplicaPurpose,
    referenceId: string,
    status: 'materializing' | 'ready' | 'failed',
    errorCode: string | null = null
  ): Promise<void> {
    await this.db
      .update(pageDeploymentReplicas)
      .set({
        status,
        appliedSha256:
          status === 'ready'
            ? sql`(select artifact_sha256 from page_deployments where id = ${deploymentId})`
            : undefined,
        lastErrorCode: errorCode,
        lastVerifiedAt: status === 'ready' ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pageDeploymentReplicas.deploymentId, deploymentId),
          eq(pageDeploymentReplicas.nodeId, nodeId),
          eq(pageDeploymentReplicas.purpose, purpose),
          eq(pageDeploymentReplicas.referenceId, referenceId)
        )
      );
  }

  private async withDeploymentLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.deploymentLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.deploymentLocks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.deploymentLocks.get(key) === queued) this.deploymentLocks.delete(key);
    }
  }
}
