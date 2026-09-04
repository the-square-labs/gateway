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
import { renderPageHostname, withPageProfileLock } from '../profile/page-profile.service.js';
import { withPageDefaultRuntimeConfigLock } from '../runtime-config/page-runtime-config.service.js';
import {
  bindingInspectionKey,
  bindingInspectionMatches,
  type PageBindingExpectation,
  type PageBindingInspection,
} from './page-binding-inspection.js';

const PROFILE_ID = 'default';

type ReplicaPurpose = 'preview' | 'route' | 'migration';
const PREVIEW_CLEANUP_STATUSES = [
  'pending',
  'uploading',
  'materializing',
  'ready',
  'failed',
  'capability_missing',
  'cleanup_pending',
] as const;
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

  async supportsInspection(nodeId: string): Promise<boolean> {
    return (await this.dispatch.supportsPagesReconciliation?.(nodeId)) === true;
  }

  async inspectBindings(
    bindings: Array<{ nodeId: string; expectation: PageBindingExpectation }>
  ): Promise<PageBindingInspection> {
    const matches: PageBindingInspection = new Map();
    const byNode = new Map<string, PageBindingExpectation[]>();
    for (const { nodeId, expectation } of bindings) {
      const batch = byNode.get(nodeId) ?? [];
      batch.push(expectation);
      byNode.set(nodeId, batch);
    }
    for (const [nodeId, expected] of byNode) {
      // Bounded command payloads; no snapshot or verification survives a cycle.
      for (let start = 0; start < expected.length; start += 64) {
        const batch = expected.slice(start, start + 64);
        let result: { matches?: unknown };
        try {
          result = await this.dispatch.sendPagesCommand<{ matches?: unknown }>(nodeId, {
            pagesInventory: { expectationsJson: Buffer.from(JSON.stringify(batch)) },
          });
        } catch {
          // No proof means no fast path. Preserve per-binding recovery and
          // failure reporting instead of aborting unrelated node reconciliation.
          continue;
        }
        if (!Array.isArray(result.matches) || result.matches.length !== batch.length) continue;
        const matched = result.matches;
        batch.forEach((binding, index) => {
          matches.set(bindingInspectionKey(nodeId, binding), {
            expectation: structuredClone(binding),
            matches: matched[index] === true,
          });
        });
      }
    }
    return matches;
  }

  async routeExpectation(input: {
    routeId: string;
    deploymentId: string;
    generation: number;
    stateGeneration: number;
    runtimeConfig: Record<string, unknown>;
  }): Promise<PageBindingExpectation | null> {
    const [deployment] = await this.db
      .select({ sha256: pageDeployments.artifactSha256, size: pageDeployments.compressedSizeBytes })
      .from(pageDeployments)
      .where(and(eq(pageDeployments.id, input.deploymentId), eq(pageDeployments.status, 'ready')))
      .limit(1);
    if (!deployment?.sha256 || !deployment.size || input.generation <= 0) return null;
    return {
      kind: 'route',
      id: input.routeId,
      deploymentId: input.deploymentId,
      sha256: deployment.sha256,
      size: deployment.size,
      generation: input.generation,
      stateGeneration: input.stateGeneration,
      runtimeConfig: input.runtimeConfig,
    };
  }

  private async previewExpectation(
    nodeId: string,
    deploymentId: string,
    hostname: string,
    certificate: { certificateId: string; certificateVersion: string }
  ): Promise<PageBindingExpectation | null> {
    const [state] = await this.db
      .select({
        generation: pageDeploymentReplicas.runtimeConfigGeneration,
        sourceGeneration: pageRuntimeConfigs.generation,
        value: pageRuntimeConfigs.value,
        sha256: pageDeployments.artifactSha256,
        size: pageDeployments.compressedSizeBytes,
        spaFallback: pageProjects.spaFallback,
        fallbackUrl: pageProjects.fallbackUrl,
      })
      .from(pageDeploymentReplicas)
      .innerJoin(pageDeployments, eq(pageDeploymentReplicas.deploymentId, pageDeployments.id))
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .innerJoin(
        pageRuntimeConfigs,
        and(eq(pageRuntimeConfigs.projectId, pageDeployments.projectId), isNull(pageRuntimeConfigs.tagId))
      )
      .where(
        and(
          eq(pageDeploymentReplicas.nodeId, nodeId),
          eq(pageDeploymentReplicas.deploymentId, deploymentId),
          eq(pageDeploymentReplicas.purpose, 'preview'),
          eq(pageDeploymentReplicas.referenceId, hostname),
          eq(pageDeploymentReplicas.status, 'ready'),
          eq(pageDeployments.status, 'ready'),
          eq(pageProjects.nodeId, nodeId)
        )
      )
      .limit(1);
    if (!state?.sha256 || !state.size || state.generation <= 0) return null;
    return {
      kind: 'preview',
      id: hostname,
      deploymentId,
      sha256: state.sha256,
      size: state.size,
      // A disk generation ahead of the replica row still needs reconciliation.
      generation: state.generation,
      stateGeneration: state.sourceGeneration,
      runtimeConfig: state.value,
      ...certificate,
      spaFallback: state.spaFallback,
      fallbackUrl: state.fallbackUrl ?? '',
    };
  }

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

  async refreshProjectFallback(projectId: string): Promise<void> {
    const deployments = await this.db
      .select({ id: pageDeployments.id })
      .from(pageDeployments)
      .where(and(eq(pageDeployments.projectId, projectId), eq(pageDeployments.status, 'ready')));
    for (const deployment of deployments) await this.publish(deployment.id);
  }

  async apply(profile: { domain: string; certificateId: string; labelTemplate: string }): Promise<void> {
    const rows = await this.db
      .select({ deployment: pageDeployments, projectSlug: pageProjects.slug, nodeId: pageProjects.nodeId })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .where(eq(pageDeployments.status, 'ready'));
    const byNode = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.nodeId) continue;
      const nodeRows = byNode.get(row.nodeId) ?? [];
      nodeRows.push(row);
      byNode.set(row.nodeId, nodeRows);
    }
    const failures: unknown[] = [];
    for (const [nodeId, nodeRows] of byNode) {
      try {
        // Finish each node independently: an unavailable certificate/daemon on
        // another node must not prevent healthy previews from recovering.
        const certificate = await this.certificates.deployForPages(nodeId, profile.certificateId);
        const pending: Array<{ deploymentId: string; hostname: string }> = [];
        for (const row of nodeRows) {
          let hostname =
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
              hostname = current.previewHostname;
            }
          }
          pending.push({ deploymentId: row.deployment.id, hostname });
        }
        const supported = await this.supportsInspection(nodeId);
        const bindings: Array<{ nodeId: string; expectation: PageBindingExpectation }> = [];
        if (supported) {
          for (const item of pending) {
            const expectation = await this.previewExpectation(nodeId, item.deploymentId, item.hostname, certificate);
            if (expectation) bindings.push({ nodeId, expectation });
          }
        }
        const inspection = await this.inspectBindings(bindings);
        for (const item of pending) {
          await this.materializePreview(nodeId, item.deploymentId, item.hostname, certificate, inspection);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    // Preserve specific capability/error codes for the usual single failure.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Pages preview reconciliation failed on some nodes');
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
          inArray(pageDeploymentReplicas.status, PREVIEW_CLEANUP_STATUSES),
          inArray(pageDeployments.status, ['stored', 'staging', 'ready', 'cleaning'])
        )
      );
    const failures: unknown[] = [];
    for (const row of rows) {
      if (!row.hostname?.endsWith(`.${profile.domain}`)) continue;

      // Invalidate the DB row before touching the daemon. A preview that is
      // already uploading/materializing must not win a later ready CAS after
      // the profile has been disabled.
      try {
        await this.db
          .update(pageDeploymentReplicas)
          .set({
            status: 'cleanup_pending',
            cleanupAfter: new Date(),
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageDeploymentReplicas.id, row.replicaId),
              inArray(pageDeploymentReplicas.status, PREVIEW_CLEANUP_STATUSES)
            )
          );
      } catch (error) {
        failures.push(error);
        continue;
      }

      let cleanupError: unknown;
      try {
        await this.dispatch.sendPagesCommand(row.nodeId, { pagesRemovePreview: { hostname: row.hostname } });
      } catch (error) {
        cleanupError = error;
      }
      try {
        await this.removeRuntimeConfig(row.nodeId, 'preview', row.hostname);
      } catch (error) {
        cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
      }

      if (cleanupError) {
        failures.push(cleanupError);
        try {
          await this.db
            .update(pageDeploymentReplicas)
            .set({
              status: 'cleanup_pending',
              cleanupAfter: new Date(),
              lastErrorCode: failureCode(cleanupError),
              updatedAt: new Date(),
            })
            .where(eq(pageDeploymentReplicas.id, row.replicaId));
        } catch (persistError) {
          failures.push(persistError);
        }
        continue;
      }

      await this.db.delete(pageDeploymentReplicas).where(eq(pageDeploymentReplicas.id, row.replicaId));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Pages preview cleanup is pending');
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
    certificate: { certificateId: string; certificateVersion: string },
    inspection?: PageBindingInspection
  ): Promise<void> {
    try {
      await withPageProfileLock(this.db, async () => {
        await this.assertProfileEnabled();
        let repairExisting = false;
        if (inspection?.has(bindingInspectionKey(nodeId, { kind: 'preview', id: hostname }))) {
          const project = await this.previewProjectConfig(deploymentId);
          const unchanged = await withPageDefaultRuntimeConfigLock(this.db, project.projectId, () =>
            this.withDeploymentLock(`${nodeId}:${deploymentId}`, async () =>
              bindingInspectionMatches(
                inspection,
                nodeId,
                await this.previewExpectation(nodeId, deploymentId, hostname, certificate)
              )
            )
          );
          if (unchanged) return;
          repairExisting = true;
        }
        await this.ensureRelease(nodeId, deploymentId, 'preview', hostname);
        const project = await this.previewProjectConfig(deploymentId);
        // Take the project lock before the deployment lock. Default publication
        // takes the same order when it updates existing preview replicas.
        await withPageDefaultRuntimeConfigLock(this.db, project.projectId, () =>
          this.withDeploymentLock(`${nodeId}:${deploymentId}`, async () => {
            for (let attempt = 0; attempt < 8; attempt += 1) {
              // The profile lock serializes the complete materialization and
              // ready transition with disable().
              const { sourceGeneration } = await this.ensurePreviewRuntimeConfig(
                nodeId,
                deploymentId,
                hostname,
                repairExisting && attempt === 0
              );
              await this.dispatch.sendPagesCommand(nodeId, {
                pagesMaterializePreview: {
                  profileId: PROFILE_ID,
                  deploymentId,
                  hostname,
                  certificateId: certificate.certificateId,
                  certificateVersion: certificate.certificateVersion,
                  spaFallback: project.spaFallback,
                  fallbackUrl: project.fallbackUrl ?? '',
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
      });
    } catch (error) {
      if (failureCode(error) !== 'PAGES_PROFILE_DISABLED') {
        await this.markReplica(nodeId, deploymentId, 'preview', hostname, 'failed', failureCode(error));
      }
      throw error;
    }
  }

  private async assertProfileEnabled(): Promise<void> {
    const [profile] = await this.db
      .select({ enabled: pageWildcardProfiles.enabled })
      .from(pageWildcardProfiles)
      .where(and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true)))
      .limit(1);
    if (!profile) {
      throw new AppError(409, 'PAGES_PROFILE_DISABLED', 'Pages immutable previews are disabled');
    }
  }

  private async ensurePreviewRuntimeConfig(
    nodeId: string,
    deploymentId: string,
    hostname: string,
    advanceGeneration = false
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
    const generation = Math.max(
      state.runtimeConfigGeneration + (advanceGeneration ? 1 : 0),
      state.defaultGeneration,
      1
    );
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

  private async previewProjectConfig(deploymentId: string): Promise<{
    projectId: string;
    spaFallback: boolean;
    fallbackUrl: string | null;
  }> {
    const [deployment] = await this.db
      .select({
        projectId: pageDeployments.projectId,
        spaFallback: pageProjects.spaFallback,
        fallbackUrl: pageProjects.fallbackUrl,
      })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .where(eq(pageDeployments.id, deploymentId))
      .limit(1);
    if (!deployment) throw new AppError(409, 'PAGE_DEPLOYMENT_NOT_MATERIALIZABLE', 'Deployment is unavailable');
    return deployment;
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
