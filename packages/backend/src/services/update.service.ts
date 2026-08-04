import { inArray } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { DEFAULT_SANDBOX_WORKSPACE_DIR } from '@/foundation/foundation-migrator.js';
import { createChildLogger } from '@/lib/logger.js';
import { compareSemver, isNewerVersion, parseSemver } from '@/lib/semver.js';
import {
  normalizeGitLabApiUrl,
  type TrustedGatewayUpdateArtifact,
  verifyGatewayImageManifest,
} from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerService } from './docker.service.js';

const logger = createChildLogger('UpdateService');
const DOCKER_COMPOSE_CLI_IMAGE_REF =
  'docker.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  lastCheckedAt: string | null;
}

interface GitLabRelease {
  tag_name: string;
  description: string;
  _links: { self: string };
}

interface FoundationMigrationOutput {
  ok: true;
  changedFiles: string[];
  backupDir: string | null;
  sandboxWorkspaceDir: string;
}

export function isGatewayReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

export function selectLatestGatewayRelease(releases: GitLabRelease[]): GitLabRelease | null {
  const matching = releases
    .filter((release) => isGatewayReleaseTag(release.tag_name))
    .sort((a, b) => compareSemver(b.tag_name, a.tag_name));

  return matching[0] ?? null;
}

const SETTINGS_KEYS = {
  latestVersion: 'update:latest_version',
  lastCheckedAt: 'update:last_checked_at',
  releaseNotes: 'update:release_notes',
  releaseUrl: 'update:release_url',
} as const;

export class UpdateService {
  private readonly gitlabReleasesUrl: string;
  private readonly encodedProjectPath: string;
  private readonly gitlabApiUrl: string;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerService: DockerService,
    private readonly env: Env
  ) {
    this.gitlabApiUrl = normalizeGitLabApiUrl(this.env.GITLAB_API_URL);
    this.encodedProjectPath = encodeURIComponent(this.env.GITLAB_PROJECT_PATH);
    this.gitlabReleasesUrl = `${this.gitlabApiUrl}/api/v4/projects/${this.encodedProjectPath}/releases`;
  }

  getCurrentVersion(): string {
    return this.env.APP_VERSION;
  }

  async getCachedStatus(): Promise<UpdateStatus> {
    const currentVersion = this.getCurrentVersion();

    const allRows = await this.db
      .select()
      .from(settings)
      .where(inArray(settings.key, Object.values(SETTINGS_KEYS)));

    const map = new Map(allRows.map((r) => [r.key, r.value as string]));

    const latestVersion = map.get(SETTINGS_KEYS.latestVersion) ?? null;
    const updateAvailable =
      currentVersion !== 'dev' && latestVersion != null ? isNewerVersion(latestVersion, currentVersion) : false;

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseNotes: map.get(SETTINGS_KEYS.releaseNotes) ?? null,
      releaseUrl: map.get(SETTINGS_KEYS.releaseUrl) ?? null,
      lastCheckedAt: map.get(SETTINGS_KEYS.lastCheckedAt) ?? null,
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
      };
    }

    try {
      logger.debug('Checking GitLab for updates', { url: this.gitlabReleasesUrl });

      const response = await fetch(this.gitlabReleasesUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`GitLab API returned ${response.status}`);
      }

      const releases = (await response.json()) as GitLabRelease[];

      if (!releases.length) {
        logger.debug('No releases found');
        return this.getCachedStatus();
      }

      const latest = selectLatestGatewayRelease(releases);
      if (!latest) {
        logger.debug('No gateway releases found');
        return this.getCachedStatus();
      }

      const latestVersion = latest.tag_name;
      const releaseNotes = latest.description || null;
      const releaseUrl = latest._links?.self || null;

      // Persist release info to settings (lastCheckedAt already saved above)
      await this.upsertSetting(SETTINGS_KEYS.latestVersion, latestVersion);
      await this.upsertSetting(SETTINGS_KEYS.releaseNotes, releaseNotes ?? '');
      await this.upsertSetting(SETTINGS_KEYS.releaseUrl, releaseUrl ?? '');

      const updateAvailable = isNewerVersion(latestVersion, currentVersion);

      if (updateAvailable) {
        logger.info('Update available', { current: currentVersion, latest: latestVersion });
      } else {
        logger.debug('Already up to date', { current: currentVersion, latest: latestVersion });
      }

      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseNotes,
        releaseUrl,
        lastCheckedAt,
      };
    } catch (error) {
      logger.warn('Update check failed', { error });
      // Return cached status on failure
      return this.getCachedStatus();
    }
  }

  async getReleaseNotes(version: string): Promise<string> {
    const encodedPath = encodeURIComponent(this.env.GITLAB_PROJECT_PATH);
    const url = `${this.gitlabApiUrl}/api/v4/projects/${encodedPath}/releases/${encodeURIComponent(version)}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch release notes for ${version}: ${response.status}`);
    }

    const release = (await response.json()) as GitLabRelease;
    return release.description || '';
  }

  /**
   * Fetch release notes for all versions between `after` (exclusive) and `upTo` (inclusive).
   * Returns newest first.
   */
  async getReleaseNotesSince(after: string, upTo: string): Promise<{ version: string; notes: string }[]> {
    const response = await fetch(this.gitlabReleasesUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`GitLab API returned ${response.status}`);
    }

    const releases = (await response.json()) as GitLabRelease[];

    // Filter releases: newer than `after` and up to `upTo` (inclusive)
    return releases
      .filter((r) => {
        const tag = r.tag_name;
        return isGatewayReleaseTag(tag) && compareSemver(tag, after) > 0 && compareSemver(tag, upTo) <= 0;
      })
      .sort((a, b) => compareSemver(b.tag_name, a.tag_name))
      .map((r) => ({ version: r.tag_name, notes: r.description || '' }));
  }

  async prepareGatewayUpdate(targetVersion: string): Promise<TrustedGatewayUpdateArtifact> {
    const tag = normalizeVersionTag(targetVersion);
    const selfInfo = await this.dockerService.inspectSelf();
    const imageBase = imageRepositoryFromRef(selfInfo.Config.Image);
    const manifestUrl = this.getGatewayManifestUrl(tag);

    const response = await fetch(manifestUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        'UNTRUSTED_UPDATE_ARTIFACT',
        `Failed to fetch gateway update manifest: ${response.status}`
      );
    }

    const signedManifest = await response.text();
    let artifact: TrustedGatewayUpdateArtifact;
    try {
      artifact = verifyGatewayImageManifest(signedManifest, {
        version: tag,
        tag,
        image: imageBase,
      });
    } catch (error) {
      logger.warn('Gateway update manifest verification failed', {
        targetVersion,
        imageBase,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Gateway update artifact is not trusted');
    }

    return artifact;
  }

  async performUpdate(targetVersion: string, artifact: TrustedGatewayUpdateArtifact): Promise<void> {
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
    if (artifact.payload.image !== imageBase) {
      throw new Error(`Signed update image ${artifact.payload.image} does not match running image ${imageBase}`);
    }
    if (artifact.payload.version !== tag) {
      throw new Error(`Signed update version ${artifact.payload.version} does not match requested ${tag}`);
    }

    await this.dockerService.pullImageRef(artifact.imageRef);

    await this.dockerService.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);

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
      ...(artifact.databaseConnectorImage
        ? ['--database-connector-image', artifact.databaseConnectorImage]
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
      throw new Error(`Foundation migration failed: ${migrationResult.output}`);
    }
    const migrationOutput = parseFoundationMigrationOutput(migrationResult.output);

    const workspaceResult = await this.prepareSandboxWorkspaceDir(
      artifact.imageRef,
      composeDir,
      migrationOutput.backupDir,
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
      const rollbackError = await this.rollbackFoundationMigration(
        artifact.imageRef,
        composeDir,
        migrationOutput.backupDir
      ).catch((error) => error as Error);
      if (rollbackError) {
        throw new Error(
          `Migrated docker-compose.yml failed validation and rollback failed: ${composeConfigResult.output}; rollback: ${formatError(rollbackError)}`
        );
      }
      throw new Error(`Migrated docker-compose.yml failed validation: ${composeConfigResult.output}`);
    }

    logger.info('Foundation files migrated, launching compose sidecar');

    await this.dockerService.runDetached({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'sh',
        '-c',
        `sleep 2 && docker compose --project-name ${composeProject} -f /project/docker-compose.yml up -d --force-recreate app`,
      ],
      HostConfig: { Binds: [`${composeDir}:/project`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });

    logger.info('Update sidecar launched — container will be replaced shortly');
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
    return `${this.gitlabApiUrl}/api/v4/projects/${this.encodedProjectPath}/packages/generic/gateway/${tag}/gateway-image.update.json`;
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
}

function legacySettingsMigrationEnv(env: Env): string[] {
  const values: Record<string, string | number | boolean | undefined> = {
    NODE_ENV: env.NODE_ENV,
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    PKI_MASTER_KEY: env.PKI_MASTER_KEY,
    APP_URL: process.env.APP_URL,
    OIDC_ISSUER: env.OIDC_ISSUER,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI: env.OIDC_REDIRECT_URI,
    OIDC_SCOPES: env.OIDC_SCOPES,
    CLICKHOUSE_URL: env.CLICKHOUSE_URL,
    CLICKHOUSE_USERNAME: env.CLICKHOUSE_USERNAME,
    CLICKHOUSE_PASSWORD: env.CLICKHOUSE_PASSWORD,
    CLICKHOUSE_DATABASE: env.CLICKHOUSE_DATABASE,
    CLICKHOUSE_LOGS_TABLE: env.CLICKHOUSE_LOGS_TABLE,
    CLICKHOUSE_REQUEST_TIMEOUT_MS: env.CLICKHOUSE_REQUEST_TIMEOUT_MS,
    CLICKHOUSE_MANAGED_INTERNAL_LOGS: env.CLICKHOUSE_MANAGED_INTERNAL_LOGS,
  };
  return Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
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
