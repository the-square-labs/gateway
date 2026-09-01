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
  // Database nodes run the same docker-daemon binary in its database-only profile.
  databases: 'docker',
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

  async markNodeUpdateInProgress(nodeId: string, targetVersion: string): Promise<string> {
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
    metadata.updateInProgress = true;
    metadata.updateTargetVersion = targetVersion;
    metadata.updateStartedAt = new Date(now).toISOString();
    metadata.updateOperationId = operationId;
    metadata.updatePhase = 'executing';
    metadata.updateDeadlineAt = new Date(now + NODE_UPDATE_EXECUTION_TIMEOUT_MS).toISOString();

    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`COALESCE(${nodes.metadata}->>'updateInProgress', 'false') <> 'true'`))
      .returning({ id: nodes.id });
    if (updated.length === 0) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is already in progress');
    }

    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, true);
    this.emitNodeUpdated(nodeId);
    this.scheduleNodeUpdateExpiry(nodeId, operationId, NODE_UPDATE_EXECUTION_TIMEOUT_MS);
    return operationId;
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
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;
    const deadlineAt =
      typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt) || Date.now() < deadlineAt) return false;

    delete metadata.updateInProgress;
    delete metadata.updateTargetVersion;
    delete metadata.updateStartedAt;
    delete metadata.updateOperationId;
    delete metadata.updatePhase;
    delete metadata.updateDeadlineAt;
    delete metadata.updateReconnectStartedAt;
    const update =
      this.nodeRegistry && !this.nodeRegistry.getNode(nodeId)
        ? { metadata, updatedAt: new Date(), status: 'offline' as const }
        : { metadata, updatedAt: new Date() };

    const updated = await this.db
      .update(nodes)
      .set(update)
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;

    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    logger.error('Daemon did not reconnect before the update deadline', { nodeId, operationId });
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
        logger.error('Daemon update failed after dispatch', {
          nodeId,
          error: result.error || result.detail || 'Daemon rejected the update',
        });
        await this.clearNodeUpdateInProgress(nodeId, operationId).catch((error) => {
          logger.error('Failed to clear daemon update lock after rejection', {
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
        await this.clearNodeUpdateInProgress(nodeId, operationId).catch((clearError) => {
          logger.error('Failed to clear incomplete daemon update lock', {
            nodeId,
            error: clearError instanceof Error ? clearError.message : String(clearError),
          });
        });
      }
    );
  }

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
    if (metadata.updatePhase !== 'reconnecting') return false;
    const reconnectStartedAt =
      typeof metadata.updateReconnectStartedAt === 'string'
        ? Date.parse(metadata.updateReconnectStartedAt)
        : Number.NaN;
    if (!Number.isFinite(reconnectStartedAt) || registrationObservedAt.getTime() < reconnectStartedAt) return false;

    const targetVersion = metadata.updateTargetVersion;
    if (typeof targetVersion === 'string' && targetVersion.length > 0) {
      const reported = parseSemver(reportedVersion);
      const target = parseSemver(targetVersion);
      if (!reported || !target || compareSemver(reportedVersion, targetVersion) < 0) return false;
    }

    delete metadata.updateInProgress;
    delete metadata.updateTargetVersion;
    delete metadata.updateStartedAt;
    delete metadata.updateOperationId;
    delete metadata.updatePhase;
    delete metadata.updateDeadlineAt;
    delete metadata.updateReconnectStartedAt;

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
