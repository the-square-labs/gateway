import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuilds, dockerSourceBindings, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerBuildService } from './docker-build.service.js';
import type { DockerSourceService } from './docker-source.service.js';

const logger = createChildLogger('DockerBuildRunner');
const ACTIVE_STATUSES = ['claimed', 'checking_out', 'building', 'scanning', 'pushing'] as const;

function builderPlatform(capabilities: unknown): 'linux/amd64' | 'linux/arm64' | null {
  const architecture =
    capabilities && typeof capabilities === 'object'
      ? String((capabilities as Record<string, unknown>).architecture ?? '').toLowerCase()
      : '';
  if (architecture === 'amd64' || architecture === 'x86_64') return 'linux/amd64';
  if (architecture === 'arm64' || architecture === 'aarch64') return 'linux/arm64';
  return null;
}

function builderReady(capabilities: unknown): boolean {
  const reported =
    capabilities && typeof capabilities === 'object'
      ? (capabilities as Record<string, unknown>).capabilities
      : undefined;
  return (
    Array.isArray(reported) &&
    reported.includes('docker_builder_execution_v1') &&
    reported.includes('docker_builder_dedicated_runtime_v1') &&
    reported.includes('docker_builder_resource_limits_v1')
  );
}

function policyLimit(policy: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(policy[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export class DockerBuildRunnerService {
  private running = false;
  private sources?: DockerSourceService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly builds: DockerBuildService,
    private readonly dispatch: NodeDispatchService,
    private readonly integrations: IntegrationsService,
    private readonly registry: RelayRegistryService
  ) {}

  setSourceService(sources: DockerSourceService): void {
    this.sources = sources;
  }

  async assertBuildAdmission(): Promise<void> {
    const builders = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(and(eq(nodes.type, 'builder'), eq(nodes.status, 'online')));
    if (!builders.some((builder) => builderPlatform(builder.capabilities) && builderReady(builder.capabilities))) {
      throw new AppError(
        503,
        'NO_BUILD_WORKER_AVAILABLE',
        'No online Build Worker supports the required dedicated build runtime'
      );
    }
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcileCancellations();
      const builders = await this.db
        .select({ id: nodes.id, capabilities: nodes.capabilities })
        .from(nodes)
        .where(and(eq(nodes.type, 'builder'), eq(nodes.status, 'online')));
      for (const builder of builders) {
        const platform = builderPlatform(builder.capabilities);
        if (!platform || !builderReady(builder.capabilities)) continue;
        const [active] = await this.db
          .select({ id: dockerBuilds.id })
          .from(dockerBuilds)
          .where(and(eq(dockerBuilds.builderNodeId, builder.id), inArray(dockerBuilds.status, [...ACTIVE_STATUSES])))
          .limit(1);
        if (active) continue;
        await this.claimAndDispatch(builder.id, platform);
      }
    } finally {
      this.running = false;
    }
  }

  private async claimAndDispatch(builderNodeId: string, platform: 'linux/amd64' | 'linux/arm64'): Promise<void> {
    const leaseOwner = `gateway:${process.pid}:${randomUUID()}`;
    const build = await this.builds.claimNext({ builderNodeId, leaseOwner, platform });
    if (!build) return;
    try {
      const [source] = await this.db
        .select()
        .from(dockerSourceBindings)
        .where(eq(dockerSourceBindings.id, build.sourceBindingId))
        .limit(1);
      if (!source) throw new Error('Docker source binding disappeared after the build was claimed');
      if (source.configGeneration !== build.sourceConfigGeneration) {
        await this.builds.transition(build.id, leaseOwner, 'superseded', {
          errorCode: 'SUPERSEDED_BY_SOURCE_CONFIG',
          errorMessage: 'Build settings or Build Secrets changed before the build was dispatched',
        });
        return;
      }
      if (!this.sources) throw new Error('Docker source secret service is unavailable');
      const buildSecrets = await this.sources.getDecryptedBuildSecrets(source.id);
      const credential = await this.integrations.resolveDockerBuildCheckoutCredential({
        connectorId: source.connectorId,
        repositoryUrl: source.repositoryCloneUrl,
        repositoryRemoteId: source.repositoryRemoteId,
      });
      const outputRepository = `gateway/builds/${source.id}${build.serviceName ? `/${build.serviceName}` : ''}`;
      await this.registry.ensureBinding({
        nodeId: builderNodeId,
        role: 'builder',
        repository: outputRepository,
        actions: ['pull', 'push'],
        contextKind: 'build',
        contextId: build.id,
      });
      const policy = source.policy as Record<string, unknown>;
      const result = await this.dispatch.sendDockerBuildCommand(builderNodeId, {
        buildId: build.id,
        repositoryUrl: source.repositoryCloneUrl,
        repositoryRemoteId: build.repositoryRemoteId,
        repositoryFullPath: build.repositoryFullPath,
        ref: build.ref,
        commitSha: build.commitSha,
        dockerfilePath: build.dockerfilePath,
        contextPath: build.contextPath,
        platform,
        outputRepository,
        outputTag: build.id,
        buildArgs: build.buildArgs,
        buildSecrets,
        checkoutCredential: Buffer.from(JSON.stringify(credential)),
        allowedDependencies: [],
        cpuLimitMillis: String(policyLimit(policy, 'cpuLimitMillis', 2000)),
        memoryLimitBytes: String(policyLimit(policy, 'memoryLimitBytes', 4 * 1024 ** 3)),
        diskLimitBytes: String(policyLimit(policy, 'diskLimitBytes', 20 * 1024 ** 3)),
        timeoutSeconds: policyLimit(policy, 'timeoutSeconds', 1800),
        outputKind: source.targetKind === 'pages_project' ? 'pages_archive' : 'oci_image',
        applicationRoot: build.applicationRoot,
        packageManager: build.packageManager ?? '',
        packageManagerVersion: build.packageManagerVersion ?? '',
        nodeVersion: build.nodeVersion ?? '',
        buildScript: build.buildScript ?? '',
        artifactDirectory: build.artifactDirectory ?? '',
      });
      if (!result.success) throw new Error(result.error || 'Builder daemon rejected the build');
    } catch (error) {
      const errorMessage = (error as Error).message.slice(0, 4096);
      logger.warn('Failed to dispatch Docker build', {
        buildId: build.id,
        builderNodeId,
        error: errorMessage,
      });
      await this.builds.appendLog(build.id, 0, `[system] Build dispatch failed: ${errorMessage}\n`).catch((logError) =>
        logger.warn('Failed to persist Docker build dispatch error log', {
          buildId: build.id,
          error: (logError as Error).message,
        })
      );
      await this.builds.transition(build.id, leaseOwner, 'failed', {
        errorCode: 'BUILD_DISPATCH_FAILED',
        errorMessage,
      });
    }
  }

  private async reconcileCancellations(): Promise<void> {
    const rows = await this.db
      .select({ id: dockerBuilds.id, builderNodeId: dockerBuilds.builderNodeId })
      .from(dockerBuilds)
      .where(
        and(
          inArray(dockerBuilds.status, [...ACTIVE_STATUSES]),
          isNotNull(dockerBuilds.cancellationRequestedAt),
          isNotNull(dockerBuilds.builderNodeId)
        )
      );
    await Promise.allSettled(
      rows.map(({ id, builderNodeId }) => this.dispatch.cancelDockerBuild(builderNodeId!, id, 'cancelled by user'))
    );
  }
}
