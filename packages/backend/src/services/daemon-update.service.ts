import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/nodes.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import { compareSemver, isNewerVersion } from '@/lib/semver.js';
import {
  normalizeGitLabApiUrl,
  type TrustedDaemonUpdateArtifact,
  trustedGitLabPackagePrefix,
  verifyDaemonUpdateManifest,
} from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('DaemonUpdateService');

export type DaemonType = 'nginx' | 'docker' | 'monitoring';

const DAEMON_TYPES: DaemonType[] = ['nginx', 'docker', 'monitoring'];

const TAG_SUFFIX_MAP: Record<DaemonType, string> = {
  nginx: '-nginx',
  docker: '-docker',
  monitoring: '-monitoring',
};

const DAEMON_NAME_MAP: Record<DaemonType, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  monitoring: 'monitoring-daemon',
};

export function isStableDaemonReleaseTag(tag: string, daemonType: DaemonType): boolean {
  const suffix = TAG_SUFFIX_MAP[daemonType].replace('-', '\\-');
  return new RegExp(`^v?\\d+\\.\\d+\\.\\d+${suffix}$`).test(tag);
}

/** Maps node.type values to daemon types */
export const NODE_TYPE_MAP: Record<string, DaemonType> = {
  nginx: 'nginx',
  docker: 'docker',
  // Database nodes run the same docker-daemon binary in its database-only profile.
  databases: 'docker',
  monitoring: 'monitoring',
};

export function daemonTypeForNodeType(nodeType: string): DaemonType | null {
  return NODE_TYPE_MAP[nodeType] ?? null;
}

interface GitLabRelease {
  tag_name: string;
  description: string;
  _links: { self: string };
}

export function selectLatestStableDaemonRelease(
  releases: GitLabRelease[],
  daemonType: DaemonType
): (GitLabRelease & { version: string }) | null {
  const suffix = TAG_SUFFIX_MAP[daemonType];
  const matching = releases
    .filter((release) => isStableDaemonReleaseTag(release.tag_name, daemonType))
    .map((release) => ({ ...release, version: release.tag_name.slice(0, -suffix.length) }))
    .sort((left, right) => compareSemver(right.version, left.version));
  return matching[0] ?? null;
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
  private readonly gitlabReleasesUrl: string;
  private readonly gitlabApiUrl: string;
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly env: Env
  ) {
    this.gitlabApiUrl = normalizeGitLabApiUrl(this.env.GITLAB_API_URL);
    const encodedPath = encodeURIComponent(this.env.GITLAB_PROJECT_PATH);
    this.gitlabReleasesUrl = `${this.gitlabApiUrl}/api/v4/projects/${encodedPath}/releases`;
  }

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  private emitNodeUpdated(nodeId: string) {
    this.eventBus?.publish('node.changed', { id: nodeId, action: 'updated' });
  }

  async checkForUpdates(): Promise<DaemonUpdateStatus[]> {
    const lastCheckedAt = new Date().toISOString();

    try {
      const response = await fetch(this.gitlabReleasesUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`GitLab API returned ${response.status}`);
      }

      const releases = (await response.json()) as GitLabRelease[];

      // Find latest release per daemon type
      for (const type of DAEMON_TYPES) {
        const latest = selectLatestStableDaemonRelease(releases, type);
        if (latest) {
          await this.upsertSetting(`daemon-update:${type}:latest_version`, latest.version);
          await this.upsertSetting(`daemon-update:${type}:latest_tag`, latest.tag_name);
          await this.upsertSetting(`daemon-update:${type}:release_notes`, latest.description || '');
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

    // Fetch all nodes
    const allNodes = await this.db.select().from(nodes);

    for (const type of DAEMON_TYPES) {
      const latestVersion = await this.getSetting(`daemon-update:${type}:latest_version`);
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
    return metadata.updateInProgress === true;
  }

  async markNodeUpdateInProgress(nodeId: string, targetVersion: string): Promise<void> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress === true) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is already in progress');
    }

    metadata.updateInProgress = true;
    metadata.updateTargetVersion = targetVersion;
    metadata.updateStartedAt = new Date().toISOString();

    await this.db.update(nodes).set({ metadata, updatedAt: new Date() }).where(eq(nodes.id, nodeId));

    this.emitNodeUpdated(nodeId);
  }

  async clearNodeUpdateInProgress(nodeId: string): Promise<void> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return;

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true) return;

    delete metadata.updateInProgress;
    delete metadata.updateTargetVersion;
    delete metadata.updateStartedAt;

    await this.db.update(nodes).set({ metadata, updatedAt: new Date() }).where(eq(nodes.id, nodeId));

    this.emitNodeUpdated(nodeId);
  }

  async clearNodeUpdateInProgressOnReconnect(nodeId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true) return false;

    delete metadata.updateInProgress;
    delete metadata.updateTargetVersion;
    delete metadata.updateStartedAt;

    await this.db.update(nodes).set({ metadata, updatedAt: new Date() }).where(eq(nodes.id, nodeId));

    this.emitNodeUpdated(nodeId);
    return true;
  }

  getDownloadUrl(daemonType: DaemonType, tag: string, arch: string): string {
    const daemonName = DAEMON_NAME_MAP[daemonType];
    const encodedPath = encodeURIComponent(this.env.GITLAB_PROJECT_PATH);
    return `${this.gitlabApiUrl}/api/v4/projects/${encodedPath}/packages/generic/${daemonName}/${tag}/${this.getBinaryName(daemonType, arch)}`;
  }

  async prepareTrustedDaemonUpdate(
    daemonType: DaemonType,
    tag: string,
    version: string,
    arch: string
  ): Promise<TrustedDaemonUpdateArtifact> {
    const normalizedArch = this.normalizePackageArch(arch);
    const artifactName = this.getBinaryName(daemonType, normalizedArch);
    const downloadUrl = this.getDownloadUrl(daemonType, tag, normalizedArch);
    const manifestUrl = this.getManifestUrl(daemonType, tag, normalizedArch);

    const response = await fetch(manifestUrl, {
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
        downloadUrl,
        trustedPackagePrefix: trustedGitLabPackagePrefix(this.gitlabApiUrl, this.env.GITLAB_PROJECT_PATH),
      });
    } catch (error) {
      logger.warn('Daemon update manifest verification failed', {
        daemonType,
        tag,
        arch: normalizedArch,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Daemon update artifact is not trusted');
    }
  }

  getManifestUrl(daemonType: DaemonType, tag: string, arch: string): string {
    const daemonName = DAEMON_NAME_MAP[daemonType];
    const encodedPath = encodeURIComponent(this.env.GITLAB_PROJECT_PATH);
    return `${this.gitlabApiUrl}/api/v4/projects/${encodedPath}/packages/generic/${daemonName}/${tag}/${this.getBinaryName(daemonType, arch)}.update.json`;
  }

  getBinaryName(daemonType: DaemonType, arch: string): string {
    const daemonName = DAEMON_NAME_MAP[daemonType];
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
}
