import type { Env } from '@/config/env.js';
import type { DockerContainerFullInspect, DockerService } from './docker.service.js';
import { DOCKER_COMPOSE_CLI_IMAGE_REF } from './update.service.js';

export type RelayRecoverySafetyReason = 'unexpected_image' | 'docker_unavailable' | 'ownership_unverified';

export class RelayRecoverySafetyError extends Error {
  constructor(
    readonly reason: RelayRecoverySafetyReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RelayRecoverySafetyError';
  }
}

export type RelayRecoveryAction = 'start' | 'restart' | 'compose_up';
export type RelayStartupAction = 'already_running' | 'start' | 'compose_up' | 'recreate';

interface RelayOwnership {
  container: DockerContainerFullInspect | null;
  composeProject: string;
  composeWorkingDir: string;
}

const SAFE_PROJECT = /^[a-zA-Z0-9_-]+$/;
const SAFE_ABSOLUTE_PATH = /^\/[a-zA-Z0-9/_.-]+$/;

export class RelayDockerRecoveryService {
  constructor(
    private readonly docker: Pick<
      DockerService,
      | 'listContainersByLabel'
      | 'inspectContainer'
      | 'inspectSelf'
      | 'imageExists'
      | 'startContainer'
      | 'restartContainer'
      | 'runOneShot'
    >,
    private readonly env: Pick<Env, 'GATEWAY_RELAY_MANAGED' | 'GATEWAY_RELAY_IMAGE_REF' | 'GATEWAY_RELAY_SERVICE_NAME'>
  ) {}

  async recover(): Promise<RelayRecoveryAction> {
    const expectedImage = this.expectedImage();
    let ownership: RelayOwnership;
    try {
      ownership = await this.inspectOwnership();
    } catch (error) {
      if (error instanceof RelayRecoverySafetyError) throw error;
      throw new RelayRecoverySafetyError('docker_unavailable', 'Docker ownership inspection failed', {
        cause: error instanceof Error ? error : undefined,
      });
    }

    if (ownership.container) {
      this.assertExpectedImage(ownership.container, expectedImage);
      if (!ownership.container.State.Running) {
        await this.runDockerAction(() => this.docker.startContainer(ownership.container!.Id));
        return 'start';
      }
      await this.runDockerAction(() => this.docker.restartContainer(ownership.container!.Id, 10));
      return 'restart';
    }

    await this.composeUp(ownership, expectedImage, false);
    return 'compose_up';
  }

  async ensureStarted(): Promise<RelayStartupAction> {
    const expectedImage = this.expectedImage();
    const ownership = await this.runDockerAction(() => this.inspectOwnership());
    if (ownership.container) {
      this.assertExpectedImage(ownership.container, expectedImage);
      if (ownership.container.State.Running) return 'already_running';
      await this.runDockerAction(() => this.docker.startContainer(ownership.container!.Id));
      return 'start';
    }
    await this.composeUp(ownership, expectedImage, false);
    return 'compose_up';
  }

  async recreateExpected(): Promise<RelayStartupAction> {
    const expectedImage = this.expectedImage();
    const ownership = await this.runDockerAction(() => this.inspectOwnership());
    await this.composeUp(ownership, expectedImage, true);
    return 'recreate';
  }

  private expectedImage(): string {
    if (!this.env.GATEWAY_RELAY_MANAGED) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Relay is not installer-managed');
    }
    const expectedImage = this.env.GATEWAY_RELAY_IMAGE_REF;
    if (!expectedImage || !/@sha256:[a-f0-9]{64}$/.test(expectedImage)) {
      throw new RelayRecoverySafetyError('unexpected_image', 'Expected relay image digest is unavailable');
    }
    return expectedImage;
  }

  private async inspectOwnership(): Promise<RelayOwnership> {
    const app = await this.docker.inspectSelf();
    const appOwnership = this.validateLabels(app, 'app');
    const marker = `com.wiolett.gateway.managed-service=${this.env.GATEWAY_RELAY_SERVICE_NAME}`;
    const matches = await this.docker.listContainersByLabel(marker);
    const owned: Array<{ container: DockerContainerFullInspect; ownership: Omit<RelayOwnership, 'container'> }> = [];
    for (const match of matches) {
      const container = (await this.docker.inspectContainer(match.Id)) as DockerContainerFullInspect;
      const ownership = this.validateLabels(container, this.env.GATEWAY_RELAY_SERVICE_NAME);
      if (
        ownership.composeProject === appOwnership.composeProject &&
        ownership.composeWorkingDir === appOwnership.composeWorkingDir
      ) {
        owned.push({ container, ownership });
      }
    }
    if (owned.length > 1) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Multiple relay containers belong to this deployment');
    }
    if (owned.length === 1) return { container: owned[0]!.container, ...owned[0]!.ownership };
    return { container: null, ...appOwnership };
  }

  private assertExpectedImage(container: DockerContainerFullInspect, expectedImage: string): void {
    if (container.Config.Image !== expectedImage) {
      throw new RelayRecoverySafetyError('unexpected_image', 'Relay container image does not match expected digest');
    }
  }

  private async composeUp(ownership: RelayOwnership, expectedImage: string, forceRecreate: boolean): Promise<void> {
    const [hasRelayImage, hasComposeHelper] = await Promise.all([
      this.runDockerAction(() => this.docker.imageExists(expectedImage)),
      this.runDockerAction(() => this.docker.imageExists(DOCKER_COMPOSE_CLI_IMAGE_REF)),
    ]);
    if (!hasRelayImage) {
      throw new RelayRecoverySafetyError('unexpected_image', 'Expected relay image is not present locally');
    }
    if (!hasComposeHelper) {
      throw new RelayRecoverySafetyError('docker_unavailable', 'Pinned Compose helper image is not present locally');
    }
    const composeFile = `${ownership.composeWorkingDir}/docker-compose.yml`;
    const result = await this.runDockerAction(() =>
      this.docker.runOneShot({
        Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
        Cmd: [
          'docker',
          'compose',
          '--project-name',
          ownership.composeProject,
          '--project-directory',
          ownership.composeWorkingDir,
          '-f',
          composeFile,
          'up',
          '-d',
          ...(forceRecreate ? ['--force-recreate'] : []),
          this.env.GATEWAY_RELAY_SERVICE_NAME,
        ],
        HostConfig: {
          // Compose persists its working directory in container ownership
          // labels. Mounting the project at a synthetic /project path makes
          // the recreated relay look foreign to the app on the next probe.
          Binds: [
            `${ownership.composeWorkingDir}:${ownership.composeWorkingDir}`,
            '/var/run/docker.sock:/var/run/docker.sock',
          ],
        },
      })
    );
    if (result.exitCode !== 0) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Compose helper could not start the relay service');
    }
  }

  private validateLabels(container: DockerContainerFullInspect, service: string) {
    const labels = container.Config.Labels ?? {};
    const composeService = labels['com.docker.compose.service'];
    const composeProject = labels['com.docker.compose.project'];
    const composeWorkingDir = labels['com.docker.compose.project.working_dir'];
    const managedService = labels['com.wiolett.gateway.managed-service'];
    if (
      composeService !== service ||
      managedService !== service ||
      !composeProject ||
      !SAFE_PROJECT.test(composeProject) ||
      !composeWorkingDir ||
      !SAFE_ABSOLUTE_PATH.test(composeWorkingDir)
    ) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Compose relay ownership labels are invalid');
    }
    return { composeProject, composeWorkingDir };
  }

  private async runDockerAction<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof RelayRecoverySafetyError) throw error;
      throw new RelayRecoverySafetyError('docker_unavailable', 'Docker relay recovery action failed', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}
