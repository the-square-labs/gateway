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
import { readBuilderNodeSettings } from './docker-build-policy.js';
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
  const hasDedicatedRuntime =
    Array.isArray(reported) &&
    (reported.includes('docker_builder_dedicated_runtime_v1') ||
      // Rolling compatibility with the previous gVisor-backed worker profile.
      reported.includes('docker_builder_isolation_v1'));
  return (
    Array.isArray(reported) &&
    reported.includes('docker_builder_execution_v1') &&
    hasDedicatedRuntime &&
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
        .select({ id: nodes.id, capabilities: nodes.capabilities, metadata: nodes.metadata })
        .from(nodes)
        .where(and(eq(nodes.type, 'builder'), eq(nodes.status, 'online')));
      for (const builder of builders) {
        const platform = builderPlatform(builder.capabilities);
        if (!platform || !builderReady(builder.capabilities)) continue;
        const settings = readBuilderNodeSettings(builder.metadata);
        const active = await this.db
          .select({ id: dockerBuilds.id })
          .from(dockerBuilds)
          .where(and(eq(dockerBuilds.builderNodeId, builder.id), inArray(dockerBuilds.status, [...ACTIVE_STATUSES])));
        for (let slot = active.length; slot < settings.parallelism; slot += 1) {
          if (!(await this.claimAndDispatch(builder.id, platform, settings))) break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async claimAndDispatch(
    builderNodeId: string,
    platform: 'linux/amd64' | 'linux/arm64',
    settings = readBuilderNodeSettings(undefined)
  ): Promise<boolean> {
    const leaseOwner = `gateway:${process.pid}:${randomUUID()}`;
    const build = await this.builds.claimNext({ builderNodeId, leaseOwner, platform });
    if (!build) return false;
    let dispatchAccepted = false;
    let dispatchResultReceived = false;
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
        return false;
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
      const command = await this.dispatch.dispatchDockerBuildCommand(builderNodeId, {
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
        timeoutSeconds: Math.min(
          policyLimit(policy, 'timeoutSeconds', settings.timeoutMinutes * 60),
          settings.timeoutMinutes * 60
        ),
        workerParallelism: settings.parallelism,
        outputKind: source.targetKind === 'pages_project' ? 'pages_archive' : 'oci_image',
        applicationRoot: build.applicationRoot,
        packageManager: build.packageManager ?? '',
        packageManagerVersion: build.packageManagerVersion ?? '',
        nodeVersion: build.nodeVersion ?? '',
        buildScript: build.buildScript ?? '',
        artifactDirectory: build.artifactDirectory ?? '',
      });
      void command.result.catch(() => {});
      await command.accepted;
      dispatchAccepted = true;
      const result = await command.result;
      dispatchResultReceived = true;
      if (!result.success) throw new Error(result.error || 'Builder daemon rejected the build');
      return true;
    } catch (error) {
      const errorMessage = (error as Error).message.slice(0, 4096);
      if (dispatchResultReceived && errorMessage === 'builder is at its isolated job capacity') {
        await this.builds.returnClaimToQueue(build.id, leaseOwner, 'Build Worker capacity changed before dispatch');
        return false;
      }
      if (dispatchResultReceived && errorMessage === 'build is already running') {
        logger.info('Build Worker confirmed that the claimed build is already running', {
          buildId: build.id,
          builderNodeId,
        });
        return true;
      }
      if (dispatchAccepted && !dispatchResultReceived) {
        logger.warn('Build dispatch result is ambiguous after the worker accepted the command; preserving the lease', {
          buildId: build.id,
          builderNodeId,
          error: errorMessage,
        });
        return true;
      }
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
      return false;
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
