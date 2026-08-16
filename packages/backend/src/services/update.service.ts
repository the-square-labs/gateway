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
  type TrustedRelayUpdateArtifact,
  verifyGatewayImageManifest,
  verifyRelayImageManifest,
} from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerService } from './docker.service.js';

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

export interface RelayUpdateRuntime {
  setMaintenance(enabled: boolean): Promise<void>;
  setExpectedArtifact(imageRef: string, buildVersion: string, protocolMajor: number): void;
  probeNow(): Promise<void>;
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

export function isRelayReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+-relay$/.test(tag);
}

export function selectLatestRelayRelease(releases: GitLabRelease[]): GitLabRelease | null {
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
  if (current[0] < target[0]) return true;
  if (current[0] > target[0]) return false;
  return target[1] - current[1] >= 2;
}

const SETTINGS_KEYS = {
  latestVersion: 'update:latest_version',
  lastCheckedAt: 'update:last_checked_at',
  releaseNotes: 'update:release_notes',
  releaseUrl: 'update:release_url',
  relayLatestVersion: 'update:relay:latest_version',
  relayReleaseNotes: 'update:relay:release_notes',
  relayReleaseUrl: 'update:relay:release_url',
} as const;

export class UpdateService {
  private readonly gitlabReleasesUrl: string;
  private readonly encodedProjectPath: string;
  private readonly gitlabApiUrl: string;
  private relayUpdateOperation: RelayUpdateOperation | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerService: DockerService,
    private readonly env: Env,
    private readonly relayRuntime?: RelayUpdateRuntime
  ) {
    this.gitlabApiUrl = normalizeGitLabApiUrl(this.env.GITLAB_API_URL);
    this.encodedProjectPath = encodeURIComponent(this.env.GITLAB_PROJECT_PATH);
    this.gitlabReleasesUrl = `${this.gitlabApiUrl}/api/v4/projects/${this.encodedProjectPath}/releases?per_page=100`;
  }

  getCurrentVersion(): string {
    return this.env.APP_VERSION;
  }

  startRelayUpdate(targetVersion: string): void {
    if (this.relayUpdateOperation?.status === 'updating') {
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

    const allRows = await this.db
      .select()
      .from(settings)
      .where(inArray(settings.key, Object.values(SETTINGS_KEYS)));

    const map = new Map(allRows.map((r) => [r.key, r.value as string]));

    const latestVersion = map.get(SETTINGS_KEYS.latestVersion) ?? null;
    const gatewayUpdateAvailable =
      currentVersion !== 'dev' && latestVersion != null ? isNewerVersion(latestVersion, currentVersion) : false;
    const currentRelayVersion = this.env.GATEWAY_RELAY_BUILD_VERSION ?? 'unknown';
    const latestRelayVersion = map.get(SETTINGS_KEYS.relayLatestVersion) ?? null;
    const relayUpdateAvailable =
      currentRelayVersion !== 'dev' &&
      currentRelayVersion !== 'unknown' &&
      latestRelayVersion != null &&
      isNewerVersion(latestRelayVersion, currentRelayVersion);
    const updateAvailable =
      gatewayUpdateAvailable &&
      latestVersion != null &&
      !isRelayTooOldForGatewayUpdate(currentRelayVersion, latestVersion);

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseNotes: map.get(SETTINGS_KEYS.releaseNotes) ?? null,
      releaseUrl: map.get(SETTINGS_KEYS.releaseUrl) ?? null,
      lastCheckedAt: map.get(SETTINGS_KEYS.lastCheckedAt) ?? null,
      relay: {
        currentVersion: currentRelayVersion,
        latestVersion: latestRelayVersion,
        updateAvailable: relayUpdateAvailable,
        releaseNotes: map.get(SETTINGS_KEYS.relayReleaseNotes) ?? null,
        releaseUrl: map.get(SETTINGS_KEYS.relayReleaseUrl) ?? null,
        operation: this.relayUpdateOperation,
      },
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
      const latestRelay = selectLatestRelayRelease(releases);
      if (latest) {
        await this.upsertSetting(SETTINGS_KEYS.latestVersion, latest.tag_name);
        await this.upsertSetting(SETTINGS_KEYS.releaseNotes, latest.description || '');
        await this.upsertSetting(SETTINGS_KEYS.releaseUrl, latest._links?.self || '');
      }
      if (latestRelay) {
        await this.upsertSetting(SETTINGS_KEYS.relayLatestVersion, latestRelay.tag_name.replace(/-relay$/, ''));
        await this.upsertSetting(SETTINGS_KEYS.relayReleaseNotes, latestRelay.description || '');
        await this.upsertSetting(SETTINGS_KEYS.relayReleaseUrl, latestRelay._links?.self || '');
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

  async prepareRelayUpdate(targetVersion: string): Promise<TrustedRelayUpdateArtifact> {
    const version = normalizeVersionTag(targetVersion);
    const tag = `${version}-relay`;
    const selfInfo = await this.dockerService.inspectSelf();
    const image = `${imageRepositoryFromRef(selfInfo.Config.Image)}/relay`;
    const response = await fetch(this.getRelayManifestUrl(version), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', `Failed to fetch relay update manifest: ${response.status}`);
    }
    const signedManifest = await response.text();
    try {
      return verifyRelayImageManifest(signedManifest, { version, tag, image, protocolMajor: 1 });
    } catch (error) {
      logger.warn('Relay update manifest verification failed', {
        targetVersion,
        image,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Relay update artifact is not trusted');
    }
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
      ...(artifact.databaseConnectorImage ? ['--database-connector-image', artifact.databaseConnectorImage] : []),
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

    const sidecarBackupDir = migrationOutput.backupDir?.replace(/^\/host(?=\/)/, composeDir) ?? '';
    const expectedBackupPrefix = `${composeDir}/.gateway-foundation-backups/`;
    if (
      sidecarBackupDir &&
      (!sidecarBackupDir.startsWith(expectedBackupPrefix) ||
        !/^[a-zA-Z0-9_.-]+$/.test(sidecarBackupDir.slice(expectedBackupPrefix.length)))
    ) {
      throw new Error(`Refusing to launch update with unexpected foundation backup path: ${sidecarBackupDir}`);
    }

    await this.dockerService.runDetached({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'sh',
        '-c',
        `set -eu
compose() { docker compose --project-name ${composeProject} --project-directory ${composeDir} -f ${composeDir}/docker-compose.yml "$@"; }
service_exists() { compose config --services | grep -qx "$1"; }
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
      if [ "$rollback_has_relay" -eq 0 ] && [ "$app_health" = healthy ]; then return 0; fi
      if [ "$rollback_has_relay" -eq 1 ]; then
        relay_id="$(compose ps -q relay)"
        if [ -n "$relay_id" ]; then
          relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
          if [ "$app_health" = healthy ] && [ "$relay_health" = healthy ] && relay_reachable; then return 0; fi
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
      if [ "$app_working_dir" = ${composeDir} ] && [ "$relay_working_dir" = ${composeDir} ] && [ "$relay_networks" -gt 0 ] && [ -n "$relay_public_port" ] && relay_reachable; then
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
  }

  async performRelayUpdate(targetVersion: string, artifact: TrustedRelayUpdateArtifact): Promise<void> {
    const version = normalizeVersionTag(targetVersion);
    const selfInfo = await this.dockerService.inspectSelf();
    const labels = selfInfo.Config.Labels;
    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    const composeProject = labels['com.docker.compose.project'];
    if (!composeDir || !/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) throw new Error('Invalid Compose directory');
    if (!composeProject || !/^[a-zA-Z0-9_-]+$/.test(composeProject)) throw new Error('Invalid Compose project');
    const relayImage = `${imageRepositoryFromRef(selfInfo.Config.Image)}/relay`;
    if (artifact.payload.version !== version || artifact.payload.image !== relayImage) {
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
    } finally {
      await this.relayRuntime?.setMaintenance(false);
    }
    await this.relayRuntime?.probeNow();
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

  getRelayManifestUrl(version: string): string {
    const tag = `${normalizeVersionTag(version)}-relay`;
    return `${this.gitlabApiUrl}/api/v4/projects/${this.encodedProjectPath}/packages/generic/relay/${tag}/relay-image.update.json`;
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
