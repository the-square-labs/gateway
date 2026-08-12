import { describe, expect, it, vi } from 'vitest';
import { RelayDockerRecoveryService, type RelayRecoverySafetyError } from './relay-docker-recovery.service.js';

const IMAGE = `registry.example/gateway@sha256:${'a'.repeat(64)}`;
const labels = (service: string) => ({
  'com.wiolett.gateway.managed-service': service,
  'com.docker.compose.service': service,
  'com.docker.compose.project': 'gateway',
  'com.docker.compose.project.working_dir': '/opt/gateway',
});

const foreignLabels = (service: string) => ({
  'com.wiolett.gateway.managed-service': service,
  'com.docker.compose.service': service,
  'com.docker.compose.project': 'other-gateway',
  'com.docker.compose.project.working_dir': '/opt/other-gateway',
});

function docker() {
  return {
    listContainersByLabel: vi.fn().mockResolvedValue([]),
    inspectContainer: vi.fn(),
    inspectSelf: vi.fn().mockResolvedValue({ Id: 'app-id', Config: { Image: IMAGE, Labels: labels('app') } }),
    imageExists: vi.fn().mockResolvedValue(true),
    startContainer: vi.fn(),
    restartContainer: vi.fn(),
    runOneShot: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
  };
}

function service(mock = docker(), env: Record<string, unknown> = {}) {
  return {
    service: new RelayDockerRecoveryService(
      mock as never,
      {
        GATEWAY_RELAY_MANAGED: true,
        GATEWAY_RELAY_IMAGE_REF: IMAGE,
        GATEWAY_RELAY_SERVICE_NAME: 'relay',
        ...env,
      } as never
    ),
    mock,
  };
}

describe('RelayDockerRecoveryService', () => {
  it('starts an owned stopped relay without recreating it', async () => {
    const { service: recovery, mock } = service();
    mock.listContainersByLabel.mockResolvedValue([{ Id: 'relay-id' }]);
    mock.inspectContainer.mockResolvedValue({
      Id: 'relay-id',
      State: { Running: false },
      Config: { Image: IMAGE, Labels: labels('relay') },
    });
    await expect(recovery.recover()).resolves.toBe('start');
    expect(mock.startContainer).toHaveBeenCalledWith('relay-id');
    expect(mock.restartContainer).not.toHaveBeenCalled();
  });

  it('restarts an owned running relay after an unresponsive probe', async () => {
    const { service: recovery, mock } = service();
    mock.listContainersByLabel.mockResolvedValue([{ Id: 'relay-id' }]);
    mock.inspectContainer.mockResolvedValue({
      Id: 'relay-id',
      State: { Running: true },
      Config: { Image: IMAGE, Labels: labels('relay') },
    });
    await expect(recovery.recover()).resolves.toBe('restart');
    expect(mock.restartContainer).toHaveBeenCalledWith('relay-id', 10);
  });

  it('uses the already-present pinned Compose helper only when the relay is missing', async () => {
    const { service: recovery, mock } = service();
    await expect(recovery.recover()).resolves.toBe('compose_up');
    expect(mock.imageExists).toHaveBeenCalledWith(IMAGE);
    expect(mock.imageExists).toHaveBeenCalledTimes(2);
    expect(mock.runOneShot).toHaveBeenCalledWith(
      expect.objectContaining({ Cmd: expect.arrayContaining(['up', '-d', 'relay']) })
    );
  });

  it('never starts or restarts a relay owned by another Compose deployment', async () => {
    const { service: recovery, mock } = service();
    mock.listContainersByLabel.mockResolvedValue([{ Id: 'foreign-relay-id' }]);
    mock.inspectContainer.mockResolvedValue({
      Id: 'foreign-relay-id',
      State: { Running: true },
      Config: { Image: IMAGE, Labels: foreignLabels('relay') },
    });

    await expect(recovery.recover()).resolves.toBe('compose_up');
    expect(mock.startContainer).not.toHaveBeenCalled();
    expect(mock.restartContainer).not.toHaveBeenCalled();
    expect(mock.runOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: expect.arrayContaining([
          '--project-name',
          'gateway',
          '--project-directory',
          '/opt/gateway',
          '-f',
          '/opt/gateway/docker-compose.yml',
        ]),
        HostConfig: expect.objectContaining({ Binds: expect.arrayContaining(['/opt/gateway:/opt/gateway']) }),
      })
    );
  });

  it('uses the configured host Compose directory after an older updater wrote synthetic labels', async () => {
    const mock = docker();
    mock.inspectSelf.mockResolvedValue({
      Id: 'app-id',
      Config: { Image: IMAGE, Labels: { ...labels('app'), 'com.docker.compose.project.working_dir': '/project' } },
    });
    const { service: recovery } = service(mock, { COMPOSE_PROJECT_DIR: '/opt/gateway' });

    await expect(recovery.recover()).resolves.toBe('compose_up');
    expect(mock.runOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: expect.arrayContaining(['--project-directory', '/opt/gateway', '-f', '/opt/gateway/docker-compose.yml']),
        HostConfig: expect.objectContaining({ Binds: expect.arrayContaining(['/opt/gateway:/opt/gateway']) }),
      })
    );
  });

  it('leaves an already-running expected relay untouched during startup finalization', async () => {
    const { service: recovery, mock } = service();
    mock.listContainersByLabel.mockResolvedValue([{ Id: 'relay-id' }]);
    mock.inspectContainer.mockResolvedValue({
      Id: 'relay-id',
      State: { Running: true },
      Config: { Image: IMAGE, Labels: labels('relay') },
    });

    await expect(recovery.ensureStarted()).resolves.toBe('already_running');
    expect(mock.restartContainer).not.toHaveBeenCalled();
    expect(mock.runOneShot).not.toHaveBeenCalled();
  });

  it('recreates an owned relay only through the pinned expected Compose foundation', async () => {
    const { service: recovery, mock } = service();
    mock.listContainersByLabel.mockResolvedValue([{ Id: 'relay-id' }]);
    mock.inspectContainer.mockResolvedValue({
      Id: 'relay-id',
      State: { Running: true },
      Config: { Image: `registry.example/gateway@sha256:${'b'.repeat(64)}`, Labels: labels('relay') },
    });

    await expect(recovery.recreateExpected()).resolves.toBe('recreate');
    expect(mock.runOneShot).toHaveBeenCalledWith(
      expect.objectContaining({ Cmd: expect.arrayContaining(['up', '-d', '--force-recreate', 'relay']) })
    );
  });

  it('never acts on an unexpected image or ambiguous ownership', async () => {
    const { service: recovery, mock } = service();
    mock.listContainersByLabel.mockResolvedValue([{ Id: 'relay-id' }]);
    mock.inspectContainer.mockResolvedValue({
      Id: 'relay-id',
      State: { Running: true },
      Config: { Image: `other@sha256:${'b'.repeat(64)}`, Labels: labels('relay') },
    });
    await expect(recovery.recover()).rejects.toMatchObject({
      reason: 'unexpected_image',
    } satisfies Partial<RelayRecoverySafetyError>);
    expect(mock.startContainer).not.toHaveBeenCalled();
    expect(mock.restartContainer).not.toHaveBeenCalled();
  });

  it('does not mutate manual deployments', async () => {
    const { service: recovery } = service(docker(), { GATEWAY_RELAY_MANAGED: false });
    await expect(recovery.recover()).rejects.toMatchObject({ reason: 'ownership_unverified' });
  });
});
