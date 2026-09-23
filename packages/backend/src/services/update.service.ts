import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { nodes, relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import { settings } from '@/db/schema/settings.js';
import { DEFAULT_SANDBOX_WORKSPACE_DIR } from '@/foundation/foundation-migrator.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  type ReleaseFileSource,
  type ReleaseRecord,
  releaseFileSource,
  releaseNotes,
  releaseUrl,
} from '@/lib/release-artifacts.js';
import { compareSemver, isNewerVersion, isReleaseCandidateVersion, parseSemver } from '@/lib/semver.js';
import type { TrustedDaemonUpdateArtifact } from '@/lib/update-artifact-trust.js';
import {
  type TrustedGatewayUpdateArtifact,
  type TrustedRelayUpdateArtifact,
  verifyGatewayImageManifest,
  verifyRelayImageManifest,
} from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { GeneralSettingsService, UpdateChannel } from '@/modules/settings/general-settings.service.js';
import type { DockerService } from './docker.service.js';
import {
  type OrchestrationActivitySource,
  type PendingOrchestrationOperation,
  waitForOrchestrationIdle,
} from './orchestration-activity.js';
import { saveInstalledRelayArtifact } from './relay-installed-artifact.js';

const logger = createChildLogger('UpdateService');
export const DOCKER_COMPOSE_CLI_IMAGE_REF =
  'docker.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  lastCheckedAt: string | null;
  relay: RelayUpdateStatus;
  gatewayOperation: GatewayUpdateOperation | null;
}

/**
 * A Gateway self-update this process accepted and has not handed off yet, or
 * (`failed`) a handed-off update that did not replace this version.
 */
export interface GatewayUpdateOperation {
  /** `waiting_for_operations` until running orchestration work finishes. */
  status: 'waiting_for_operations' | 'updating' | 'failed';
  targetVersion: string;
  startedAt: string;
  /** When the update proceeds even if operations still run. */
  waitDeadline: string | null;
  operations: PendingOrchestrationOperation[];
  /** Why the update did not complete; set only when `failed`. */
  error?: string | null;
}

export interface UpdateEvents {
  publish(channel: string, payload: unknown): void;
}

export interface UpdateAuditLog {
  log(entry: {
    userId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * A handed-off update replaces this process within minutes. If it is still
 * alive after this, the handoff failed: accept orchestration work again.
 */
const UPDATE_HANDOFF_SETTLE_MS = 20 * 60_000;

/**
 * Written before anything on the host changes. The process that starts next
 * reads it: the target version clears it, any other version reports a failure.
 */
const GATEWAY_UPDATE_ATTEMPT_KEY = 'update:gateway:attempt';
/** A failed update stays reported this long unless an admin acknowledges it. */
const FAILED_GATEWAY_UPDATE_REPORT_MS = 24 * 60 * 60_000;

interface GatewayUpdateAttempt {
  targetVersion: string;
  fromVersion: string;
  startedAt: string;
  userId: string | null;
  sidecarId: string | null;
  failedAt: string | null;
  error: string | null;
}

/** States in which a Relay Pool update run is being driven by a Gateway process. */
const ACTIVE_RELAY_POOL_RUN_STATES = ['preflight', 'draining', 'updating', 'verifying', 'rolling_back'] as const;
/** Active runs plus paused ones, which wait for an operator to retry or abandon them. */
const UNFINISHED_RELAY_POOL_RUN_STATES = [...ACTIVE_RELAY_POOL_RUN_STATES, 'paused'] as const;
/** Step states in which the update may hold the relay drained. */
const IN_FLIGHT_RELAY_POOL_STEP_STATES = ['draining', 'updating', 'verifying', 'rolling_back'] as const;
const RELAY_DRAIN_RELEASE_RETRY_MS = 30_000;
const RELAY_DRAIN_RELEASE_ATTEMPTS = 20;
const RELAY_UPDATE_BLOCKS_GATEWAY_MESSAGE =
  'A Relay Pool update is in progress. Update Gateway after it finishes, or abandon the Relay Pool update first.';

class RelayPoolUpdateAbandonedError extends Error {
  constructor() {
    super('The Relay Pool update was abandoned');
  }
}

export interface RelayUpdateOperation {
  status: 'updating' | 'failed';
  targetVersion: string;
  startedAt: string;
  error: string | null;
}

export interface RelayUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  operation: RelayUpdateOperation | null;
}

interface FoundationMigrationOutput {
  ok: true;
  changedFiles: string[];
  backupDir: string | null;
  sandboxWorkspaceDir: string;
}

export interface RelayUpdateRuntime {
  setMaintenance(enabled: boolean): Promise<void>;
  setExpectedArtifact(imageRef: string, buildVersion: string, protocolMajor: number): void;
  updateSecureLinkConnectorImage(imageRef: string): Promise<void>;
  probeNow(): Promise<void>;
}

export interface RelayPoolUpdateRuntime {
  drainInstance(instanceId: string, userId: string | null, enabled: boolean): Promise<void>;
  prepareWorkerUpdate(version: string, arch: string): Promise<TrustedDaemonUpdateArtifact>;
  dispatchWorkerUpdate(nodeId: string, artifact: TrustedDaemonUpdateArtifact): Promise<void>;
  prepareSupervisorUpdate(version: string, arch: string): Promise<TrustedDaemonUpdateArtifact>;
  dispatchSupervisorUpdate(nodeId: string, artifact: TrustedDaemonUpdateArtifact): Promise<void>;
}

export function isGatewayReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

export function selectLatestGatewayRelease(releases: ReleaseRecord[]): ReleaseRecord | null {
  const matching = releases
    .filter((release) => isGatewayReleaseTag(release.tag_name))
    .sort((a, b) => compareSemver(b.tag_name, a.tag_name));

  return matching[0] ?? null;
}

export function isRelayReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+-relay$/.test(tag);
}

export function selectLatestRelayRelease(releases: ReleaseRecord[]): ReleaseRecord | null {
  return (
    releases
      .filter((release) => isRelayReleaseTag(release.tag_name))
      .sort((a, b) => compareSemver(b.tag_name.replace(/-relay$/, ''), a.tag_name.replace(/-relay$/, '')))[0] ?? null
  );
}

export function isRelayTooOldForGatewayUpdate(relayVersion: string, targetVersion: string): boolean {
  const current = parseSemver(relayVersion);
  const target = parseSemver(targetVersion);
  if (!current || !target) return false;
  if (current.major < target.major) return true;
  if (current.major > target.major) return false;
  return target.minor - current.minor >= 2;
}

export function isGatewayCompatibleWithRelayUpdate(currentVersion: string, minGatewayVersion: string): boolean {
  const current = parseSemver(currentVersion);
  const minimum = parseSemver(minGatewayVersion);
  if (!current || !minimum) return currentVersion === 'dev';
  return compareSemver(currentVersion, minGatewayVersion) >= 0;
}

const SETTINGS_KEYS = {
  latestVersion: 'update:latest_version',
  lastCheckedAt: 'update:last_checked_at',
  releaseNotes: 'update:release_notes',
  releaseUrl: 'update:release_url',
  relayLatestVersion: 'update:relay:latest_version',
  relayReleaseNotes: 'update:relay:release_notes',
  relayReleaseUrl: 'update:relay:release_url',
  relayMinGatewayVersion: 'update:relay:min_gateway_version',
} as const;

export class UpdateService {
  private gatewayUpdateInProgress = false;
  private gatewayUpdateOperation: GatewayUpdateOperation | null = null;
  private orchestration?: OrchestrationActivitySource;
  private events?: UpdateEvents;
  private audit?: UpdateAuditLog;
  private operationWaitOverride: AbortController | null = null;
  private handoffSettleTimer?: ReturnType<typeof setTimeout>;
  private failedReportTimer?: ReturnType<typeof setTimeout>;
  private readonly releasesUrl: string;
  private relayUpdateOperation: RelayUpdateOperation | null = null;
  private relayPoolRuntime?: RelayPoolUpdateRuntime;
  /** Set while this process drives a Relay Pool run; aborting it abandons the run. */
  private relayPoolRun: AbortController | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerService: DockerService,
    private readonly env: Env,
    private readonly relayRuntime?: RelayUpdateRuntime,
    private readonly generalSettings?: GeneralSettingsService
  ) {
    this.releasesUrl = this.env.RELEASES_API_URL;
  }

  private async getUpdateChannel(): Promise<UpdateChannel> {
    return (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';
  }

  private async fetchReleases(): Promise<ReleaseRecord[]> {
    const channel = await this.getUpdateChannel();
    const url = new URL(this.releasesUrl);
    url.searchParams.set('channel', channel);
    logger.debug('Checking release provider for updates', { url: url.toString(), channel });
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Release API returned ${response.status}`);
    return (await response.json()) as ReleaseRecord[];
  }

  private async fetchNextRelease(
    component: 'gateway' | 'relay',
    currentVersion: string,
    channel: UpdateChannel
  ): Promise<ReleaseRecord | null> {
    const url = new URL(this.releasesUrl);
    url.searchParams.set('component', component);
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

  private gatewayImageRepositories(currentImage: string): string[] {
    const configured = (this.env.GATEWAY_UPDATE_IMAGE_REPOSITORIES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return [...new Set([currentImage, ...configured])];
  }

  private getManifestSource(packageName: string, tag: string, fileName: string): ReleaseFileSource {
    return releaseFileSource(this.env.ARTIFACT_BASE_URL, packageName, tag, fileName);
  }

  private async fetchSignedManifest(source: ReleaseFileSource, label: string): Promise<string> {
    const response = await fetch(source.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return response.text();
    throw new AppError(
      502,
      'UNTRUSTED_UPDATE_ARTIFACT',
      `Failed to fetch ${label} update manifest: ${response.status}`
    );
  }

  setRelayPoolUpdateRuntime(runtime: RelayPoolUpdateRuntime): void {
    this.relayPoolRuntime = runtime;
  }

  /** The update waits for (and holds new) orchestration work reported by this source. */
  setOrchestrationGate(source: OrchestrationActivitySource, events?: UpdateEvents): void {
    this.orchestration = source;
    this.events = events;
  }

  setAuditLog(audit: UpdateAuditLog): void {
    this.audit = audit;
  }

  isGatewayUpdateInProgress(): boolean {
    return this.gatewayUpdateInProgress;
  }

  /** Refuses a Gateway update (or paid-feature activation) that would interrupt another update. */
  async assertGatewayUpdateAllowed(): Promise<void> {
    if (this.gatewayUpdateInProgress) {
      throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A Gateway update is already in progress');
    }
    if (await this.isRelayUpdateRunning()) {
      throw new AppError(409, 'RELAY_UPDATE_IN_PROGRESS', RELAY_UPDATE_BLOCKS_GATEWAY_MESSAGE);
    }
  }

  /** True while a Gateway update or a running Relay update is in flight. */
  async isAnyUpdateRunning(): Promise<boolean> {
    return this.gatewayUpdateInProgress || (await this.isRelayUpdateRunning());
  }

  /** A Relay update that runs now; a paused Relay Pool run waits for the operator and does not count. */
  private async isRelayUpdateRunning(): Promise<boolean> {
    if (this.relayUpdateOperation?.status === 'updating' || this.relayPoolRun) return true;
    if (!this.relayPoolRuntime) return false;
    const [run] = await this.db
      .select({ id: relayPoolUpdateRuns.id })
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [...ACTIVE_RELAY_POOL_RUN_STATES])
        )
      )
      .limit(1);
    return Boolean(run);
  }

  /** The operator's "update now": stop waiting for running orchestration work. */
  proceedWithoutWaiting(): boolean {
    if (this.gatewayUpdateOperation?.status !== 'waiting_for_operations' || !this.operationWaitOverride) return false;
    this.operationWaitOverride.abort();
    return true;
  }

  getCurrentVersion(): string {
    return this.env.APP_VERSION;
  }

  startRelayUpdate(targetVersion: string): void {
    if (this.gatewayUpdateInProgress) {
      throw new AppError(
        409,
        'GATEWAY_UPDATE_IN_PROGRESS',
        'Gateway is updating. Update the Relay Pool after the Gateway update has finished.'
      );
    }
    if (this.relayUpdateOperation?.status === 'updating' || this.relayPoolRun) {
      throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A relay update is already in progress');
    }
    this.relayUpdateOperation = {
      status: 'updating',
      targetVersion: normalizeVersionTag(targetVersion),
      startedAt: new Date().toISOString(),
      error: null,
    };
  }

  completeRelayUpdate(): void {
    this.relayUpdateOperation = null;
  }

  failRelayUpdate(error: unknown): void {
    const operation = this.relayUpdateOperation;
    if (!operation) return;
    this.relayUpdateOperation = {
      ...operation,
      status: 'failed',
      error: formatError(error),
    };
  }

  async getCachedStatus(): Promise<UpdateStatus> {
    const currentVersion = this.getCurrentVersion();
    const updateChannel = await this.getUpdateChannel();

    const allRows = await this.db
      .select()
      .from(settings)
      .where(inArray(settings.key, Object.values(SETTINGS_KEYS)));

    const map = new Map(allRows.map((r) => [r.key, r.value as string]));

    const cachedLatestVersion = map.get(SETTINGS_KEYS.latestVersion) ?? null;
    const latestVersion =
      updateChannel === 'stable' && cachedLatestVersion && isReleaseCandidateVersion(cachedLatestVersion)
        ? null
        : cachedLatestVersion;
    const gatewayUpdateAvailable =
      currentVersion !== 'dev' && latestVersion != null ? isNewerVersion(latestVersion, currentVersion) : false;
    const currentRelayVersion = this.env.GATEWAY_RELAY_BUILD_VERSION ?? 'unknown';
    const cachedLatestRelayVersion = map.get(SETTINGS_KEYS.relayLatestVersion) ?? null;
    const latestRelayVersion =
      updateChannel === 'stable' && cachedLatestRelayVersion && isReleaseCandidateVersion(cachedLatestRelayVersion)
        ? null
        : cachedLatestRelayVersion;
    const relayMinGatewayVersion = map.get(SETTINGS_KEYS.relayMinGatewayVersion) ?? null;
    const relayUpdateAvailable =
      currentRelayVersion !== 'dev' &&
      currentRelayVersion !== 'unknown' &&
      latestRelayVersion != null &&
      relayMinGatewayVersion != null &&
      isGatewayCompatibleWithRelayUpdate(currentVersion, relayMinGatewayVersion) &&
      isNewerVersion(latestRelayVersion, currentRelayVersion);
    const updateAvailable =
      gatewayUpdateAvailable &&
      latestVersion != null &&
      !isRelayTooOldForGatewayUpdate(currentRelayVersion, latestVersion);

    const durableOperation = await this.getDurableRelayOperation();
    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseNotes: latestVersion ? (map.get(SETTINGS_KEYS.releaseNotes) ?? null) : null,
      releaseUrl: latestVersion ? (map.get(SETTINGS_KEYS.releaseUrl) ?? null) : null,
      lastCheckedAt: map.get(SETTINGS_KEYS.lastCheckedAt) ?? null,
      relay: {
        currentVersion: currentRelayVersion,
        latestVersion: latestRelayVersion,
        updateAvailable: relayUpdateAvailable,
        releaseNotes: latestRelayVersion ? (map.get(SETTINGS_KEYS.relayReleaseNotes) ?? null) : null,
        releaseUrl: latestRelayVersion ? (map.get(SETTINGS_KEYS.relayReleaseUrl) ?? null) : null,
        operation: durableOperation ?? this.relayUpdateOperation,
      },
      gatewayOperation: this.gatewayUpdateOperation,
    };
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    const currentVersion = this.getCurrentVersion();

    // Always persist the check timestamp
    const lastCheckedAt = new Date().toISOString();
    await this.upsertSetting(SETTINGS_KEYS.lastCheckedAt, lastCheckedAt);

    if (currentVersion === 'dev') {
      logger.debug('Skipping update check in dev mode');
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseNotes: null,
        releaseUrl: null,
        lastCheckedAt,
        relay: {
          currentVersion: this.env.GATEWAY_RELAY_BUILD_VERSION ?? 'dev',
          latestVersion: null,
          updateAvailable: false,
          releaseNotes: null,
          releaseUrl: null,
          operation: this.relayUpdateOperation,
        },
        gatewayOperation: this.gatewayUpdateOperation,
      };
    }

    try {
      const currentRelayVersion = this.env.GATEWAY_RELAY_BUILD_VERSION ?? currentVersion;
      const updateChannel = await this.getUpdateChannel();
      const [latest, latestRelay] = await Promise.all([
        this.fetchNextRelease('gateway', currentVersion, updateChannel),
        this.fetchNextRelease('relay', currentRelayVersion, updateChannel),
      ]);
      if (latest) {
        await this.upsertSetting(SETTINGS_KEYS.latestVersion, latest.tag_name);
        await this.upsertSetting(SETTINGS_KEYS.releaseNotes, releaseNotes(latest));
        await this.upsertSetting(SETTINGS_KEYS.releaseUrl, releaseUrl(latest));
      } else {
        await this.deleteSettings([SETTINGS_KEYS.latestVersion, SETTINGS_KEYS.releaseNotes, SETTINGS_KEYS.releaseUrl]);
      }
      if (latestRelay) {
        const relayVersion = latestRelay.tag_name.replace(/-relay$/, '');
        const relayArtifact = await this.prepareRelayUpdate(relayVersion, true);
        await this.upsertSetting(SETTINGS_KEYS.relayLatestVersion, relayVersion);
        await this.upsertSetting(SETTINGS_KEYS.relayReleaseNotes, releaseNotes(latestRelay));
        await this.upsertSetting(SETTINGS_KEYS.relayReleaseUrl, releaseUrl(latestRelay));
        await this.upsertSetting(SETTINGS_KEYS.relayMinGatewayVersion, relayArtifact.minGatewayVersion);
      } else {
        await this.deleteSettings([
          SETTINGS_KEYS.relayLatestVersion,
          SETTINGS_KEYS.relayReleaseNotes,
          SETTINGS_KEYS.relayReleaseUrl,
          SETTINGS_KEYS.relayMinGatewayVersion,
        ]);
      }
      if (!latest && !latestRelay) logger.debug('No Gateway or relay releases found');
      return this.getCachedStatus();
    } catch (error) {
      logger.warn('Update check failed', { error });
      // Return cached status on failure
      return this.getCachedStatus();
    }
  }

  async getReleaseNotes(version: string): Promise<string> {
    const releases = await this.fetchReleases();
    const release = releases.find((candidate) => candidate.tag_name === version);
    if (!release) throw new Error(`Release ${version} was not found`);
    return releaseNotes(release);
  }

  /**
   * Fetch release notes for all versions between `after` (exclusive) and `upTo` (inclusive).
   * Returns newest first.
   */
  async getReleaseNotesSince(after: string, upTo: string): Promise<{ version: string; notes: string }[]> {
    const releases = await this.fetchReleases();

    // Filter releases: newer than `after` and up to `upTo` (inclusive)
    return releases
      .filter((r) => {
        const tag = r.tag_name;
        return isGatewayReleaseTag(tag) && compareSemver(tag, after) > 0 && compareSemver(tag, upTo) <= 0;
      })
      .sort((a, b) => compareSemver(b.tag_name, a.tag_name))
      .map((r) => ({ version: r.tag_name, notes: releaseNotes(r) }));
  }

  async prepareGatewayUpdate(targetVersion: string): Promise<TrustedGatewayUpdateArtifact> {
    const tag = normalizeVersionTag(targetVersion);
    const selfInfo = await this.dockerService.inspectSelf();
    const currentImage = imageRepositoryFromRef(selfInfo.Config.Image);
    const signedManifest = await this.fetchSignedManifest(
      this.getManifestSource('gateway', tag, 'gateway-image.update.json'),
      'gateway'
    );
    let artifact: TrustedGatewayUpdateArtifact | null = null;
    let verificationError: unknown;
    for (const image of this.gatewayImageRepositories(currentImage)) {
      try {
        artifact = verifyGatewayImageManifest(signedManifest, { version: tag, tag, image });
        break;
      } catch (error) {
        verificationError = error;
      }
    }
    if (!artifact) {
      logger.warn('Gateway update manifest verification failed', {
        targetVersion,
        currentImage,
        error: verificationError instanceof Error ? verificationError.message : String(verificationError),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Gateway update artifact is not trusted');
    }

    return artifact;
  }

  async prepareRelayUpdate(
    targetVersion: string,
    allowIncompatibleGateway = false
  ): Promise<TrustedRelayUpdateArtifact> {
    const version = normalizeVersionTag(targetVersion);
    const tag = `${version}-relay`;
    const selfInfo = await this.dockerService.inspectSelf();
    const currentImage = imageRepositoryFromRef(selfInfo.Config.Image);
    const signedManifest = await this.fetchSignedManifest(
      this.getManifestSource('relay', tag, 'relay-image.update.json'),
      'relay'
    );
    let artifact: TrustedRelayUpdateArtifact | null = null;
    let verificationError: unknown;
    for (const gatewayImage of this.gatewayImageRepositories(currentImage)) {
      try {
        artifact = verifyRelayImageManifest(signedManifest, {
          version,
          tag,
          image: `${gatewayImage}/relay`,
          protocolMajor: 1,
        });
        break;
      } catch (error) {
        verificationError = error;
      }
    }
    if (!artifact) {
      logger.warn('Relay update manifest verification failed', {
        targetVersion,
        currentImage,
        error: verificationError instanceof Error ? verificationError.message : String(verificationError),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Relay update artifact is not trusted');
    }
    if (
      !allowIncompatibleGateway &&
      !isGatewayCompatibleWithRelayUpdate(this.getCurrentVersion(), artifact.minGatewayVersion)
    ) {
      throw new AppError(
        409,
        'GATEWAY_UPDATE_REQUIRED',
        `Relay ${version} requires Gateway ${artifact.minGatewayVersion} or newer`
      );
    }
    return artifact;
  }

  async performUpdate(
    targetVersion: string,
    artifact: TrustedGatewayUpdateArtifact,
    userId: string | null = null
  ): Promise<void> {
    if (this.gatewayUpdateInProgress)
      throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A Gateway update is already in progress');
    this.gatewayUpdateInProgress = true;
    this.setGatewayUpdateOperation({
      status: 'updating',
      targetVersion: normalizeVersionTag(targetVersion),
      startedAt: new Date().toISOString(),
      waitDeadline: null,
      operations: [],
    });
    try {
      // Checked after the flag is set: a Relay update cannot start from here on.
      if (await this.isRelayUpdateRunning()) {
        throw new AppError(409, 'RELAY_UPDATE_IN_PROGRESS', RELAY_UPDATE_BLOCKS_GATEWAY_MESSAGE);
      }
      await this.performGatewayUpdate(targetVersion, artifact, userId);
    } catch (error) {
      this.gatewayUpdateInProgress = false;
      this.setGatewayUpdateOperation(null);
      this.orchestration?.setOrchestrationAdmissionHold(null);
      // This process reports the failure itself; the next start must not.
      await this.deleteSettings([GATEWAY_UPDATE_ATTEMPT_KEY]).catch((clearError) =>
        logger.warn('Could not clear the Gateway update attempt record', { error: formatError(clearError) })
      );
      throw error;
    }
    this.handoffSettleTimer = setTimeout(() => {
      logger.error('Gateway update handoff did not replace this process; accepting orchestration work again', {
        targetVersion,
      });
      this.gatewayUpdateInProgress = false;
      this.orchestration?.setOrchestrationAdmissionHold(null);
      void this.reportFailedGatewayUpdate(
        `The update to ${normalizeVersionTag(targetVersion)} did not replace Gateway ${this.getCurrentVersion()}, which keeps running. Check the update container logs on the Gateway host.`
      ).catch((error) => logger.error('Could not report the failed Gateway update', { error: formatError(error) }));
    }, UPDATE_HANDOFF_SETTLE_MS);
    this.handoffSettleTimer.unref?.();
  }

  /**
   * Runs once at startup. No update runs in a process that just started, so an
   * unfinished Gateway attempt or Relay Pool run in the database was
   * interrupted: report it and release what it holds.
   */
  async recoverInterruptedUpdates(): Promise<void> {
    await this.recoverGatewayUpdateAttempt().catch((error) =>
      logger.error('Could not recover the Gateway update attempt', { error: formatError(error) })
    );
    await this.recoverInterruptedRelayPoolUpdates().catch((error) =>
      logger.error('Could not recover interrupted Relay Pool updates', { error: formatError(error) })
    );
  }

  private async readGatewayUpdateAttempt(): Promise<GatewayUpdateAttempt | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, GATEWAY_UPDATE_ATTEMPT_KEY)).limit(1);
    return parseGatewayUpdateAttempt(row?.value);
  }

  private async recoverGatewayUpdateAttempt(): Promise<void> {
    const attempt = await this.readGatewayUpdateAttempt();
    if (!attempt) {
      await this.deleteSettings([GATEWAY_UPDATE_ATTEMPT_KEY]);
      return;
    }
    const runningVersion = this.getCurrentVersion();
    if (normalizeVersionTag(runningVersion) === normalizeVersionTag(attempt.targetVersion)) {
      logger.info('Gateway update completed', { from: attempt.fromVersion, to: attempt.targetVersion });
      await this.deleteSettings([GATEWAY_UPDATE_ATTEMPT_KEY]);
      return;
    }
    if (!attempt.failedAt) {
      const container = attempt.sidecarId ? ` (docker logs ${attempt.sidecarId.slice(0, 12)})` : '';
      await this.reportFailedGatewayUpdate(
        `Gateway ${attempt.targetVersion} did not start, so the update was rolled back and Gateway ${runningVersion} is running again. Check the update container logs on the Gateway host${container}.`,
        attempt
      );
      return;
    }
    this.restoreFailedGatewayUpdateReport(attempt);
  }

  /** Persists, audits and reports a Gateway update that did not replace this version. */
  private async reportFailedGatewayUpdate(error: string, known?: GatewayUpdateAttempt): Promise<void> {
    const attempt = known ?? (await this.readGatewayUpdateAttempt());
    const targetVersion = attempt?.targetVersion ?? this.gatewayUpdateOperation?.targetVersion;
    if (!targetVersion) return;
    const failed: GatewayUpdateAttempt = {
      targetVersion,
      fromVersion: attempt?.fromVersion ?? this.getCurrentVersion(),
      startedAt: attempt?.startedAt ?? this.gatewayUpdateOperation?.startedAt ?? new Date().toISOString(),
      userId: attempt?.userId ?? null,
      sidecarId: attempt?.sidecarId ?? null,
      failedAt: new Date().toISOString(),
      error,
    };
    await this.upsertSetting(GATEWAY_UPDATE_ATTEMPT_KEY, failed);
    logger.error('Gateway update failed', {
      targetVersion,
      runningVersion: this.getCurrentVersion(),
      error,
    });
    await this.audit
      ?.log({
        userId: failed.userId,
        action: 'system.update.failed',
        resourceType: 'system-update',
        details: {
          targetVersion,
          fromVersion: failed.fromVersion,
          runningVersion: this.getCurrentVersion(),
          startedAt: failed.startedAt,
          sidecarId: failed.sidecarId,
          error,
        },
      })
      .catch(() => undefined);
    this.restoreFailedGatewayUpdateReport(failed);
  }

  private restoreFailedGatewayUpdateReport(attempt: GatewayUpdateAttempt): void {
    const remaining = Date.parse(attempt.failedAt ?? '') + FAILED_GATEWAY_UPDATE_REPORT_MS - Date.now();
    if (!(remaining > 0)) {
      void this.deleteSettings([GATEWAY_UPDATE_ATTEMPT_KEY]).catch(() => undefined);
      return;
    }
    const operation: GatewayUpdateOperation = {
      status: 'failed',
      targetVersion: attempt.targetVersion,
      startedAt: attempt.startedAt,
      waitDeadline: null,
      operations: [],
      error: attempt.error,
    };
    this.gatewayUpdateOperation = operation;
    clearTimeout(this.failedReportTimer);
    this.failedReportTimer = setTimeout(() => {
      if (this.gatewayUpdateOperation === operation) void this.acknowledgeGatewayUpdateFailure();
    }, remaining);
    this.failedReportTimer.unref?.();
    // Sessions that still show the update screen leave it with this error.
    this.events?.publish('system.update.changed', {
      updating: false,
      component: 'gateway',
      targetVersion: attempt.targetVersion,
      error: attempt.error,
      rolledBack: true,
      statusChanged: true,
    });
  }

  /** An admin saw the failed update, or starts a new one: stop reporting it. */
  async acknowledgeGatewayUpdateFailure(): Promise<boolean> {
    if (this.gatewayUpdateOperation?.status !== 'failed') return false;
    clearTimeout(this.failedReportTimer);
    this.gatewayUpdateOperation = null;
    await this.deleteSettings([GATEWAY_UPDATE_ATTEMPT_KEY]);
    // No `updating` flag: this must not end the update screen of a new attempt.
    this.events?.publish('system.update.changed', { component: 'gateway', statusChanged: true });
    return true;
  }

  private setGatewayUpdateOperation(operation: GatewayUpdateOperation | null): void {
    if (operation) clearTimeout(this.failedReportTimer);
    this.gatewayUpdateOperation = operation;
    if (operation) {
      this.events?.publish('system.update.changed', {
        updating: true,
        component: 'gateway',
        targetVersion: operation.targetVersion,
        statusChanged: true,
      });
    }
  }

  /**
   * A restart interrupts blue/green deployments, drains, Availability and
   * Compose operations, build rollouts and Docker migrations. Hold new ones
   * and wait for those running, up to the longest announced operation deadline
   * (15 minutes by default) or until the operator chooses to update now.
   * Durable recovery resumes whatever still runs at the handoff.
   */
  private async waitForOrchestrationOperations(targetVersion: string): Promise<void> {
    const source = this.orchestration;
    if (!source) return;
    const held = source.setOrchestrationAdmissionHold(
      `Gateway is updating to ${targetVersion}. Start this operation again once the update has finished.`
    );
    const override = new AbortController();
    this.operationWaitOverride = override;
    const startedAt = this.gatewayUpdateOperation?.startedAt ?? new Date().toISOString();
    try {
      const result = await waitForOrchestrationIdle(source, {
        scope: 'all',
        deadline: 'auto',
        signal: override.signal,
        onProgress: (operations, deadline) =>
          this.setGatewayUpdateOperation({
            status: 'waiting_for_operations',
            targetVersion,
            startedAt,
            waitDeadline: new Date(deadline).toISOString(),
            operations,
          }),
      });
      if (result.outcome === 'deadline' || result.outcome === 'override') {
        logger.warn('Gateway update proceeds while orchestration operations still run; recovery resumes them', {
          targetVersion,
          reason: result.outcome,
          operations: result.operations,
        });
      } else if (result.outcome === 'unsupported' || !held) {
        logger.info('Installed private core cannot report orchestration operations; the update does not wait', {
          targetVersion,
        });
      }
    } finally {
      this.operationWaitOverride = null;
      this.setGatewayUpdateOperation({
        status: 'updating',
        targetVersion,
        startedAt,
        waitDeadline: null,
        operations: [],
      });
    }
  }

  private async performGatewayUpdate(
    targetVersion: string,
    artifact: TrustedGatewayUpdateArtifact,
    userId: string | null
  ): Promise<void> {
    logger.info('Starting self-update', { targetVersion });

    const selfInfo = await this.dockerService.inspectSelf();
    const labels = selfInfo.Config.Labels;

    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    const composeProject = labels['com.docker.compose.project'];

    if (!composeDir) throw new Error('Cannot determine compose project directory');
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) throw new Error(`Invalid compose directory path: ${composeDir}`);
    if (!composeProject) throw new Error('Cannot determine compose project name from container labels');
    if (!/^[a-zA-Z0-9_-]+$/.test(composeProject)) throw new Error(`Invalid compose project name: ${composeProject}`);

    const currentImage = selfInfo.Config.Image;
    const imageBase = imageRepositoryFromRef(currentImage);

    logger.info('Update context', {
      composeDir,
      composeProject,
      imageBase,
      targetVersion,
      imageRef: artifact.imageRef,
    });

    if (!parseSemver(targetVersion)) throw new Error(`Invalid version format: ${targetVersion}`);

    const tag = normalizeVersionTag(targetVersion);
    if (!this.gatewayImageRepositories(imageBase).includes(artifact.payload.image)) {
      throw new Error(`Signed update image ${artifact.payload.image} is not an allowed Gateway image repository`);
    }
    if (artifact.payload.version !== tag) {
      throw new Error(`Signed update version ${artifact.payload.version} does not match requested ${tag}`);
    }

    await this.dockerService.pullImageRef(artifact.imageRef);

    await this.dockerService.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);

    // Before anything on the host changes: a restart during the wait keeps the current version.
    await this.waitForOrchestrationOperations(tag);

    // From here on a restart can leave the previous version running. The next
    // process reads this record and reports the attempt instead of hiding it.
    const attempt: GatewayUpdateAttempt = {
      targetVersion: tag,
      fromVersion: this.getCurrentVersion(),
      startedAt: this.gatewayUpdateOperation?.startedAt ?? new Date().toISOString(),
      userId,
      sidecarId: null,
      failedAt: null,
      error: null,
    };
    await this.upsertSetting(GATEWAY_UPDATE_ATTEMPT_KEY, attempt);

    // The legacy settings migration below rewrites .env. Keep the untouched
    // files, so every rollback (here and in the sidecar) restores them.
    const backupDir = await this.backupFoundationFiles(composeDir);

    logger.info('Migrating legacy environment-owned Gateway settings');
    const settingsMigration = await this.dockerService.runOneShot({
      Image: artifact.imageRef,
      Cmd: ['node', 'dist/cli/migrate-legacy-settings.js', '/host'],
      Env: legacySettingsMigrationEnv(this.env),
      HostConfig: {
        Binds: [`${composeDir}:/host`],
        ...(selfInfo.HostConfig?.NetworkMode ? { NetworkMode: selfInfo.HostConfig.NetworkMode } : {}),
      },
    });
    if (settingsMigration.exitCode !== 0) {
      await this.restoreAfterFailedMigration(artifact.imageRef, composeDir, backupDir);
      throw new Error(`Legacy settings migration failed: ${settingsMigration.output}`);
    }

    logger.info('Running foundation migrations from target image', {
      composeDir,
      envTag: tag,
      imageRef: artifact.imageRef,
    });
    const foundationCommand = [
      'node',
      'dist/foundation-migrator.js',
      '--host-dir',
      '/host',
      '--target-version',
      tag,
      '--image-ref',
      artifact.imageRef,
      ...(artifact.secureLinkConnectorImage
        ? ['--secure-link-connector-image', artifact.secureLinkConnectorImage]
        : []),
    ];
    const migrationResult = await this.dockerService.runOneShot({
      Image: artifact.imageRef,
      Cmd: foundationCommand,
      HostConfig: {
        Binds: [`${composeDir}:/host`, `${DEFAULT_SANDBOX_WORKSPACE_DIR}:${DEFAULT_SANDBOX_WORKSPACE_DIR}`],
      },
    });

    if (migrationResult.exitCode !== 0) {
      await this.restoreAfterFailedMigration(artifact.imageRef, composeDir, backupDir);
      throw new Error(`Foundation migration failed: ${migrationResult.output}`);
    }
    const migrationOutput = parseFoundationMigrationOutput(migrationResult.output);

    const workspaceResult = await this.prepareSandboxWorkspaceDir(
      artifact.imageRef,
      composeDir,
      backupDir,
      migrationOutput.sandboxWorkspaceDir
    );
    if (workspaceResult) throw workspaceResult;

    logger.info('Validating migrated docker-compose.yml');
    const composeConfigResult = await this.dockerService.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'docker',
        'compose',
        '--project-name',
        composeProject,
        '-f',
        '/project/docker-compose.yml',
        'config',
        '--quiet',
      ],
      HostConfig: { Binds: [`${composeDir}:/project`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });

    if (composeConfigResult.exitCode !== 0) {
      const rollbackError = await this.rollbackFoundationMigration(artifact.imageRef, composeDir, backupDir).catch(
        (error) => error as Error
      );
      if (rollbackError) {
        throw new Error(
          `Migrated docker-compose.yml failed validation and rollback failed: ${composeConfigResult.output}; rollback: ${formatError(rollbackError)}`
        );
      }
      throw new Error(`Migrated docker-compose.yml failed validation: ${composeConfigResult.output}`);
    }

    logger.info('Foundation files migrated, launching compose sidecar');

    // The pre-update backup holds .env and docker-compose.yml as they were
    // before any migration, including the legacy settings removal.
    const sidecarBackupDir = backupDir.replace(/^\/host(?=\/)/, composeDir);
    const expectedBackupPrefix = `${composeDir}/.gateway-foundation-backups/`;
    if (
      !sidecarBackupDir.startsWith(expectedBackupPrefix) ||
      !/^[a-zA-Z0-9_.-]+$/.test(sidecarBackupDir.slice(expectedBackupPrefix.length))
    ) {
      throw new Error(`Refusing to launch update with unexpected foundation backup path: ${sidecarBackupDir}`);
    }

    const sidecarId = await this.dockerService.runDetached({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'sh',
        '-c',
        `set -eu
compose() { docker compose --project-name ${composeProject} --project-directory ${composeDir} -f ${composeDir}/docker-compose.yml "$@"; }
service_exists() { compose config --services | grep -qx "$1"; }
ensure_foundation_services() {
  for service in $(compose config --services); do
    [ "$service" = app ] && continue
    compose up -d --no-recreate "$service"
  done
}
registry_ready() {
  if ! service_exists registry; then return 0; fi
  registry_id="$(compose ps -q registry)"
  [ -n "$registry_id" ] || return 1
  registry_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$registry_id")"
  [ "$registry_health" = healthy ]
}
relay_reachable() {
  compose exec -T app node -e 'const net=require("node:net");const socket=net.connect(9443,"relay",()=>{socket.end();process.exit(0)});socket.setTimeout(3000,()=>{socket.destroy();process.exit(1)});socket.on("error",()=>process.exit(1));'
}
rollback() {
  if [ -n "$FOUNDATION_BACKUP_DIR" ]; then
    if [ -f "$FOUNDATION_BACKUP_DIR/.env" ]; then
      cp -p "$FOUNDATION_BACKUP_DIR/.env" ${composeDir}/.env
    fi
    if [ -f "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ]; then
      cp -p "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ${composeDir}/docker-compose.yml
    fi
  fi
  rollback_has_relay=0
  if service_exists relay; then rollback_has_relay=1; fi
  compose stop app
  compose up -d postgres
  attempt=0
  until compose exec -T postgres pg_isready -U gateway -d gateway; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ]
    sleep 2
  done
  attempt=0
  until compose exec -T postgres psql -v ON_ERROR_STOP=1 -U gateway -d gateway -c 'BEGIN; CREATE OR REPLACE VIEW "public"."gateway_relay_node_identities_v1" WITH (security_barrier = true) AS SELECT "id" AS "node_id", "type"::text AS "node_type", "status"::text AS "node_status", "certificate_serial" FROM "public"."nodes"; CREATE OR REPLACE VIEW "public"."gateway_relay_managed_databases_v1" WITH (security_barrier = true) AS SELECT "id" AS "managed_database_id", "node_id" AS "database_node_id", "status"::text AS "database_status" FROM "public"."managed_database_instances"; CREATE OR REPLACE VIEW "public"."gateway_relay_bindings_v1" WITH (security_barrier = true) AS SELECT binding."id" AS "binding_id", binding."managed_database_id", binding."target_node_id" AS "source_node_id", binding."status"::text AS "binding_status", managed."node_id" AS "database_node_id", managed."status"::text AS "database_status" FROM "public"."managed_database_bindings" binding INNER JOIN "public"."managed_database_instances" managed ON managed."id" = binding."managed_database_id"; COMMIT;'; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 10 ]
    sleep 2
  done
  ensure_foundation_services
  if [ "$rollback_has_relay" -eq 1 ]; then
    compose up -d --no-deps app
  else
    compose up -d app
  fi
  attempt=0
  while [ "$attempt" -lt 150 ]; do
    app_id="$(compose ps -q app)"
    if [ -n "$app_id" ]; then
      app_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id")"
      if [ "$rollback_has_relay" -eq 0 ] && [ "$app_health" = healthy ] && registry_ready; then return 0; fi
      if [ "$rollback_has_relay" -eq 1 ]; then
        relay_id="$(compose ps -q relay)"
        if [ -n "$relay_id" ]; then
          relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
          if [ "$app_health" = healthy ] && [ "$relay_health" = healthy ] && relay_reachable && registry_ready; then return 0; fi
        fi
      fi
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}
on_exit() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then rollback; fi
  exit "$code"
}
trap on_exit EXIT
sleep 2
ensure_foundation_services
if service_exists relay; then
  compose up -d --no-deps --force-recreate app
else
  compose up -d --force-recreate app
fi
attempt=0
while [ "$attempt" -lt 150 ]; do
  app_id="$(compose ps -q app)"
  relay_id="$(compose ps -q relay)"
  if [ -n "$app_id" ] && [ -n "$relay_id" ]; then
    app_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id")"
    relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
    if [ "$app_health" = healthy ] && [ "$relay_health" = healthy ]; then
      app_working_dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$app_id")"
      relay_working_dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$relay_id")"
      relay_networks="$(docker inspect --format '{{len .NetworkSettings.Networks}}' "$relay_id")"
      relay_public_port="$(docker port "$relay_id" 9443/tcp)"
      # Health states alone do not prove that Compose preserved ownership,
      # attached the relay network, published 9443, or connected app -> relay.
      if [ "$app_working_dir" = ${composeDir} ] && [ "$relay_working_dir" = ${composeDir} ] && [ "$relay_networks" -gt 0 ] && [ -n "$relay_public_port" ] && relay_reachable && registry_ready; then
        exit 0
      fi
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
exit 1`,
      ],
      Env: [`FOUNDATION_BACKUP_DIR=${sidecarBackupDir}`],
      HostConfig: { Binds: [`${composeDir}:${composeDir}`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });

    logger.info('Update sidecar launched — container will be replaced shortly');
    // Lets a failure report point at the sidecar logs; the attempt is already recorded.
    await this.upsertSetting(GATEWAY_UPDATE_ATTEMPT_KEY, { ...attempt, sidecarId }).catch(() => undefined);
  }

  /** Copies .env and docker-compose.yml into a new backup directory; returns it as seen under /host. */
  private async backupFoundationFiles(composeDir: string): Promise<string> {
    const name = `pre-update-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const backupDir = `/host/.gateway-foundation-backups/${name}`;
    const result = await this.dockerService.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'sh',
        '-c',
        `set -eu
backup="$FOUNDATION_BACKUP_DIR"
mkdir -p "$backup"
chmod 700 "$backup"
[ ! -f /host/.env ] || cp -p /host/.env "$backup/.env"
[ ! -f /host/docker-compose.yml ] || cp -p /host/docker-compose.yml "$backup/docker-compose.yml"`,
      ],
      Env: [`FOUNDATION_BACKUP_DIR=${backupDir}`],
      HostConfig: { Binds: [`${composeDir}:/host`] },
    });
    if (result.exitCode !== 0) throw new Error(`Pre-update backup failed: ${result.output}`);
    return backupDir;
  }

  /** A failed migration may have rewritten .env already. Restore it, keep the original error. */
  private async restoreAfterFailedMigration(imageRef: string, composeDir: string, backupDir: string): Promise<void> {
    await this.rollbackFoundationMigration(imageRef, composeDir, backupDir).catch((error) =>
      logger.error('Could not restore the Gateway foundation files after a failed migration', {
        backupDir,
        error: formatError(error),
      })
    );
  }

  async performRelayUpdate(
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact,
    userId = 'system'
  ): Promise<void> {
    if (!this.relayPoolRuntime) {
      await this.performLocalRelayUpdate(targetVersion, artifact, true);
      return;
    }
    if (this.relayPoolRun) throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A Relay Pool update is already in progress');
    const control = new AbortController();
    this.relayPoolRun = control;
    try {
      await this.performRelayPoolUpdate(this.relayPoolRuntime, targetVersion, artifact, userId, control.signal);
    } finally {
      if (this.relayPoolRun === control) this.relayPoolRun = null;
    }
  }

  private async performRelayPoolUpdate(
    runtime: RelayPoolUpdateRuntime,
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact,
    userId: string,
    signal: AbortSignal
  ): Promise<void> {
    const run = await this.ensureRelayPoolUpdateRun(targetVersion, artifact);
    let currentStepId: string | null = null;
    // Drained by this call and not resumed yet; released if the run is abandoned.
    let drainedInstanceId: string | null = null;
    const throwIfAbandoned = () => {
      if (signal.aborted) throw new RelayPoolUpdateAbandonedError();
    };
    try {
      await this.db
        .update(relayPoolUpdateRuns)
        .set({ state: 'updating', terminalError: null, updatedAt: new Date() })
        .where(eq(relayPoolUpdateRuns.id, run.id));
      const steps = await this.db
        .select()
        .from(relayPoolUpdateSteps)
        .where(eq(relayPoolUpdateSteps.runId, run.id))
        .orderBy(relayPoolUpdateSteps.sequence);
      for (const step of steps.filter(({ state }) => !['ready', 'rolled_back'].includes(state))) {
        throwIfAbandoned();
        currentStepId = step.id;
        const [instance] = await this.db
          .select()
          .from(relayInstances)
          .where(eq(relayInstances.id, step.relayInstanceId))
          .limit(1);
        if (!instance) throw new Error(`Relay instance ${step.relayInstanceId} is unavailable`);
        if (instance.kind === 'local') {
          await this.updatePoolStep(step.id, 'updating');
          await this.performLocalRelayUpdate(targetVersion, artifact, false);
          await this.updatePoolStep(step.id, 'ready', true);
          currentStepId = null;
          continue;
        }
        if (!instance.nodeId) throw new Error(`Relay instance ${instance.id} is not enrolled`);
        await this.updatePoolStep(step.id, 'draining', false, new Date(Date.now() + 30 * 60 * 1000));
        drainedInstanceId = instance.id;
        await runtime.drainInstance(instance.id, userId, true);
        const drained = await this.waitForRelayInstanceDrain(instance.id, 30 * 60 * 1000, signal);
        if (!drained) {
          await this.db
            .update(relayPoolUpdateRuns)
            .set({ state: 'paused', terminalError: 'Relay drain is waiting for active streams', updatedAt: new Date() })
            .where(eq(relayPoolUpdateRuns.id, run.id));
          throw new Error(`Relay ${instance.displayName} still has active streams; rollout paused`);
        }
        throwIfAbandoned();
        await this.updatePoolStep(step.id, 'updating');
        const architecture = this.relayInstanceArchitecture(instance);
        const normalizedVersion = normalizeVersionTag(targetVersion);
        const workerArtifact = await runtime.prepareWorkerUpdate(normalizedVersion, architecture);
        await runtime.dispatchWorkerUpdate(instance.nodeId, workerArtifact);
        const supervisorArtifact = await runtime.prepareSupervisorUpdate(normalizedVersion, architecture);
        await runtime.dispatchSupervisorUpdate(instance.nodeId, supervisorArtifact);
        await this.updatePoolStep(step.id, 'verifying');
        await Promise.all([
          this.waitForRelayInstanceVersion(instance.id, normalizedVersion, signal),
          this.waitForRelaySupervisorVersion(instance.nodeId, normalizedVersion, signal),
        ]);
        await runtime.drainInstance(instance.id, userId, false);
        drainedInstanceId = null;
        await this.updatePoolStep(step.id, 'ready', true);
        currentStepId = null;
      }
      throwIfAbandoned();
      await this.promoteRelayConnectorImages(artifact);
      // An abandoned or recovered run stays failed.
      await this.db
        .update(relayPoolUpdateRuns)
        .set({ state: 'complete', completedAt: new Date(), terminalError: null, updatedAt: new Date() })
        .where(and(eq(relayPoolUpdateRuns.id, run.id), eq(relayPoolUpdateRuns.state, 'updating')));
    } catch (error) {
      const message = formatError(error);
      const [current] = await this.db
        .select({ state: relayPoolUpdateRuns.state })
        .from(relayPoolUpdateRuns)
        .where(eq(relayPoolUpdateRuns.id, run.id))
        .limit(1);
      if (current?.state !== 'paused' && current?.state !== 'failed') {
        if (currentStepId) {
          await this.db
            .update(relayPoolUpdateSteps)
            .set({ state: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() })
            .where(eq(relayPoolUpdateSteps.id, currentStepId));
        }
        await this.db
          .update(relayPoolUpdateRuns)
          .set({ state: 'failed', terminalError: message, updatedAt: new Date() })
          .where(eq(relayPoolUpdateRuns.id, run.id));
      }
      // A failed run (verify timeout, dispatch error, abandon) gives back the drain it took, as
      // restart recovery does; operator drains stay. A paused run keeps draining toward a resume.
      // Abandoning released the drains it knew about; an aborted run's drain may have begun meanwhile.
      if (drainedInstanceId && (signal.aborted || current?.state !== 'paused')) {
        this.scheduleRelayDrainRelease([drainedInstanceId], userId);
      }
      throw error;
    }
  }

  private async performLocalRelayUpdate(
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact,
    promoteConnectors: boolean
  ): Promise<void> {
    const version = normalizeVersionTag(targetVersion);
    const selfInfo = await this.dockerService.inspectSelf();
    const labels = selfInfo.Config.Labels;
    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    const composeProject = labels['com.docker.compose.project'];
    if (!composeDir || !/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) throw new Error('Invalid Compose directory');
    if (!composeProject || !/^[a-zA-Z0-9_-]+$/.test(composeProject)) throw new Error('Invalid Compose project');
    const relayImageRepositories = this.gatewayImageRepositories(imageRepositoryFromRef(selfInfo.Config.Image)).map(
      (gatewayImage) => `${gatewayImage}/relay`
    );
    if (artifact.payload.version !== version || !relayImageRepositories.includes(artifact.payload.image)) {
      throw new Error('Signed relay artifact does not match the requested release');
    }

    await this.dockerService.pullImageRef(artifact.imageRef);
    await this.dockerService.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);
    const migrationResult = await this.dockerService.runOneShot({
      Image: selfInfo.Config.Image,
      Cmd: [
        'node',
        'dist/foundation-migrator.js',
        '--host-dir',
        '/host',
        '--relay-build-version',
        artifact.buildVersion,
        '--relay-protocol-major',
        String(artifact.protocolMajor),
        '--relay-image-ref',
        artifact.imageRef,
        '--secure-link-connector-image',
        artifact.secureLinkConnectorImage,
      ],
      HostConfig: { Binds: [`${composeDir}:/host`] },
    });
    if (migrationResult.exitCode !== 0) throw new Error(`Relay foundation migration failed: ${migrationResult.output}`);
    const migrationOutput = parseFoundationMigrationOutput(migrationResult.output);

    const configResult = await this.dockerService.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'docker',
        'compose',
        '--project-name',
        composeProject,
        '-f',
        '/project/docker-compose.yml',
        'config',
        '--quiet',
      ],
      HostConfig: { Binds: [`${composeDir}:/project`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });
    if (configResult.exitCode !== 0) {
      await this.rollbackFoundationMigration(selfInfo.Config.Image, composeDir, migrationOutput.backupDir);
      throw new Error(`Migrated docker-compose.yml failed validation: ${configResult.output}`);
    }

    if (migrationOutput.backupDir && !migrationOutput.backupDir.startsWith('/host/.gateway-foundation-backups/')) {
      throw new Error(`Refusing to use unexpected relay foundation backup path: ${migrationOutput.backupDir}`);
    }
    const backupDir = migrationOutput.backupDir?.replace(/^\/host(?=\/)/, composeDir) ?? '';
    await this.relayRuntime?.setMaintenance(true);
    try {
      const result = await this.dockerService.runOneShot({
        Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
        Cmd: [
          'sh',
          '-c',
          `set -eu
compose() { docker compose --project-name ${composeProject} --project-directory ${composeDir} -f ${composeDir}/docker-compose.yml "$@"; }
relay_reachable() {
  compose exec -T app node -e 'const net=require("node:net");const socket=net.connect(9443,"relay",()=>{socket.end();process.exit(0)});socket.setTimeout(3000,()=>{socket.destroy();process.exit(1)});socket.on("error",()=>process.exit(1));'
}
rollback() {
  if [ -n "$FOUNDATION_BACKUP_DIR" ]; then
    [ ! -f "$FOUNDATION_BACKUP_DIR/.env" ] || cp -p "$FOUNDATION_BACKUP_DIR/.env" ${composeDir}/.env
    [ ! -f "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ] || cp -p "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ${composeDir}/docker-compose.yml
  fi
  compose up -d --no-deps --force-recreate relay
}
on_exit() { code=$?; trap - EXIT; if [ "$code" -ne 0 ]; then rollback; fi; exit "$code"; }
trap on_exit EXIT
compose up -d --no-deps --force-recreate relay
attempt=0
while [ "$attempt" -lt 90 ]; do
  relay_id="$(compose ps -q relay)"
  if [ -n "$relay_id" ]; then
    relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
    if [ "$relay_health" = healthy ] && relay_reachable; then exit 0; fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
exit 1`,
        ],
        Env: [`FOUNDATION_BACKUP_DIR=${backupDir}`],
        HostConfig: { Binds: [`${composeDir}:${composeDir}`, '/var/run/docker.sock:/var/run/docker.sock'] },
      });
      if (result.exitCode !== 0) throw new Error(`Relay update failed and was rolled back: ${result.output}`);

      Object.assign(this.env, {
        GATEWAY_RELAY_IMAGE_REF: artifact.imageRef,
        GATEWAY_RELAY_BUILD_VERSION: artifact.buildVersion,
        GATEWAY_RELAY_PROTOCOL_MAJOR: artifact.protocolMajor,
      });
      this.relayRuntime?.setExpectedArtifact(artifact.imageRef, artifact.buildVersion, artifact.protocolMajor);
      await saveInstalledRelayArtifact(this.db, {
        imageRef: artifact.imageRef,
        buildVersion: artifact.buildVersion,
        protocolMajor: artifact.protocolMajor,
        secureLinkConnectorImage: artifact.secureLinkConnectorImage,
      }).catch((error) => {
        logger.error('Failed to persist the installed Relay artifact after a successful update', { error });
      });
      if (promoteConnectors) await this.promoteRelayConnectorImages(artifact);
    } finally {
      await this.relayRuntime?.setMaintenance(false);
    }
    await this.relayRuntime?.probeNow();
  }

  private async promoteRelayConnectorImages(artifact: TrustedRelayUpdateArtifact): Promise<void> {
    Object.assign(this.env, {
      SECURE_LINK_CONNECTOR_IMAGE: artifact.secureLinkConnectorImage,
    });
    await this.relayRuntime?.updateSecureLinkConnectorImage(artifact.secureLinkConnectorImage);
  }

  private async ensureRelayPoolUpdateRun(targetVersion: string, artifact: TrustedRelayUpdateArtifact) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      return this.ensureRelayPoolUpdateRunLocked(tx, targetVersion, artifact);
    });
  }

  private async ensureRelayPoolUpdateRunLocked(
    tx: DrizzleTransaction,
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact
  ) {
    const [existing] = await tx
      .select()
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [
            'preflight',
            'draining',
            'updating',
            'verifying',
            'paused',
            'rolling_back',
          ])
        )
      )
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    if (existing) {
      if (existing.targetArtifact.version !== normalizeVersionTag(targetVersion)) {
        throw new AppError(
          409,
          'UPDATE_IN_PROGRESS',
          `The Relay Pool update to ${existing.targetArtifact.version} has not finished. Retry or abandon it before updating to ${normalizeVersionTag(targetVersion)}.`
        );
      }
      return existing;
    }
    const instances = await tx
      .select()
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining', 'offline', 'error'])
        )
      );
    if (!instances.length) throw new Error('Relay Pool has no instances');
    const readyFaultDomains = new Set(
      instances.filter(({ state }) => state === 'ready').map(({ faultDomainId }) => faultDomainId)
    );
    if (instances.length > 1 && readyFaultDomains.size < 2) {
      throw new AppError(409, 'RELAY_UPDATE_CAPACITY_UNAVAILABLE', 'Two ready relay fault domains are required');
    }
    const [run] = await tx
      .insert(relayPoolUpdateRuns)
      .values({
        poolId: 'system',
        state: 'preflight',
        targetArtifact: {
          version: normalizeVersionTag(targetVersion),
          digest: artifact.digest,
          image: artifact.imageRef,
        },
        compatibility: { protocolMajor: artifact.protocolMajor, maxUnavailable: 1, parallelism: 1 },
      })
      .returning();
    const ordered = [...instances].sort(
      (left, right) => Number(left.kind === 'local') - Number(right.kind === 'local')
    );
    await tx.insert(relayPoolUpdateSteps).values(
      ordered.map((instance, sequence) => ({
        runId: run.id,
        relayInstanceId: instance.id,
        sequence,
        previousArtifact: instance.buildVersion
          ? { version: instance.buildVersion, digest: '', architecture: this.relayInstanceArchitecture(instance) }
          : null,
        targetArtifact: {
          version: normalizeVersionTag(targetVersion),
          digest: artifact.digest,
          image: artifact.imageRef,
          architecture: this.relayInstanceArchitecture(instance),
        },
      }))
    );
    return run;
  }

  private async updatePoolStep(
    stepId: string,
    state: 'draining' | 'updating' | 'verifying' | 'ready',
    completed = false,
    drainDeadlineAt?: Date
  ): Promise<void> {
    await this.db
      .update(relayPoolUpdateSteps)
      .set({
        state,
        startedAt: new Date(),
        ...(drainDeadlineAt ? { drainDeadlineAt } : {}),
        ...(completed ? { completedAt: new Date() } : {}),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(relayPoolUpdateSteps.id, stepId));
  }

  private relayInstanceArchitecture(instance: typeof relayInstances.$inferSelect): string {
    return instance.capabilities?.architecture || 'amd64';
  }

  private async waitForRelayInstanceDrain(
    instanceId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
      const [instance] = await this.db
        .select({ activeTunnels: relayInstances.health })
        .from(relayInstances)
        .where(eq(relayInstances.id, instanceId))
        .limit(1);
      if (!instance) throw new Error(`Relay instance ${instanceId} disappeared while draining`);
      if (Number(instance.activeTunnels?.activeTunnels ?? 0) === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  }

  private async waitForRelayInstanceVersion(
    instanceId: string,
    targetVersion: string,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
      const [instance] = await this.db
        .select({
          state: relayInstances.state,
          buildVersion: relayInstances.buildVersion,
          lastSeenAt: relayInstances.lastSeenAt,
        })
        .from(relayInstances)
        .where(eq(relayInstances.id, instanceId))
        .limit(1);
      if (instance?.state === 'ready' && instance.buildVersion === targetVersion && instance.lastSeenAt) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Relay instance ${instanceId} did not become ready after update`);
  }

  private async waitForRelaySupervisorVersion(
    nodeId: string,
    targetVersion: string,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
      const [node] = await this.db
        .select({ status: nodes.status, daemonVersion: nodes.daemonVersion, lastSeenAt: nodes.lastSeenAt })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (node?.status === 'online' && node.daemonVersion === targetVersion && node.lastSeenAt) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Relay supervisor node ${nodeId} did not reconnect after update`);
  }

  /**
   * The operator's way out of a stuck or paused Relay Pool update: fail the
   * run, stop the rollout this process drives, and put drained relays back
   * into service. Relays drained by an operator stay drained.
   */
  async abandonRelayUpdate(userId: string): Promise<{ targetVersion: string | null }> {
    const [run] = await this.db
      .select()
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [...UNFINISHED_RELAY_POOL_RUN_STATES])
        )
      )
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    const operation = this.relayUpdateOperation;
    if (!run && operation?.status !== 'updating' && !this.relayPoolRun) {
      throw new AppError(409, 'RELAY_UPDATE_NOT_ACTIVE', 'No Relay Pool update is in progress');
    }
    const message = 'Abandoned by an administrator';
    this.relayPoolRun?.abort();
    const drained = run ? await this.failRelayPoolRun(run.id, message, UNFINISHED_RELAY_POOL_RUN_STATES) : [];
    if (operation?.status === 'updating')
      this.relayUpdateOperation = { ...operation, status: 'failed', error: message };
    if (drained.length) this.scheduleRelayDrainRelease(drained, userId);
    logger.warn('Relay Pool update abandoned', { runId: run?.id, userId, drainedInstances: drained });
    return { targetVersion: run?.targetArtifact.version ?? operation?.targetVersion ?? null };
  }

  private async recoverInterruptedRelayPoolUpdates(): Promise<void> {
    const interrupted = await this.db
      .select({ id: relayPoolUpdateRuns.id, targetArtifact: relayPoolUpdateRuns.targetArtifact })
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [...ACTIVE_RELAY_POOL_RUN_STATES])
        )
      );
    const drained = new Set<string>();
    for (const run of interrupted) {
      const message = 'Interrupted by a Gateway restart. Start the Relay Pool update again.';
      for (const instanceId of await this.failRelayPoolRun(run.id, message, ACTIVE_RELAY_POOL_RUN_STATES)) {
        drained.add(instanceId);
      }
      logger.warn('Failed a Relay Pool update interrupted by a Gateway restart', {
        runId: run.id,
        targetVersion: run.targetArtifact.version,
      });
      await this.audit
        ?.log({
          userId: null,
          action: 'system.relay_update.failed',
          resourceType: 'relay-update',
          resourceId: run.id,
          details: { targetVersion: run.targetArtifact.version, error: message },
        })
        .catch(() => undefined);
    }
    // Remote relays reconnect after this process starts; the release retries until they do.
    if (drained.size) this.scheduleRelayDrainRelease([...drained], null);
  }

  /** Fails the run and its in-flight steps. Returns the relays whose drain the update owned. */
  private async failRelayPoolRun(
    runId: string,
    message: string,
    fromStates: readonly (typeof UNFINISHED_RELAY_POOL_RUN_STATES)[number][]
  ): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      // The fence that serializes run creation and rebalance placement.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      const failed = await tx
        .update(relayPoolUpdateRuns)
        .set({ state: 'failed', terminalError: message, updatedAt: new Date() })
        .where(and(eq(relayPoolUpdateRuns.id, runId), inArray(relayPoolUpdateRuns.state, [...fromStates])))
        .returning({ id: relayPoolUpdateRuns.id });
      if (!failed.length) return [];
      const steps = await tx
        .update(relayPoolUpdateSteps)
        .set({ state: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(relayPoolUpdateSteps.runId, runId),
            inArray(relayPoolUpdateSteps.state, [...IN_FLIGHT_RELAY_POOL_STEP_STATES])
          )
        )
        .returning({
          relayInstanceId: relayPoolUpdateSteps.relayInstanceId,
          drainDeadlineAt: relayPoolUpdateSteps.drainDeadlineAt,
        });
      // Only remote steps drain; they record a drain deadline when they do.
      return steps.filter(({ drainDeadlineAt }) => drainDeadlineAt).map(({ relayInstanceId }) => relayInstanceId);
    });
  }

  private scheduleRelayDrainRelease(instanceIds: string[], userId: string | null, attempt = 1): void {
    void this.releaseRelayUpdateDrains(instanceIds, userId).then((pending) => {
      if (!pending.length) return;
      if (attempt >= RELAY_DRAIN_RELEASE_ATTEMPTS) {
        logger.error('Relays drained by a failed Relay Pool update are still drained; resume them on the Relay page', {
          instanceIds: pending,
        });
        return;
      }
      const timer = setTimeout(
        () => this.scheduleRelayDrainRelease(pending, userId, attempt + 1),
        RELAY_DRAIN_RELEASE_RETRY_MS
      );
      timer.unref?.();
    });
  }

  /** Resumes relays a failed update left drained. Returns those to retry. */
  private async releaseRelayUpdateDrains(instanceIds: string[], userId: string | null): Promise<string[]> {
    const runtime = this.relayPoolRuntime;
    if (!runtime) return [];
    const pending: string[] = [];
    for (const instanceId of instanceIds) {
      try {
        const [instance] = await this.db
          .select()
          .from(relayInstances)
          .where(eq(relayInstances.id, instanceId))
          .limit(1);
        // Operator drains are not the update's to release.
        if (!instance || instance.kind !== 'remote' || !instance.nodeId || instance.manualDrainStartedAt) continue;
        if (instance.state === 'ready' && instance.health?.admissionState !== 'draining') continue;
        if (await this.isRelayInstanceHeldByUnfinishedRun(instanceId)) continue;
        await runtime.drainInstance(instanceId, userId, false);
        logger.info('Resumed a relay drained by a failed Relay Pool update', { instanceId });
      } catch (error) {
        logger.warn('Could not resume a relay drained by a failed Relay Pool update yet', {
          instanceId,
          error: formatError(error),
        });
        pending.push(instanceId);
      }
    }
    return pending;
  }

  /** A newer run that drains the relay owns it now. */
  private async isRelayInstanceHeldByUnfinishedRun(instanceId: string): Promise<boolean> {
    const [held] = await this.db
      .select({ id: relayPoolUpdateSteps.id })
      .from(relayPoolUpdateSteps)
      .innerJoin(relayPoolUpdateRuns, eq(relayPoolUpdateSteps.runId, relayPoolUpdateRuns.id))
      .where(
        and(
          eq(relayPoolUpdateSteps.relayInstanceId, instanceId),
          inArray(relayPoolUpdateSteps.state, [...IN_FLIGHT_RELAY_POOL_STEP_STATES]),
          inArray(relayPoolUpdateRuns.state, [...UNFINISHED_RELAY_POOL_RUN_STATES])
        )
      )
      .limit(1);
    return Boolean(held);
  }

  private async getDurableRelayOperation(): Promise<RelayUpdateOperation | null> {
    if (!this.relayPoolRuntime) return null;
    const [latestRun] = await this.db
      .select()
      .from(relayPoolUpdateRuns)
      .where(eq(relayPoolUpdateRuns.poolId, 'system'))
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    const run = latestRun?.state === 'complete' ? undefined : latestRun;
    if (!run) return null;
    return {
      status: run.state === 'failed' || run.state === 'paused' ? 'failed' : 'updating',
      targetVersion: run.targetArtifact.version,
      startedAt: run.startedAt.toISOString(),
      error: run.terminalError,
    };
  }

  private async rollbackFoundationMigration(
    imageRef: string,
    composeDir: string,
    backupDir: string | null
  ): Promise<void> {
    if (!backupDir) return;
    if (!backupDir.startsWith('/host/.gateway-foundation-backups/')) {
      throw new Error(`Refusing to rollback unexpected foundation backup path: ${backupDir}`);
    }
    const result = await this.dockerService.runOneShot({
      Image: imageRef,
      Cmd: [
        'sh',
        '-c',
        `set -eu
backup="$FOUNDATION_BACKUP_DIR"
[ -f "$backup/.env" ] && cp -p "$backup/.env" /host/.env || true
[ -f "$backup/docker-compose.yml" ] && cp -p "$backup/docker-compose.yml" /host/docker-compose.yml || true`,
      ],
      Env: [`FOUNDATION_BACKUP_DIR=${backupDir}`],
      HostConfig: { Binds: [`${composeDir}:/host`] },
    });
    if (result.exitCode !== 0) throw new Error(`Foundation rollback failed: ${result.output}`);
  }

  private async prepareSandboxWorkspaceDir(
    imageRef: string,
    composeDir: string,
    backupDir: string | null,
    sandboxWorkspaceDir: string
  ): Promise<Error | null> {
    if (!sandboxWorkspaceDir.startsWith('/')) return null;
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(sandboxWorkspaceDir)) {
      const error = new Error(`Invalid sandbox workspace directory path: ${sandboxWorkspaceDir}`);
      const rollbackError = await this.rollbackFoundationMigration(imageRef, composeDir, backupDir).catch(
        (innerError) => innerError as Error
      );
      if (rollbackError) {
        return new Error(`${error.message}; rollback failed: ${formatError(rollbackError)}`);
      }
      return error;
    }

    const result = await this.dockerService.runOneShot({
      Image: imageRef,
      Cmd: ['sh', '-c', 'set -eu\nmkdir -p "$SANDBOX_WORKSPACE_DIR"\nchmod 700 "$SANDBOX_WORKSPACE_DIR"'],
      Env: [`SANDBOX_WORKSPACE_DIR=${sandboxWorkspaceDir}`],
      HostConfig: { Binds: [`${sandboxWorkspaceDir}:${sandboxWorkspaceDir}`] },
    });
    if (result.exitCode === 0) return null;

    const error = new Error(`Failed to prepare sandbox workspace directory: ${result.output}`);
    const rollbackError = await this.rollbackFoundationMigration(imageRef, composeDir, backupDir).catch(
      (innerError) => innerError as Error
    );
    if (rollbackError) return new Error(`${error.message}; rollback failed: ${formatError(rollbackError)}`);
    return error;
  }

  getGatewayManifestUrl(version: string): string {
    const tag = normalizeVersionTag(version);
    return this.getManifestSource('gateway', tag, 'gateway-image.update.json').url;
  }

  getRelayManifestUrl(version: string): string {
    const tag = `${normalizeVersionTag(version)}-relay`;
    return this.getManifestSource('relay', tag, 'relay-image.update.json').url;
  }

  private async upsertSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  private async deleteSettings(keys: string[]): Promise<void> {
    await this.db.delete(settings).where(inArray(settings.key, keys));
  }
}

function legacySettingsMigrationEnv(env: Env): string[] {
  const values: Record<string, string | number | boolean | undefined> = {
    NODE_ENV: env.NODE_ENV,
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    PKI_MASTER_KEY: env.PKI_MASTER_KEY,
  };
  return Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
}

function parseGatewayUpdateAttempt(value: unknown): GatewayUpdateAttempt | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null);
  const targetVersion = text('targetVersion');
  const startedAt = text('startedAt');
  if (!targetVersion || !startedAt) return null;
  return {
    targetVersion,
    fromVersion: text('fromVersion') ?? 'unknown',
    startedAt,
    userId: text('userId'),
    sidecarId: text('sidecarId'),
    failedAt: text('failedAt'),
    error: text('error'),
  };
}

function parseFoundationMigrationOutput(output: string): FoundationMigrationOutput {
  const line = output
    .trim()
    .split('\n')
    .reverse()
    .find((entry) => entry.trim().startsWith('{'));
  if (!line) throw new Error(`Foundation migration returned invalid output: ${output}`);
  const parsed = JSON.parse(line) as Partial<FoundationMigrationOutput>;
  if (
    parsed.ok !== true ||
    !Array.isArray(parsed.changedFiles) ||
    !('backupDir' in parsed) ||
    typeof parsed.sandboxWorkspaceDir !== 'string'
  ) {
    throw new Error(`Foundation migration returned invalid output: ${output}`);
  }
  return parsed as FoundationMigrationOutput;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function imageRepositoryFromRef(imageRef: string): string {
  const digestIndex = imageRef.indexOf('@');
  const withoutDigest = digestIndex >= 0 ? imageRef.slice(0, digestIndex) : imageRef;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  if (lastColon > lastSlash) return withoutDigest.slice(0, lastColon);
  return withoutDigest;
}

function normalizeVersionTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
