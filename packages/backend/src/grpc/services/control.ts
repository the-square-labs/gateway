import type { ServerDuplexStream } from '@grpc/grpc-js';
import { and, eq, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import { nodes, relayInstances } from '@/db/schema/index.js';
import type { NodeGpuDevice } from '@/db/schema/nodes.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { isMinorCompatible } from '@/lib/semver.js';
import { DockerRuntimeStatusSchema } from '@/modules/docker/docker.schemas.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import { daemonLogRelay } from '@/modules/monitoring/log-relay.service.js';
import { validateRegisteredDaemonProfile } from '@/modules/nodes/node-daemon-profile.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import type { DaemonMessage, GatewayCommand } from '../generated/types.js';
import { extractDaemonCertificateIdentity, normalizeCertificateSerial } from '../interceptors/auth.js';
import type { GrpcServerDeps } from '../server.js';

const logger = createChildLogger('GrpcControl');
const pendingCommandRegistrations = new Map<string, { token: symbol; sequence: number }>();
let commandRegistrationSequence = 0;

function clearPendingCommandRegistration(nodeId: string, token: symbol): void {
  if (pendingCommandRegistrations.get(nodeId)?.token === token) {
    pendingCommandRegistrations.delete(nodeId);
  }
}

// Throttle health history writes — track last recorded timestamp per node
const lastRecordedTs = new Map<string, number>();
const HEALTH_HISTORY_MIN_INTERVAL_MS = 30_000; // one entry per 30s

async function markRelayInstanceOffline(deps: GrpcServerDeps, nodeId: string): Promise<void> {
  if (deps.registry.getNode(nodeId)) return;
  const [node] = await deps.db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (node?.type !== 'relay' || deps.registry.getNode(nodeId)) return;
  await deps.db
    .update(relayInstances)
    .set({ state: 'offline', updatedAt: new Date() })
    .where(eq(relayInstances.nodeId, nodeId));
}

export function mapDockerRuntimeStatus(raw: DaemonMessage['dockerRuntimeStatus']) {
  if (!raw) return undefined;
  const checkedAtMs = Number(raw.checkedAtUnixMs);
  const result = DockerRuntimeStatusSchema.safeParse({
    state: raw.state,
    installedVersion: raw.installedVersion || undefined,
    targetVersion: raw.targetVersion || undefined,
    reasonCode: raw.reasonCode || undefined,
    message: raw.message || undefined,
    checkedAt: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : undefined,
    remoteInstallable: Boolean(raw.remoteInstallable),
    localInstallCommand: raw.localInstallCommand || undefined,
    step: raw.step || undefined,
    progressPercent: raw.step === 'downloading' ? Number(raw.progressPercent) : undefined,
  });
  return result.success ? result.data : undefined;
}

interface DockerContainerStateSnapshot {
  containerId: string;
  name?: string;
  state?: string;
}

export interface DockerContainerStateDiff {
  containerId: string;
  name?: string;
  state: string;
}

function containerStateDiff(containerId: string, state: string, name?: string): DockerContainerStateDiff {
  return name ? { containerId, name, state } : { containerId, state };
}

function hasDockerMetricSample(container: any) {
  const state = String(container.state ?? container.State ?? '').toLowerCase();
  if (state !== 'running') return false;
  return [
    container.memoryUsageBytes ?? container.memory_usage_bytes,
    container.memoryLimitBytes ?? container.memory_limit_bytes,
    container.networkRxBytes ?? container.network_rx_bytes,
    container.networkTxBytes ?? container.network_tx_bytes,
    container.blockReadBytes ?? container.block_read_bytes,
    container.blockWriteBytes ?? container.block_write_bytes,
    container.pids,
  ].some((value) => Number(value ?? 0) > 0);
}

function numberIfReported(device: any, availableMetrics: Set<string>, metric: string, ...fields: string[]) {
  if (!availableMetrics.has(metric)) return undefined;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function booleanIfReported(device: any, availableMetrics: Set<string>, metric: string, ...fields: string[]) {
  if (!availableMetrics.has(metric)) return undefined;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  return typeof raw === 'boolean' ? raw : undefined;
}

function stringIfReported(device: any, availableMetrics: Set<string>, metric: string, ...fields: string[]) {
  if (!availableMetrics.has(metric)) return undefined;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * gRPC proto3 scalars default to zero when omitted. GPU metrics are therefore
 * only persisted when their name is explicitly listed in availableMetrics.
 */
export function mapGpuHealthDevices(rawDevices: unknown): NodeGpuDevice[] {
  if (!Array.isArray(rawDevices)) return [];

  return rawDevices.flatMap((rawDevice) => {
    if (!rawDevice || typeof rawDevice !== 'object') return [];
    const device = rawDevice as Record<string, unknown>;
    const id = stringValue(device.id ?? device.Id);
    if (!id) return [];

    const rawAvailableMetrics: unknown[] = Array.isArray(device.availableMetrics)
      ? device.availableMetrics
      : Array.isArray(device.available_metrics)
        ? device.available_metrics
        : [];
    const availableMetrics = new Set<string>(
      rawAvailableMetrics
        .filter((metric): metric is string => typeof metric === 'string' && metric.trim().length > 0)
        .map((metric) => metric.trim())
    );
    const utilizationPercent = numberIfReported(
      device,
      availableMetrics,
      'utilization_percent',
      'utilizationPercent',
      'utilization_percent'
    );
    const memoryTotalBytes = numberIfReported(
      device,
      availableMetrics,
      'memory_total_bytes',
      'memoryTotalBytes',
      'memory_total_bytes'
    );
    const memoryUsedBytes = numberIfReported(
      device,
      availableMetrics,
      'memory_used_bytes',
      'memoryUsedBytes',
      'memory_used_bytes'
    );
    const temperatureCelsius = numberIfReported(
      device,
      availableMetrics,
      'temperature_celsius',
      'temperatureCelsius',
      'temperature_celsius'
    );
    const powerWatts = numberIfReported(device, availableMetrics, 'power_watts', 'powerWatts', 'power_watts');
    const powerLimitWatts = numberIfReported(
      device,
      availableMetrics,
      'power_limit_watts',
      'powerLimitWatts',
      'power_limit_watts'
    );
    const throttled = booleanIfReported(device, availableMetrics, 'throttled', 'throttled');
    const eccCorrectedErrors = numberIfReported(
      device,
      availableMetrics,
      'ecc_corrected_errors',
      'eccCorrectedErrors',
      'ecc_corrected_errors'
    );
    const eccUncorrectedErrors = numberIfReported(
      device,
      availableMetrics,
      'ecc_uncorrected_errors',
      'eccUncorrectedErrors',
      'ecc_uncorrected_errors'
    );
    const health = stringIfReported(device, availableMetrics, 'health', 'health');

    const validatedMetrics = [
      utilizationPercent !== undefined && 'utilization_percent',
      memoryTotalBytes !== undefined && 'memory_total_bytes',
      memoryUsedBytes !== undefined && 'memory_used_bytes',
      temperatureCelsius !== undefined && 'temperature_celsius',
      powerWatts !== undefined && 'power_watts',
      powerLimitWatts !== undefined && 'power_limit_watts',
      throttled !== undefined && 'throttled',
      eccCorrectedErrors !== undefined && 'ecc_corrected_errors',
      eccUncorrectedErrors !== undefined && 'ecc_uncorrected_errors',
      health !== undefined && 'health',
    ].filter((metric): metric is string => typeof metric === 'string');

    return [
      {
        id,
        vendor: stringValue(device.vendor ?? device.Vendor),
        model: stringValue(device.model ?? device.Model),
        pciAddress: stringValue(device.pciAddress ?? device.pci_address ?? device.PciAddress),
        renderNode: stringValue(device.renderNode ?? device.render_node ?? device.RenderNode),
        deviceIndex: Number(device.deviceIndex ?? device.device_index ?? device.DeviceIndex ?? 0),
        attachable: Boolean(device.attachable ?? device.Attachable),
        unavailableReason: stringValue(
          device.unavailableReason ?? device.unavailable_reason ?? device.UnavailableReason
        ),
        partitioned: Boolean(device.partitioned ?? device.Partitioned),
        availableMetrics: validatedMetrics,
        ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
        ...(memoryTotalBytes !== undefined ? { memoryTotalBytes } : {}),
        ...(memoryUsedBytes !== undefined ? { memoryUsedBytes } : {}),
        ...(temperatureCelsius !== undefined ? { temperatureCelsius } : {}),
        ...(powerWatts !== undefined ? { powerWatts } : {}),
        ...(powerLimitWatts !== undefined ? { powerLimitWatts } : {}),
        ...(throttled !== undefined ? { throttled } : {}),
        ...(eccCorrectedErrors !== undefined ? { eccCorrectedErrors } : {}),
        ...(eccUncorrectedErrors !== undefined ? { eccUncorrectedErrors } : {}),
        ...(health !== undefined ? { health } : {}),
      },
    ];
  });
}

export function diffDockerContainerStateReports(
  previousContainerStats: DockerContainerStateSnapshot[],
  nextContainerStats: DockerContainerStateSnapshot[]
): DockerContainerStateDiff[] {
  const previousById = new Map<string, DockerContainerStateSnapshot>(
    previousContainerStats
      .filter((container) => container.containerId)
      .map((container) => [String(container.containerId), container])
  );
  const nextById = new Map<string, DockerContainerStateSnapshot>(
    nextContainerStats
      .filter((container) => container.containerId)
      .map((container) => [String(container.containerId), container])
  );
  const nextNames = new Set(nextContainerStats.map((container) => container.name).filter(Boolean));
  const changes: DockerContainerStateDiff[] = [];

  for (const [containerId, nextContainer] of nextById) {
    const previousContainer = previousById.get(containerId);
    if (!previousContainer || previousContainer.state !== nextContainer.state) {
      changes.push(containerStateDiff(containerId, nextContainer.state ?? 'unknown', nextContainer.name));
    }
  }

  for (const [containerId, previousContainer] of previousById) {
    if (nextById.has(containerId)) continue;
    if (previousContainer.name && nextNames.has(previousContainer.name)) continue;
    changes.push(containerStateDiff(containerId, 'exited', previousContainer.name));
  }

  return changes;
}

export function createControlHandlers(deps: GrpcServerDeps) {
  return {
    CommandStream(stream: ServerDuplexStream<DaemonMessage, GatewayCommand>) {
      let nodeId: string | null = null;
      let closed = false;
      let registering = false;
      let pendingDaemonUpdateCommitTarget: string | null = null;
      let daemonUpdateCommitInFlight = false;
      const pendingDaemonLogs: Array<NonNullable<DaemonMessage['daemonLog']>> = [];
      const isCurrentCommandStream = () =>
        !!nodeId && !closed && deps.registry.getNode(nodeId)?.commandStream === stream;
      const endStaleStream = async () => {
        closed = true;
        if (nodeId && deps.registry.getNode(nodeId)?.commandStream === stream) {
          await deps.registry.deregister(nodeId, stream as any);
          await markRelayInstanceOffline(deps, nodeId);
        }
        stream.end();
      };
      const failRegisteredStream = async (reason: string, err?: unknown) => {
        closed = true;
        logger.error(reason, {
          nodeId,
          error: err instanceof Error ? err.message : err ? String(err) : undefined,
        });
        if (nodeId) {
          await deps.registry.deregister(nodeId, stream as any);
          await markRelayInstanceOffline(deps, nodeId);
        }
        stream.end();
        (stream as any).destroy?.();
      };
      const isClaimedStreamCurrent = (claimedNodeId: string) =>
        !closed && deps.registry.getNode(claimedNodeId)?.commandStream === stream;
      const relayDaemonLog = (activeNodeId: string, daemonLog: NonNullable<DaemonMessage['daemonLog']>) => {
        daemonLogRelay.emit('log', {
          nodeId: activeNodeId,
          timestamp: daemonLog.timestamp || new Date().toISOString(),
          level: daemonLog.level,
          message: daemonLog.message,
          component: daemonLog.component,
          fields: daemonLog.fields || {},
        });
        logger.debug('Daemon log', {
          nodeId: activeNodeId,
          level: daemonLog.level,
          component: daemonLog.component,
          message: daemonLog.message,
        });
      };

      stream.on('data', async (msg: DaemonMessage) => {
        try {
          if (closed) return;
          // A daemon can log from an auxiliary stream while its registration
          // is still awaiting database/certificate validation. Keep those
          // operational logs until the command stream has an identity. The
          // Relay supervisor also publishes an immediate runtime snapshot from
          // OnSessionStart; ignore that replaceable snapshot until registration
          // commits instead of racing it against the async identity lookup.
          if (registering && msg.daemonLog) {
            pendingDaemonLogs.push(msg.daemonLog);
            return;
          }
          if (registering && msg.relayRuntimeStatus) return;
          if (msg.register) {
            // First message must be RegisterMessage
            if (nodeId || registering) {
              logger.warn('Duplicate node registration message ignored', { nodeId: nodeId ?? msg.register.nodeId });
              await endStaleStream();
              return;
            }
            registering = true;
            const claimedNodeId = msg.register.nodeId;
            const registrationToken = Symbol(claimedNodeId);
            const registrationSequence = ++commandRegistrationSequence;

            // Verify mTLS cert CN and serial match the enrolled node (prevents node impersonation).
            const certIdentity = extractDaemonCertificateIdentity(stream as any);
            if (!certIdentity) {
              logger.error('Node registration rejected: missing or unauthorized mTLS client certificate', {
                claimedNodeId,
              });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (certIdentity.nodeId !== claimedNodeId) {
              logger.error('Node ID mismatch: cert CN does not match claimed nodeId', {
                certNodeId: certIdentity.nodeId,
                claimedNodeId,
              });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }

            // A stream without an authenticated certificate cannot affect the
            // per-node registration race. Once certificate identity matches,
            // preserve arrival order while the enrolled serial is loaded.
            pendingCommandRegistrations.set(claimedNodeId, {
              token: registrationToken,
              sequence: registrationSequence,
            });

            logger.info('Node registering', {
              nodeId: claimedNodeId,
              hostname: msg.register.hostname,
              nginxVersion: msg.register.nginxVersion,
              configVersionHash: msg.register.configVersionHash,
              certVerified: true,
            });

            // Look up node from DB — read stored hash BEFORE updating
            const [node] = await deps.db
              .select({
                type: nodes.type,
                configVersionHash: nodes.configVersionHash,
                certificateSerial: nodes.certificateSerial,
                certificateFingerprint: nodes.certificateFingerprint,
                hostIdentityId: nodes.hostIdentityId,
                status: nodes.status,
              })
              .from(nodes)
              .where(eq(nodes.id, claimedNodeId))
              .limit(1);

            if (!node) {
              logger.error('Unknown node ID during registration', { nodeId: claimedNodeId });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }

            if (node.status === 'pending') {
              logger.error('Node registration rejected: enrollment is not complete', { nodeId: claimedNodeId });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (!node.certificateSerial) {
              logger.error('Node registration rejected: node has no stored certificate serial', {
                nodeId: claimedNodeId,
              });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            const storedSerial = normalizeCertificateSerial(node.certificateSerial);
            if (storedSerial !== certIdentity.serialNumber) {
              logger.error('Node registration rejected: certificate serial does not match enrolled node', {
                nodeId: claimedNodeId,
                presentedSerial: certIdentity.serialNumber,
                storedSerial,
              });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (
              certIdentity.certificateFingerprint &&
              node.certificateFingerprint !== certIdentity.certificateFingerprint
            ) {
              logger.error('Node registration rejected: certificate fingerprint does not match enrolled node', {
                nodeId: claimedNodeId,
              });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }

            // Only an authenticated, enrolled daemon may supersede an in-flight
            // registration for the same node. Preserve arrival order even when
            // certificate/DB validation finishes out of order.
            const currentRegistration = pendingCommandRegistrations.get(claimedNodeId);
            if (
              closed ||
              currentRegistration?.token !== registrationToken ||
              currentRegistration.sequence !== registrationSequence
            ) {
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            const nodeType = node.type as
              | 'nginx'
              | 'bastion'
              | 'monitoring'
              | 'docker'
              | 'builder'
              | 'databases'
              | 'relay';
            const profileError = validateRegisteredDaemonProfile(
              nodeType,
              msg.register.daemonType,
              msg.register.capabilities
            );
            if (profileError) {
              logger.error('Node registration profile mismatch', { nodeId: claimedNodeId, error: profileError });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (nodeType === 'relay') {
              const [relayInstance] = await deps.db
                .select({ id: relayInstances.id, faultDomainId: relayInstances.faultDomainId })
                .from(relayInstances)
                .where(eq(relayInstances.nodeId, claimedNodeId))
                .limit(1);
              if (
                !relayInstance ||
                msg.register.daemonType !== 'relay' ||
                !msg.register.capabilities?.includes('relay_pool_v1') ||
                msg.register.relayInstanceId !== relayInstance.id ||
                !node.hostIdentityId ||
                msg.register.hostIdentityId !== node.hostIdentityId ||
                relayInstance.faultDomainId !== node.hostIdentityId
              ) {
                logger.error('Relay registration identity or capability mismatch', { nodeId: claimedNodeId });
                registering = false;
                clearPendingCommandRegistration(claimedNodeId, registrationToken);
                stream.end();
                return;
              }
            }
            const gatewayHash = node.configVersionHash;

            try {
              await deps.registry.register(
                claimedNodeId,
                nodeType,
                msg.register.hostname,
                msg.register.configVersionHash,
                stream as any,
                {
                  isCurrentRegistration: () =>
                    pendingCommandRegistrations.get(claimedNodeId)?.token === registrationToken,
                  capabilities: msg.register.capabilities ?? [],
                }
              );
            } catch (err) {
              const reason = (err as Error).message;
              logger.error('Registration rejected', { nodeId: claimedNodeId, error: reason });
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (closed) {
              await deps.registry.deregister(claimedNodeId, stream as any);
              registering = false;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              return;
            }
            nodeId = claimedNodeId;
            registering = false;
            clearPendingCommandRegistration(claimedNodeId, registrationToken);
            for (const daemonLog of pendingDaemonLogs.splice(0)) relayDaemonLog(claimedNodeId, daemonLog);

            // Update DB with latest info — do NOT overwrite configVersionHash
            // (the gateway's stored hash is authoritative, set by FullSync)
            const { getEnv } = await import('@/config/env.js');
            const appVersion = getEnv().APP_VERSION;
            const versionMismatch =
              appVersion !== 'dev' &&
              msg.register.daemonVersion !== 'dev' &&
              !isMinorCompatible(appVersion, msg.register.daemonVersion);
            if (versionMismatch) {
              logger.warn('Daemon version mismatch', {
                nodeId: claimedNodeId,
                gatewayVersion: appVersion,
                daemonVersion: msg.register.daemonVersion,
              });
            }
            const reportedDockerVersion =
              msg.register.daemonType === 'docker'
                ? (((msg.register as any).dockerVersion as string | undefined) ?? msg.register.nginxVersion)
                : ((msg.register as any).dockerVersion as string | undefined);
            const reportedNginxVersion = msg.register.daemonType === 'docker' ? undefined : msg.register.nginxVersion;
            const reportedRuntimeStatus = mapDockerRuntimeStatus(msg.register.dockerRuntimeStatus);

            try {
              await deps.db
                .update(nodes)
                .set({
                  hostname: msg.register.hostname,
                  daemonVersion: msg.register.daemonVersion,
                  capabilities: {
                    ...(reportedNginxVersion ? { nginxVersion: reportedNginxVersion } : {}),
                    ...(msg.register.daemonType ? { daemonType: msg.register.daemonType } : {}),
                    ...(reportedDockerVersion ? { dockerVersion: reportedDockerVersion } : {}),
                    ...(msg.register.capabilities?.length ? { capabilities: msg.register.capabilities } : {}),
                    ...(msg.register.capabilities?.includes('docker_deployments_v1')
                      ? { dockerDeploymentsV1: true }
                      : {}),
                    ...(msg.register.capabilities?.includes('docker_compose_v1') ? { dockerComposeV1: true } : {}),
                    ...(msg.register.capabilities?.includes('docker_gpu_v1') ? { dockerGpuV1: true } : {}),
                    ...(msg.register.capabilities?.includes('docker_migration_v1') ? { dockerMigrationV1: true } : {}),
                    ...(reportedRuntimeStatus ? { dockerRuntimeStatus: reportedRuntimeStatus } : {}),
                    cpuModel: msg.register.cpuModel || undefined,
                    cpuCores: msg.register.cpuCores || undefined,
                    architecture: msg.register.architecture || undefined,
                    kernelVersion: msg.register.kernelVersion || undefined,
                    versionMismatch,
                  },
                  lastSeenAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(nodes.id, claimedNodeId));
            } catch (err) {
              await failRegisteredStream('Node registration metadata update failed', err);
              return;
            }
            // Reconciliation consumers must observe the capabilities committed
            // above. Publishing from registry.register() raced this metadata
            // update and could leave legacy Docker links unmigrated after an
            // in-place daemon upgrade.
            deps.registry.publishNodeChanged(claimedNodeId, 'online', msg.register.hostname);

            try {
              const { DaemonUpdateService } = await import('@/services/daemon-update.service.js');
              const daemonUpdateService = container.resolve(DaemonUpdateService);
              const reconciliation = await daemonUpdateService.reconcileNodeUpdateRegistration(
                claimedNodeId,
                msg.register.daemonVersion,
                msg.register.capabilities?.includes('daemon_update_rollback_v1') ?? false,
                msg.register.daemonUpdateOutcome
              );
              pendingDaemonUpdateCommitTarget = reconciliation.commitTarget ?? null;
              if (reconciliation.acknowledgeRollbackTarget) {
                const rollbackTarget = reconciliation.acknowledgeRollbackTarget;
                setImmediate(async () => {
                  try {
                    const result = await deps.registry.sendCommand(
                      claimedNodeId,
                      { finalizeDaemonUpdate: { targetVersion: rollbackTarget, acknowledgeRollback: true } },
                      30_000
                    );
                    if (!result.success) {
                      throw new Error(result.error || result.detail || 'Daemon rejected rollback acknowledgement');
                    }
                  } catch (error) {
                    logger.warn('Failed to acknowledge daemon rollback outcome', {
                      nodeId: claimedNodeId,
                      targetVersion: rollbackTarget,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  }
                });
              }
            } catch (err) {
              logger.warn('Failed to reconcile node update lock on register', {
                nodeId: claimedNodeId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            if (!isClaimedStreamCurrent(claimedNodeId)) return;

            logger.info('Node connected', {
              nodeId: claimedNodeId,
              hostname: msg.register.hostname,
              daemonVersion: msg.register.daemonVersion,
              nginxVersion: msg.register.nginxVersion,
            });

            // Enable daemon log streaming on connect (fire-and-forget via stream)
            try {
              if (!isClaimedStreamCurrent(claimedNodeId)) return;
              stream.write({ commandId: '', setDaemonLogStream: { enabled: true, minLevel: 'info', tailLines: 0 } });
            } catch {
              // stream may not be ready yet
            }

            if (deps.relayPolicy && msg.register.capabilities?.includes('generic_relay_tunnel_v1')) {
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  await deps.relayPolicy!.syncNodeGrants(claimedNodeId);
                } catch (error) {
                  logger.warn('Failed to sync relay grants after daemon reconnect', {
                    nodeId: claimedNodeId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            }
            if (deps.relayPolicy && nodeType === 'relay') {
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  await deps.relayPolicy!.syncRemoteInstancePolicy(claimedNodeId);
                } catch (error) {
                  logger.warn('Failed to synchronize remote relay policy after reconnect', {
                    nodeId: claimedNodeId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            }

            // A v2 Nginx daemon reconciles on every reconnect; an older daemon
            // retains the established hash-mismatch-only resync path.
            const supportsTlsDistribution =
              msg.register.capabilities?.includes('nginx_certificate_distribution_v2') ?? false;
            const configHashMismatch = !!gatewayHash && gatewayHash !== msg.register.configVersionHash;
            if (nodeType === 'nginx' && (supportsTlsDistribution || configHashMismatch)) {
              logger.info(
                supportsTlsDistribution
                  ? 'TLS distribution reconnect reconciliation'
                  : 'Config hash mismatch, triggering full resync',
                {
                  nodeId: claimedNodeId,
                  daemonHash: msg.register.configVersionHash,
                  gatewayHash,
                }
              );
              // Async reconciliation — never block node registration.
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  const proxyService = container.resolve(ProxyService);
                  await proxyService.resyncAllHostsOnNode(claimedNodeId);
                  if (supportsTlsDistribution) {
                    await container.resolve(NginxCertificateDistributionService).reconcileIntegrity(claimedNodeId);
                  }
                } catch (err) {
                  logger.error('Full resync failed', { nodeId: claimedNodeId, error: (err as Error).message });
                }
              });
            }
          } else {
            const activeNodeId = nodeId;
            if (!activeNodeId || deps.registry.getNode(activeNodeId)?.commandStream !== stream) {
              await endStaleStream();
              return;
            }
            if (msg.relayRuntimeStatus) {
              const runtime = msg.relayRuntimeStatus;
              const [instance] = await deps.db
                .select({ id: relayInstances.id })
                .from(relayInstances)
                .where(eq(relayInstances.nodeId, activeNodeId))
                .limit(1);
              if (!instance || runtime.relayInstanceId !== instance.id) {
                await failRegisteredStream('Relay runtime status identity mismatch');
                return;
              }
              const nextState = ['joining', 'synchronizing', 'ready', 'draining', 'offline', 'error'].includes(
                runtime.state
              )
                ? (runtime.state as 'joining' | 'synchronizing' | 'ready' | 'draining' | 'offline' | 'error')
                : 'error';
              await deps.db
                .update(relayInstances)
                .set({
                  state: nextState,
                  buildVersion: runtime.buildVersion || null,
                  protocolMajor: runtime.protocolMajor || null,
                  capabilities: {
                    protocolMajor: runtime.protocolMajor || 0,
                    features: runtime.capabilities ?? [],
                  },
                  appliedPolicyRevision: Number(runtime.appliedPolicyRevision || 0),
                  policyExpiresAt: Number(runtime.policyExpiresAtUnix || 0)
                    ? new Date(Number(runtime.policyExpiresAtUnix) * 1000)
                    : null,
                  lastSeenAt: new Date(),
                  health: {
                    activeTunnels: Number(runtime.activeTunnels || 0),
                    registeredEndpoints: Number(runtime.registeredEndpoints || 0),
                    pressurePercent: runtime.pressurePercent || 0,
                    admissionState: runtime.draining ? 'draining' : nextState,
                    policySigningKeyIds: runtime.policySigningKeyIds ?? [],
                    assignmentTunnels: (runtime.assignmentTunnels ?? []).map((count) => ({
                      endpointId: count.endpointId,
                      assignmentGeneration: Number(count.assignmentGeneration),
                      activeTunnels: Number(count.activeTunnels),
                    })),
                  },
                  updatedAt: new Date(),
                })
                .where(eq(relayInstances.id, instance.id));
              deps.registry.publishNodeChanged(activeNodeId, 'online');
            } else if (msg.dockerBuildEvent) {
              try {
                await container.resolve(DockerBuildService).handleDaemonEvent(activeNodeId, msg.dockerBuildEvent);
              } catch (error) {
                logger.warn('Rejected Docker builder event', {
                  nodeId: activeNodeId,
                  buildId: msg.dockerBuildEvent.buildId,
                  status: msg.dockerBuildEvent.status,
                  error: (error as Error).message,
                });
              }
            } else if (msg.dockerRuntimeStatus) {
              const runtimeStatus = mapDockerRuntimeStatus(msg.dockerRuntimeStatus);
              if (!runtimeStatus) {
                logger.warn('Ignored invalid Docker runtime status update', { nodeId: activeNodeId });
                return;
              }
              const [updatedNode] = await deps.db
                .update(nodes)
                .set({
                  capabilities: sql`jsonb_set(
                    coalesce(${nodes.capabilities}, '{}'::jsonb),
                    '{dockerRuntimeStatus}',
                    ${JSON.stringify(runtimeStatus)}::jsonb,
                    true
                  )`,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(nodes.id, activeNodeId),
                    sql`coalesce(${nodes.capabilities}->'dockerRuntimeStatus'->>'checkedAt', '') <= ${runtimeStatus.checkedAt}`
                  )
                )
                .returning({ hostname: nodes.hostname, status: nodes.status });
              if (!isCurrentCommandStream()) return;
              if (updatedNode) {
                deps.registry.publishDockerRuntimeChanged(activeNodeId, runtimeStatus);
              }
            } else if (msg.commandResult) {
              // Intercept traffic stats results (fire-and-forget, not correlated)
              if (
                msg.commandResult.commandId?.startsWith('traffic-') &&
                msg.commandResult.success &&
                msg.commandResult.detail
              ) {
                try {
                  const node = deps.registry.getNode(activeNodeId);
                  if (node) node.lastTrafficStats = JSON.parse(msg.commandResult.detail);
                } catch {
                  /* ignore parse errors */
                }
              } else if (
                msg.commandResult.commandId?.startsWith('log_stream:') &&
                msg.commandResult.success &&
                msg.commandResult.detail
              ) {
                // Route log stream chunks to registered WebSocket handlers
                try {
                  const parsed = JSON.parse(msg.commandResult.detail);
                  if (parsed.type === 'log_stream' && parsed.containerId) {
                    const key = `${activeNodeId}:${parsed.containerId}`;
                    deps.registry.handleLogStream(key, parsed.lines ?? [], !!parsed.ended);
                  }
                } catch {
                  /* ignore parse errors */
                }
              } else {
                deps.registry.handleCommandResult(activeNodeId, msg.commandResult);
              }
            } else if (msg.healthReport) {
              const healthData = {
                nginxRunning: msg.healthReport.nginxRunning,
                configValid: msg.healthReport.configValid,
                nginxUptimeSeconds: Number(msg.healthReport.nginxUptimeSeconds),
                workerCount: msg.healthReport.workerCount,
                nginxVersion: msg.healthReport.nginxVersion,
                cpuPercent: msg.healthReport.cpuPercent,
                memoryBytes: Number(msg.healthReport.memoryBytes),
                diskFreeBytes: Number(msg.healthReport.diskFreeBytes),
                timestamp: Number(msg.healthReport.timestamp),
                loadAverage1m: (msg.healthReport as any).loadAverage_1m ?? msg.healthReport.loadAverage1m ?? 0,
                loadAverage5m: (msg.healthReport as any).loadAverage_5m ?? msg.healthReport.loadAverage5m ?? 0,
                loadAverage15m: (msg.healthReport as any).loadAverage_15m ?? msg.healthReport.loadAverage15m ?? 0,
                systemMemoryTotalBytes: Number(msg.healthReport.systemMemoryTotalBytes ?? 0),
                systemMemoryUsedBytes: Number(msg.healthReport.systemMemoryUsedBytes ?? 0),
                systemMemoryAvailableBytes: Number(msg.healthReport.systemMemoryAvailableBytes ?? 0),
                swapTotalBytes: Number(msg.healthReport.swapTotalBytes ?? 0),
                swapUsedBytes: Number(msg.healthReport.swapUsedBytes ?? 0),
                systemUptimeSeconds: Number(msg.healthReport.systemUptimeSeconds ?? 0),
                openFileDescriptors: Number(msg.healthReport.openFileDescriptors ?? 0),
                maxFileDescriptors: Number(msg.healthReport.maxFileDescriptors ?? 0),
                diskMounts: (msg.healthReport.diskMounts ?? []).map((m: any) => ({
                  mountPoint: m.mountPoint,
                  filesystem: m.filesystem,
                  device: m.device,
                  totalBytes: Number(m.totalBytes ?? 0),
                  usedBytes: Number(m.usedBytes ?? 0),
                  freeBytes: Number(m.freeBytes ?? 0),
                  usagePercent: m.usagePercent ?? 0,
                })),
                diskReadBytes: Number(msg.healthReport.diskReadBytes ?? 0),
                diskWriteBytes: Number(msg.healthReport.diskWriteBytes ?? 0),
                networkInterfaces: (msg.healthReport.networkInterfaces ?? []).map((n: any) => ({
                  name: n.name,
                  rxBytes: Number(n.rxBytes ?? 0),
                  txBytes: Number(n.txBytes ?? 0),
                  rxPackets: Number(n.rxPackets ?? 0),
                  txPackets: Number(n.txPackets ?? 0),
                  rxErrors: Number(n.rxErrors ?? 0),
                  txErrors: Number(n.txErrors ?? 0),
                  ipAddresses: (n.ipAddresses ?? []).filter(
                    (address: unknown): address is string => typeof address === 'string' && address.length > 0
                  ),
                })),
                localIpAddresses: (msg.healthReport.localIpAddresses ?? []).filter(
                  (address: unknown): address is string => typeof address === 'string' && address.length > 0
                ),
                publicIpAddresses: (msg.healthReport.publicIpAddresses ?? []).filter(
                  (address: unknown): address is string => typeof address === 'string' && address.length > 0
                ),
                nginxRssBytes: Number(msg.healthReport.nginxRssBytes ?? 0),
                errorRate4xx: (msg.healthReport as any).errorRate_4xx ?? msg.healthReport.errorRate4xx ?? 0,
                errorRate5xx: (msg.healthReport as any).errorRate_5xx ?? msg.healthReport.errorRate5xx ?? 0,
                // Docker-specific fields
                ...(msg.healthReport.dockerVersion ? { dockerVersion: msg.healthReport.dockerVersion } : {}),
                ...(msg.healthReport.containersRunning != null
                  ? { containersRunning: msg.healthReport.containersRunning }
                  : {}),
                ...(msg.healthReport.containersStopped != null
                  ? { containersStopped: msg.healthReport.containersStopped }
                  : {}),
                ...(msg.healthReport.containersTotal != null
                  ? { containersTotal: msg.healthReport.containersTotal }
                  : {}),
                ...(msg.healthReport.containerStats?.length
                  ? {
                      containerStats: msg.healthReport.containerStats.map((c: any) => ({
                        containerId: c.containerId,
                        name: c.name,
                        image: c.image,
                        state: c.state,
                        cpuPercent: c.cpuPercent ?? 0,
                        memoryUsageBytes: Number(c.memoryUsageBytes ?? 0),
                        memoryLimitBytes: Number(c.memoryLimitBytes ?? 0),
                        networkRxBytes: Number(c.networkRxBytes ?? 0),
                        networkTxBytes: Number(c.networkTxBytes ?? 0),
                        blockReadBytes: Number(c.blockReadBytes ?? 0),
                        blockWriteBytes: Number(c.blockWriteBytes ?? 0),
                        pids: c.pids ?? 0,
                        metricsAvailable: hasDockerMetricSample(c),
                      })),
                    }
                  : {}),
                gpuDevices: mapGpuHealthDevices(msg.healthReport.gpuDevices),
              };

              const connectedNode = deps.registry.getNode(activeNodeId);
              const previousContainerStats = Array.isArray((connectedNode?.lastHealthReport as any)?.containerStats)
                ? (((connectedNode?.lastHealthReport as any)?.containerStats as any[]) ?? [])
                : [];
              const nextContainerStats = Array.isArray((healthData as any).containerStats)
                ? (((healthData as any).containerStats as any[]) ?? [])
                : [];

              if (connectedNode?.type === 'docker') {
                const nextContainerIds = new Set(
                  nextContainerStats.map((container: any) => String(container.containerId))
                );
                for (const change of diffDockerContainerStateReports(previousContainerStats, nextContainerStats)) {
                  deps.registry.publishDockerContainerChanged(
                    activeNodeId,
                    change.containerId,
                    change.name,
                    change.state,
                    {
                      observe: !nextContainerIds.has(change.containerId),
                    }
                  );
                }

                for (const container of nextContainerStats) {
                  if (!container.containerId) continue;
                  deps.registry.observeDockerContainerState(
                    activeNodeId,
                    container.containerId,
                    container.name,
                    container.state
                  );
                }
              }

              deps.registry.updateHealthReport(activeNodeId, healthData);

              // Evaluate notification alert rules (fire-and-forget, don't block health persistence)
              try {
                const evaluator = container.resolve(NotificationEvaluatorService);
                evaluator.evaluateHealthReport(activeNodeId, healthData).catch((err) => {
                  logger.error('Alert evaluation failed', { nodeId: activeNodeId, error: (err as Error).message });
                });
                evaluator
                  .observeStatefulEvent(
                    'node',
                    'online',
                    { type: 'node', id: activeNodeId, name: connectedNode?.hostname ?? activeNodeId },
                    { hostname: connectedNode?.hostname ?? activeNodeId }
                  )
                  .catch((err) => {
                    logger.error('Stateful event observation failed', {
                      nodeId: activeNodeId,
                      error: (err as Error).message,
                    });
                  });
              } catch (resolveErr) {
                logger.error('Evaluator resolve failed', { error: (resolveErr as Error).message });
              }

              // Persist health report and restore online status if node was marked offline (e.g. after missed reports)
              const [currentRow] = await deps.db
                .select({ status: nodes.status })
                .from(nodes)
                .where(eq(nodes.id, activeNodeId))
                .limit(1);
              if (!isCurrentCommandStream()) {
                await endStaleStream();
                return;
              }

              const updatePayload: Record<string, unknown> = {
                lastHealthReport: healthData,
                lastSeenAt: new Date(),
              };
              if (currentRow?.status === 'offline') {
                updatePayload.status = 'online';
                updatePayload.updatedAt = new Date();
                logger.info('Node resumed health reports, restored to online', { nodeId: activeNodeId });
              }

              await deps.db.update(nodes).set(updatePayload).where(eq(nodes.id, activeNodeId));
              if (!isCurrentCommandStream()) return;

              if (pendingDaemonUpdateCommitTarget && !daemonUpdateCommitInFlight) {
                const commitTarget = pendingDaemonUpdateCommitTarget;
                daemonUpdateCommitInFlight = true;
                setImmediate(async () => {
                  try {
                    const result = await deps.registry.sendCommand(
                      activeNodeId,
                      { finalizeDaemonUpdate: { targetVersion: commitTarget, acknowledgeRollback: false } },
                      30_000
                    );
                    if (!result.success) {
                      throw new Error(result.error || result.detail || 'Daemon rejected update commit');
                    }
                    const { DaemonUpdateService } = await import('@/services/daemon-update.service.js');
                    await container
                      .resolve(DaemonUpdateService)
                      .completeNodeUpdateAfterCommit(activeNodeId, commitTarget);
                    pendingDaemonUpdateCommitTarget = null;
                  } catch (error) {
                    logger.warn('Failed to commit verified daemon update', {
                      nodeId: activeNodeId,
                      targetVersion: commitTarget,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  } finally {
                    daemonUpdateCommitInFlight = false;
                  }
                });
              }

              // Publish status restoration event after DB write
              if (currentRow?.status === 'offline') {
                const connectedNode = deps.registry.getNode(activeNodeId);
                deps.registry.publishNodeChanged(activeNodeId, 'online', connectedNode?.hostname);
              }

              // Record health history entry (same format as proxy health checks)
              const nowMs = Date.now();
              const lastTs = lastRecordedTs.get(activeNodeId) ?? 0;
              if (nowMs - lastTs >= HEALTH_HISTORY_MIN_INTERVAL_MS) {
                const isHealthy =
                  connectedNode?.type === 'nginx' ? healthData.nginxRunning && healthData.configValid : true;
                const status = isHealthy ? 'online' : 'degraded';

                try {
                  const [histRow] = await deps.db
                    .select({ healthHistory: nodes.healthHistory })
                    .from(nodes)
                    .where(eq(nodes.id, activeNodeId))
                    .limit(1);
                  if (!isCurrentCommandStream()) return;

                  const history = compactHealthHistory(
                    [
                      ...((histRow?.healthHistory as Array<{ ts: string; status: string }>) ?? []),
                      { ts: new Date(nowMs).toISOString(), status },
                    ],
                    { nowMs }
                  );

                  await deps.db.update(nodes).set({ healthHistory: history }).where(eq(nodes.id, activeNodeId));
                  if (!isCurrentCommandStream()) return;
                  lastRecordedTs.set(activeNodeId, nowMs);
                } catch (err) {
                  logger.warn('Failed to update health history', {
                    nodeId: activeNodeId,
                    error: (err as Error).message,
                  });
                }
              }
            } else if (msg.statsReport) {
              deps.registry.updateStatsReport(activeNodeId, {
                activeConnections: Number(msg.statsReport.activeConnections),
                accepts: Number(msg.statsReport.accepts),
                handled: Number(msg.statsReport.handled),
                requests: Number(msg.statsReport.requests),
                reading: msg.statsReport.reading,
                writing: msg.statsReport.writing,
                waiting: msg.statsReport.waiting,
                timestamp: Number(msg.statsReport.timestamp),
              });

              await deps.db
                .update(nodes)
                .set({
                  lastStatsReport: {
                    activeConnections: Number(msg.statsReport.activeConnections),
                    accepts: Number(msg.statsReport.accepts),
                    handled: Number(msg.statsReport.handled),
                    requests: Number(msg.statsReport.requests),
                    reading: msg.statsReport.reading,
                    writing: msg.statsReport.writing,
                    waiting: msg.statsReport.waiting,
                    timestamp: Number(msg.statsReport.timestamp),
                  },
                  lastSeenAt: new Date(),
                })
                .where(eq(nodes.id, activeNodeId));
              if (!isCurrentCommandStream()) return;
            } else if (msg.daemonLog) {
              relayDaemonLog(activeNodeId, msg.daemonLog);
            } else if (msg.execOutput) {
              // Route exec output to registered WebSocket handler
              deps.registry.handleExecOutput(msg.execOutput.execId, msg.execOutput);
            }
          }
        } catch (err) {
          logger.error('Error processing daemon message', { nodeId, error: (err as Error).message });
        }
      });

      stream.on('end', async () => {
        closed = true;
        if (nodeId) {
          logger.info('Node stream ended', { nodeId });
          lastRecordedTs.delete(nodeId);
          await deps.registry.deregister(nodeId, stream as any);
          await markRelayInstanceOffline(deps, nodeId);
          await deps.auditService.log({
            userId: null,
            action: 'node.disconnected',
            resourceType: 'node',
            resourceId: nodeId,
            details: { reason: 'stream_ended' },
          });
        }
      });

      stream.on('error', async (err) => {
        closed = true;
        if (nodeId) {
          logger.warn('Node stream error', { nodeId, error: err.message });
          lastRecordedTs.delete(nodeId);
          await deps.registry.deregister(nodeId, stream as any);
          await markRelayInstanceOffline(deps, nodeId);
          await deps.auditService.log({
            userId: null,
            action: 'node.disconnected',
            resourceType: 'node',
            resourceId: nodeId,
            details: { reason: 'error', error: err.message },
          });
        }
      });
    },
  };
}
