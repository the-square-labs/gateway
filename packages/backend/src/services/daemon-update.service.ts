import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/nodes.js';
import { settings } from '@/db/schema/settings.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  type ReleaseArtifactSource,
  type ReleaseRecord,
  releaseArtifactSource,
  releaseNotes,
} from '@/lib/release-artifacts.js';
import { compareSemver, isNewerVersion, isReleaseCandidateVersion, parseSemver } from '@/lib/semver.js';
import { type TrustedDaemonUpdateArtifact, verifyDaemonUpdateManifest } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { GeneralSettingsService, UpdateChannel } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

const logger = createChildLogger('DaemonUpdateService');
const NODE_UPDATE_RECONNECT_TIMEOUT_MS = 2 * 60 * 1000;
const NODE_UPDATE_EXECUTION_TIMEOUT_MS = 6 * 60 * 1000;
/** A queued update of a lease member waits at most this long for its lease peers (rollout timeout + margin). */
const NODE_UPDATE_QUEUE_TIMEOUT_MS = 31 * 60 * 1000;
/** Update phase of a lease member whose update waits for other members of its availability policies. */
export const NODE_UPDATE_WAITING_PHASE = 'waiting_for_lease_peers';
const NODE_UPDATE_METADATA_KEYS = [
  'updateInProgress',
  'updateTargetVersion',
  'updateStartedAt',
  'updateOperationId',
  'updatePhase',
  'updateDeadlineAt',
  'updateReconnectStartedAt',
  'updateWaitingFor',
] as const;

export type DaemonType = 'nginx' | 'docker' | 'monitoring' | 'relay' | 'relay-worker';

const DAEMON_TYPES: DaemonType[] = ['nginx', 'docker', 'monitoring', 'relay'];

const TAG_SUFFIX_MAP: Record<DaemonType, string> = {
  nginx: '-nginx',
  docker: '-docker',
  monitoring: '-monitoring',
  relay: '-relay',
  'relay-worker': '-relay',
};

const DAEMON_PACKAGE_MAP: Record<DaemonType, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  monitoring: 'monitoring-daemon',
  relay: 'relay-supervisor',
  'relay-worker': 'relay-supervisor',
};

const DAEMON_BINARY_MAP: Record<DaemonType, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  monitoring: 'monitoring-daemon',
  relay: 'relay-supervisor',
  'relay-worker': 'relay-worker',
};

/** Maps node.type values to daemon types */
export const NODE_TYPE_MAP: Record<string, DaemonType> = {
  nginx: 'nginx',
  docker: 'docker',
  // Builder nodes run the same docker-daemon binary in its builder-only profile.
  builder: 'docker',
  // Legacy database identities use the same unified Storage profile and binary.
  databases: 'docker',
  // Storage nodes use docker-daemon's restricted stateful profile.
  storage: 'docker',
  monitoring: 'monitoring',
  relay: 'relay',
};

export function daemonTypeForNodeType(nodeType: string): DaemonType | null {
  return NODE_TYPE_MAP[nodeType] ?? null;
}

export interface DaemonRelease {
  daemonType: DaemonType;
  tagName: string;
  version: string;
  releaseNotes: string | null;
  releaseUrl: string | null;
}

export interface DaemonNodeUpdateStatus {
  nodeId: string;
  hostname: string;
  currentVersion: string;
  updateAvailable: boolean;
  arch?: string;
}

export interface DaemonUpdateStatus {
  daemonType: DaemonType;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  nodes: DaemonNodeUpdateStatus[];
}

export class DaemonUpdateService {
  private readonly releasesUrl: string;
  private eventBus?: EventBusService;
  private nodeRegistry?: NodeRegistryService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly env: Env,
    private readonly generalSettings?: GeneralSettingsService
  ) {
    this.releasesUrl = this.env.RELEASES_API_URL;
  }

  private async fetchNextRelease(
    packageName: string,
    currentVersion: string,
    channel: UpdateChannel
  ): Promise<ReleaseRecord | null> {
    const url = new URL(this.releasesUrl);
    url.searchParams.set('component', packageName);
    url.searchParams.set('current', currentVersion);
    url.searchParams.set('channel', channel);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Release resolver returned ${response.status}`);
    const payload = (await response.json()) as { target?: ReleaseRecord };
    if (!payload.target) throw new Error('Release resolver returned no target');
    return payload.target;
  }

  private getArtifactSource(daemonType: DaemonType, tag: string, arch: string): ReleaseArtifactSource {
    const daemonName = DAEMON_PACKAGE_MAP[daemonType];
    return releaseArtifactSource(this.env.ARTIFACT_BASE_URL, daemonName, tag, this.getBinaryName(daemonType, arch));
  }

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  setNodeRegistry(nodeRegistry: NodeRegistryService) {
    this.nodeRegistry = nodeRegistry;
  }

  private emitNodeUpdated(nodeId: string) {
    this.eventBus?.publish('node.changed', { id: nodeId, action: 'updated' });
  }

  async checkForUpdates(): Promise<DaemonUpdateStatus[]> {
    const lastCheckedAt = new Date().toISOString();

    try {
      const allNodes = await this.db.select().from(nodes);
      const updateChannel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';

      // Resolve one staged target for the oldest compatible cohort of each type.
      for (const type of DAEMON_TYPES) {
        const suffix = TAG_SUFFIX_MAP[type];
        const currentVersion = allNodes
          .filter((node) => NODE_TYPE_MAP[node.type] === type)
          .map((node) => node.daemonVersion ?? '')
          .filter((version) => version !== 'dev' && version !== 'unknown' && parseSemver(version) !== null)
          .sort(compareSemver)[0];
        const release = currentVersion
          ? await this.fetchNextRelease(DAEMON_PACKAGE_MAP[type], currentVersion, updateChannel)
          : null;
        const latest = release ? { ...release, version: release.tag_name.replace(suffix, '') } : null;
        if (latest) {
          await this.upsertSetting(`daemon-update:${type}:latest_version`, latest.version);
          await this.upsertSetting(`daemon-update:${type}:latest_tag`, latest.tag_name);
          await this.upsertSetting(`daemon-update:${type}:release_notes`, releaseNotes(latest));
        } else {
          await this.deleteSettings([
            `daemon-update:${type}:latest_version`,
            `daemon-update:${type}:latest_tag`,
            `daemon-update:${type}:release_notes`,
          ]);
        }
        await this.upsertSetting(`daemon-update:${type}:last_checked_at`, lastCheckedAt);
      }
    } catch (error) {
      logger.warn('Daemon update check failed', { error });
    }

    return this.getCachedStatus();
  }

  async getCachedStatus(): Promise<DaemonUpdateStatus[]> {
    const result: DaemonUpdateStatus[] = [];
    const updateChannel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';

    // Fetch all nodes
    const allNodes = await this.db.select().from(nodes);

    for (const type of DAEMON_TYPES) {
      const cachedLatestVersion = await this.getSetting(`daemon-update:${type}:latest_version`);
      const latestVersion =
        updateChannel === 'stable' && cachedLatestVersion && isReleaseCandidateVersion(cachedLatestVersion)
          ? null
          : cachedLatestVersion;
      const lastCheckedAt = await this.getSetting(`daemon-update:${type}:last_checked_at`);

      const typeNodes = allNodes
        .filter((n) => NODE_TYPE_MAP[n.type] === type)
        .map((n) => {
          const currentVersion = n.daemonVersion ?? 'unknown';
          const updateAvailable =
            latestVersion != null && currentVersion !== 'unknown' && currentVersion !== 'dev'
              ? isNewerVersion(latestVersion, currentVersion)
              : false;
          const caps = (n.capabilities ?? {}) as Record<string, unknown>;
          return {
            nodeId: n.id,
            hostname: n.displayName ?? n.hostname,
            currentVersion,
            updateAvailable,
            arch: (caps.architecture as string) ?? undefined,
          };
        });

      result.push({ daemonType: type, latestVersion, lastCheckedAt, nodes: typeNodes });
    }

    return result;
  }

  async getLatestRelease(daemonType: DaemonType): Promise<DaemonRelease | null> {
    const version = await this.getSetting(`daemon-update:${daemonType}:latest_version`);
    const tag = await this.getSetting(`daemon-update:${daemonType}:latest_tag`);
    const notes = await this.getSetting(`daemon-update:${daemonType}:release_notes`);
    if (!version || !tag) return null;
    const updateChannel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';
    if (updateChannel === 'stable' && isReleaseCandidateVersion(version)) return null;
    return {
      daemonType,
      tagName: tag,
      version,
      releaseNotes: notes || null,
      releaseUrl: null,
    };
  }

  async isNodeUpdateInProgress(nodeId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    if (await this.expireNodeUpdateIfDue(nodeId, metadata)) {
      return false;
    }
    return metadata.updateInProgress === true;
  }

  async markNodeUpdateInProgress(
    nodeId: string,
    targetVersion: string,
    options: { waitForLeasePeers?: boolean } = {}
  ): Promise<string> {
    let [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');

    let metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress === true) {
      if (!(await this.expireNodeUpdateIfDue(nodeId, metadata))) {
        throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is already in progress');
      }
      [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
      if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
      metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    }

    const now = Date.now();
    const operationId = randomUUID();
    const deadlineMs = options.waitForLeasePeers ? NODE_UPDATE_QUEUE_TIMEOUT_MS : NODE_UPDATE_EXECUTION_TIMEOUT_MS;
    delete metadata.updateLastError;
    delete metadata.updateLastErrorAt;
    delete metadata.updateWaitingFor;
    metadata.updateInProgress = true;
    metadata.updateTargetVersion = targetVersion;
    metadata.updateStartedAt = new Date(now).toISOString();
    metadata.updateOperationId = operationId;
    metadata.updatePhase = options.waitForLeasePeers ? NODE_UPDATE_WAITING_PHASE : 'executing';
    metadata.updateDeadlineAt = new Date(now + deadlineMs).toISOString();

    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`COALESCE(${nodes.metadata}->>'updateInProgress', 'false') <> 'true'`))
      .returning({ id: nodes.id });
    if (updated.length === 0) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is already in progress');
    }

    // A queued update has not restarted anything yet; the node counts as updating once it is sent.
    if (!options.waitForLeasePeers) this.nodeRegistry?.setNodeUpdateInProgress(nodeId, true);
    this.emitNodeUpdated(nodeId);
    this.scheduleNodeUpdateExpiry(nodeId, operationId, deadlineMs);
    return operationId;
  }

  /**
   * Moves a queued update to execution once its lease peers settled. False when it is no longer the queued update of
   * the node (expired, cleared, or replaced).
   */
  async beginQueuedNodeUpdate(nodeId: string, operationId: string): Promise<boolean> {
    const metadata = await this.readQueuedUpdate(nodeId, operationId);
    if (!metadata) return false;
    const now = Date.now();
    delete metadata.updateWaitingFor;
    metadata.updatePhase = 'executing';
    metadata.updateDeadlineAt = new Date(now + NODE_UPDATE_EXECUTION_TIMEOUT_MS).toISOString();
    if (!(await this.writeUpdateMetadata(nodeId, operationId, metadata))) return false;
    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, true);
    this.emitNodeUpdated(nodeId);
    this.scheduleNodeUpdateExpiry(nodeId, operationId, NODE_UPDATE_EXECUTION_TIMEOUT_MS);
    return true;
  }

  /** Shows which lease peers a queued update waits for. */
  async recordNodeUpdateWait(
    nodeId: string,
    operationId: string,
    waitingFor: Array<{ memberId: string; policyId: string; reason: string }>
  ): Promise<void> {
    const metadata = await this.readQueuedUpdate(nodeId, operationId);
    if (!metadata) return;
    metadata.updateWaitingFor = waitingFor;
    if (await this.writeUpdateMetadata(nodeId, operationId, metadata)) this.emitNodeUpdated(nodeId);
  }

  /** Ends a queued or running update that could not complete and keeps the reason on the node. */
  async failNodeUpdate(nodeId: string, operationId: string, error: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;
    for (const key of NODE_UPDATE_METADATA_KEYS) delete metadata[key];
    metadata.updateLastError = error;
    metadata.updateLastErrorAt = new Date().toISOString();
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;
    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  /** Queued updates of lease members, for a Gateway restart to take up again. */
  async listQueuedNodeUpdates(): Promise<Array<{ nodeId: string; operationId: string; startedAt: Date | null }>> {
    const rows = await this.db.select({ id: nodes.id, metadata: nodes.metadata }).from(nodes);
    return rows.flatMap((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const startedAt = typeof metadata.updateStartedAt === 'string' ? new Date(metadata.updateStartedAt) : null;
      return metadata.updateInProgress === true &&
        metadata.updatePhase === NODE_UPDATE_WAITING_PHASE &&
        typeof metadata.updateOperationId === 'string'
        ? [
            {
              nodeId: row.id,
              operationId: metadata.updateOperationId,
              startedAt: startedAt && Number.isFinite(startedAt.getTime()) ? startedAt : null,
            },
          ]
        : [];
    });
  }

  private async readQueuedUpdate(nodeId: string, operationId: string): Promise<Record<string, unknown> | null> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return null;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (
      metadata.updateInProgress !== true ||
      metadata.updateOperationId !== operationId ||
      metadata.updatePhase !== NODE_UPDATE_WAITING_PHASE
    ) {
      return null;
    }
    return metadata;
  }

  private async writeUpdateMetadata(
    nodeId: string,
    operationId: string,
    metadata: Record<string, unknown>
  ): Promise<boolean> {
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    return updated.length > 0;
  }

  private scheduleNodeUpdateExpiry(nodeId: string, operationId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      void this.expireNodeUpdate(nodeId, operationId).catch((error) => {
        logger.error('Failed to expire daemon update deadline', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    timer.unref?.();
  }

  private async expireNodeUpdateIfDue(nodeId: string, metadata: Record<string, unknown>): Promise<boolean> {
    if (metadata.updateInProgress !== true || typeof metadata.updateOperationId !== 'string') return false;
    const deadlineAt =
      typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt) || Date.now() < deadlineAt) return false;
    return this.expireNodeUpdate(nodeId, metadata.updateOperationId);
  }

  private async expireNodeUpdate(nodeId: string, operationId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;
    const deadlineAt =
      typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt) || Date.now() < deadlineAt) return false;

    const target = typeof metadata.updateTargetVersion === 'string' ? metadata.updateTargetVersion : 'the new version';
    const reason =
      metadata.updatePhase === NODE_UPDATE_WAITING_PHASE
        ? 'The update waited too long for the other members of its availability lease'
        : metadata.updatePhase === 'reconnecting'
          ? `The daemon did not come back on ${target} in time`
          : `The update to ${target} did not finish in time`;
    if (!(await this.failNodeUpdate(nodeId, operationId, reason))) return false;
    // A node that is still away is offline now that its update no longer covers it.
    await this.nodeRegistry?.markOfflineAfterUpdate(nodeId);
    logger.error('Daemon update did not complete before its deadline', { nodeId, operationId, reason });
    return true;
  }

  async clearNodeUpdateInProgress(nodeId: string, operationId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;

    delete metadata.updateInProgress;
    delete metadata.updateTargetVersion;
    delete metadata.updateStartedAt;
    delete metadata.updateOperationId;
    delete metadata.updatePhase;
    delete metadata.updateDeadlineAt;
    delete metadata.updateReconnectStartedAt;
    delete metadata.updateWaitingFor;

    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;

    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  private async beginNodeUpdateReconnectDeadline(nodeId: string, operationId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;

    metadata.updatePhase = 'reconnecting';
    metadata.updateReconnectStartedAt = new Date().toISOString();
    metadata.updateDeadlineAt = new Date(Date.now() + NODE_UPDATE_RECONNECT_TIMEOUT_MS).toISOString();
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;
    this.scheduleNodeUpdateExpiry(nodeId, operationId, NODE_UPDATE_RECONNECT_TIMEOUT_MS);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  trackNodeUpdateCompletion(nodeId: string, operationId: string, completion: Promise<CommandResult>): void {
    void completion.then(
      async (result) => {
        if (result.success) {
          await this.beginNodeUpdateReconnectDeadline(nodeId, operationId).catch((error) => {
            logger.error('Failed to start daemon reconnect deadline after update success', {
              nodeId,
              operationId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        const reason = result.error || result.detail || 'The daemon rejected the update';
        logger.error('Daemon update failed after dispatch', { nodeId, error: reason });
        await this.failNodeUpdate(nodeId, operationId, reason).catch((error) => {
          logger.error('Failed to record the rejected daemon update', {
            nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Node disconnected' || message.includes('timed out after')) {
          logger.info('Daemon update is awaiting reconnect after an uncertain command result', { nodeId, operationId });
          await this.beginNodeUpdateReconnectDeadline(nodeId, operationId).catch((reconnectError) => {
            logger.error('Failed to start daemon reconnect deadline after uncertain update result', {
              nodeId,
              operationId,
              error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
            });
          });
          return;
        }
        logger.error('Daemon update did not complete', { nodeId, error: message });
        await this.failNodeUpdate(nodeId, operationId, message).catch((failError) => {
          logger.error('Failed to record the incomplete daemon update', {
            nodeId,
            error: failError instanceof Error ? failError.message : String(failError),
          });
        });
      }
    );
  }

  /**
   * Reconciles a running update with a daemon registration. A registration on the target version (or later) after the
   * update started ends it, whether or not its result arrived. A registration below the target after the daemon was
   * told to restart means the update was rolled back or never installed, and fails it with that reason.
   */
  async clearNodeUpdateInProgressOnReconnect(
    nodeId: string,
    reportedVersion: string,
    registrationObservedAt = new Date()
  ): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true) return false;
    const operationId = metadata.updateOperationId;
    if (typeof operationId !== 'string') return false;
    if (metadata.updatePhase !== 'executing' && metadata.updatePhase !== 'reconnecting') return false;

    const observedAt = registrationObservedAt.getTime();
    const startedAt = typeof metadata.updateStartedAt === 'string' ? Date.parse(metadata.updateStartedAt) : Number.NaN;
    const reconnectStartedAt =
      typeof metadata.updateReconnectStartedAt === 'string'
        ? Date.parse(metadata.updateReconnectStartedAt)
        : Number.NaN;
    const targetVersion = typeof metadata.updateTargetVersion === 'string' ? metadata.updateTargetVersion : '';
    const onTarget =
      !targetVersion ||
      (parseSemver(reportedVersion) !== null &&
        parseSemver(targetVersion) !== null &&
        compareSemver(reportedVersion, targetVersion) >= 0);

    if (!onTarget) {
      if (
        metadata.updatePhase !== 'reconnecting' ||
        !Number.isFinite(reconnectStartedAt) ||
        observedAt < reconnectStartedAt
      ) {
        return false;
      }
      return this.failNodeUpdate(
        nodeId,
        operationId,
        `The daemon came back on ${reportedVersion} instead of ${targetVersion}: the update was rolled back or not installed`
      );
    }
    if (Number.isFinite(startedAt) && observedAt < startedAt) return false;

    for (const key of NODE_UPDATE_METADATA_KEYS) delete metadata[key];
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;

    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  /**
   * Expiry timers live in memory, so a Gateway restart loses them and no command result can arrive any more. Updates
   * that were sent before the restart wait for the daemon to register again: they move to `reconnecting` (a
   * registration from now on decides them) and get their timers back; the ones already past their deadline expire.
   */
  async resumeNodeUpdateDeadlines(processStartedAt: Date): Promise<number> {
    const rows = await this.db.select({ id: nodes.id, metadata: nodes.metadata }).from(nodes);
    let resumed = 0;
    for (const row of rows) {
      const metadata = { ...((row.metadata ?? {}) as Record<string, unknown>) };
      const operationId = metadata.updateOperationId;
      if (metadata.updateInProgress !== true || typeof operationId !== 'string') continue;
      if (metadata.updatePhase !== 'executing' && metadata.updatePhase !== 'reconnecting') continue;
      const deadlineAt =
        typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
      if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
        if (await this.expireNodeUpdate(row.id, operationId)) resumed += 1;
        continue;
      }
      const remainingMs = Math.max(deadlineAt - Date.now(), NODE_UPDATE_RECONNECT_TIMEOUT_MS);
      metadata.updatePhase = 'reconnecting';
      metadata.updateReconnectStartedAt = processStartedAt.toISOString();
      metadata.updateDeadlineAt = new Date(Date.now() + remainingMs).toISOString();
      if (!(await this.writeUpdateMetadata(row.id, operationId, metadata))) continue;
      this.nodeRegistry?.setNodeUpdateInProgress(row.id, true);
      this.scheduleNodeUpdateExpiry(row.id, operationId, remainingMs);
      resumed += 1;
    }
    return resumed;
  }

  /** Keeps why an update that is no longer running could not start again (for example after a Gateway restart). */
  async recordNodeUpdateError(nodeId: string, error: string): Promise<void> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress === true) return;
    metadata.updateLastError = error;
    metadata.updateLastErrorAt = new Date().toISOString();
    await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`COALESCE(${nodes.metadata}->>'updateInProgress', 'false') <> 'true'`));
    this.emitNodeUpdated(nodeId);
  }

  getDownloadUrl(daemonType: DaemonType, tag: string, arch: string): string {
    return this.getArtifactSource(daemonType, tag, arch).artifactUrl;
  }

  async prepareTrustedDaemonUpdate(
    daemonType: DaemonType,
    tag: string,
    version: string,
    arch: string
  ): Promise<TrustedDaemonUpdateArtifact> {
    const normalizedArch = this.normalizePackageArch(arch);
    const artifactName = this.getBinaryName(daemonType, normalizedArch);
    const source = this.getArtifactSource(daemonType, tag, normalizedArch);
    const response = await fetch(source.manifestUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        'UNTRUSTED_UPDATE_ARTIFACT',
        `Failed to fetch daemon update manifest: ${response.status}`
      );
    }
    const signedManifest = await response.text();
    try {
      return verifyDaemonUpdateManifest(signedManifest, {
        daemonType,
        version,
        tag,
        arch: normalizedArch,
        artifactName,
        downloadUrl: source.artifactUrl,
        trustedPackagePrefix: source.trustedPrefix,
      });
    } catch (error) {
      logger.warn('Daemon update manifest verification failed', {
        daemonType,
        tag,
        arch: normalizedArch,
        source: source.manifestUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Daemon update artifact is not trusted');
    }
  }

  getManifestUrl(daemonType: DaemonType, tag: string, arch: string): string {
    return this.getArtifactSource(daemonType, tag, arch).manifestUrl;
  }

  getBinaryName(daemonType: DaemonType, arch: string): string {
    const daemonName = DAEMON_BINARY_MAP[daemonType];
    return `${daemonName}-linux-${this.normalizePackageArch(arch)}`;
  }

  normalizePackageArch(arch: string): string {
    const normalized = arch.trim().toLowerCase();
    switch (normalized) {
      case 'x86_64':
      case 'x64':
      case 'amd64':
        return 'amd64';
      case 'aarch64':
      case 'arm64':
        return 'arm64';
      default:
        return normalized || 'amd64';
    }
  }

  private async getSetting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return (row?.value as string) ?? null;
  }

  private async upsertSetting(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  private async deleteSettings(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.db.delete(settings).where(eq(settings.key, key))));
  }
}
