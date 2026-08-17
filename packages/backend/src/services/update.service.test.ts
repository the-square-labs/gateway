import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { TrustedGatewayUpdateArtifact, TrustedRelayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import {
  DOCKER_COMPOSE_CLI_IMAGE_REF,
  imageRepositoryFromRef,
  isGatewayReleaseTag,
  isRelayReleaseTag,
  isRelayTooOldForGatewayUpdate,
  selectLatestGatewayRelease,
  selectLatestRelayRelease,
  UpdateService,
} from './update.service.js';

describe('UpdateService release selection', () => {
  describe('isGatewayReleaseTag', () => {
    it('accepts plain gateway tags', () => {
      expect(isGatewayReleaseTag('v2.1.2')).toBe(true);
      expect(isGatewayReleaseTag('2.1.2')).toBe(true);
    });

    it('rejects daemon-suffixed tags', () => {
      expect(isGatewayReleaseTag('v2.1.1-docker')).toBe(false);
      expect(isGatewayReleaseTag('v2.1.1-nginx')).toBe(false);
      expect(isGatewayReleaseTag('v2.1.1-monitoring')).toBe(false);
      expect(isGatewayReleaseTag('v2.1.1-relay')).toBe(false);
    });
  });

  it('selects relay releases independently from Gateway and daemon tags', () => {
    expect(isRelayReleaseTag('v2.2.0-relay')).toBe(true);
    expect(
      selectLatestRelayRelease([
        { tag_name: 'v2.2.0', description: '', _links: { self: '' } },
        { tag_name: 'v2.1.0-relay', description: '', _links: { self: '' } },
        { tag_name: 'v2.2.0-relay', description: '', _links: { self: '' } },
      ])?.tag_name
    ).toBe('v2.2.0-relay');
  });

  describe('selectLatestGatewayRelease', () => {
    it('ignores daemon release tags and selects the latest plain gateway tag', () => {
      const latest = selectLatestGatewayRelease([
        {
          tag_name: 'v2.1.1-docker',
          description: 'docker',
          _links: { self: 'docker' },
        },
        {
          tag_name: 'v2.1.2',
          description: 'gateway',
          _links: { self: 'gateway' },
        },
        {
          tag_name: 'v2.1.1-monitoring',
          description: 'monitoring',
          _links: { self: 'monitoring' },
        },
      ]);

      expect(latest?.tag_name).toBe('v2.1.2');
    });

    it('returns null when only daemon tags exist', () => {
      const latest = selectLatestGatewayRelease([
        {
          tag_name: 'v2.1.1-docker',
          description: 'docker',
          _links: { self: 'docker' },
        },
        {
          tag_name: 'v2.1.1-nginx',
          description: 'nginx',
          _links: { self: 'nginx' },
        },
      ]);

      expect(latest).toBeNull();
    });
  });

  describe('isRelayTooOldForGatewayUpdate', () => {
    it('allows Gateway updates while Relay is less than two minor versions behind', () => {
      expect(isRelayTooOldForGatewayUpdate('v2.6.12', 'v2.6.13')).toBe(false);
      expect(isRelayTooOldForGatewayUpdate('v2.5.9', 'v2.6.0')).toBe(false);
    });

    it('blocks Gateway updates when Relay is at least two minor versions behind', () => {
      expect(isRelayTooOldForGatewayUpdate('v2.4.12', 'v2.6.0')).toBe(true);
      expect(isRelayTooOldForGatewayUpdate('v2.9.0', 'v3.0.0')).toBe(true);
    });

    it('does not block unverifiable local versions', () => {
      expect(isRelayTooOldForGatewayUpdate('dev', 'v2.7.0')).toBe(false);
    });
  });
});

describe('imageRepositoryFromRef', () => {
  it('removes a mutable tag after a registry port', () => {
    expect(imageRepositoryFromRef('registry.example.com:5050/wiolett/gateway:v2.3.0')).toBe(
      'registry.example.com:5050/wiolett/gateway'
    );
  });

  it('removes a digest from an immutable image reference', () => {
    expect(imageRepositoryFromRef('registry.example.com/wiolett/gateway@sha256:abc')).toBe(
      'registry.example.com/wiolett/gateway'
    );
  });

  it('keeps untagged image references unchanged', () => {
    expect(imageRepositoryFromRef('registry.example.com/wiolett/gateway')).toBe('registry.example.com/wiolett/gateway');
  });
});

describe('UpdateService foundation migration', () => {
  it('runs foundation migrations from the target image before validating and recreating compose', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const artifact = makeArtifact('registry.example.com/wiolett/gateway@sha256:new');

    await service.performUpdate('v2.4.3', artifact);

    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(1, artifact.imageRef);
    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(2, DOCKER_COMPOSE_CLI_IMAGE_REF);
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Image: artifact.imageRef,
        Cmd: ['node', 'dist/cli/migrate-legacy-settings.js', '/host'],
        HostConfig: expect.objectContaining({ Binds: ['/srv/gateway:/host'] }),
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Image: artifact.imageRef,
        Cmd: [
          'node',
          'dist/foundation-migrator.js',
          '--host-dir',
          '/host',
          '--target-version',
          'v2.4.3',
          '--image-ref',
          artifact.imageRef,
        ],
        HostConfig: expect.objectContaining({
          Binds: expect.arrayContaining([
            '/srv/gateway:/host',
            '/var/lib/gateway/sandbox-workspaces:/var/lib/gateway/sandbox-workspaces',
          ]),
        }),
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Image: artifact.imageRef,
        Cmd: ['sh', '-c', 'set -eu\nmkdir -p "$SANDBOX_WORKSPACE_DIR"\nchmod 700 "$SANDBOX_WORKSPACE_DIR"'],
        Env: ['SANDBOX_WORKSPACE_DIR=/var/lib/gateway/sandbox-workspaces'],
        HostConfig: expect.objectContaining({
          Binds: ['/var/lib/gateway/sandbox-workspaces:/var/lib/gateway/sandbox-workspaces'],
        }),
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        Cmd: [
          'docker',
          'compose',
          '--project-name',
          'gateway',
          '-f',
          '/project/docker-compose.yml',
          'config',
          '--quiet',
        ],
      })
    );
    expect(dockerService.runDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: ['sh', '-c', expect.stringContaining('compose up -d --force-recreate app')],
        Env: ['FOUNDATION_BACKUP_DIR=/srv/gateway/.gateway-foundation-backups/test'],
        HostConfig: {
          Binds: ['/srv/gateway:/srv/gateway', '/var/run/docker.sock:/var/run/docker.sock'],
        },
      })
    );
    const sidecarCommand = dockerService.runDetached.mock.calls[0]?.[0]?.Cmd?.[2];
    if (typeof sidecarCommand !== 'string') throw new Error('Update sidecar command was not recorded');
    expect(sidecarCommand).toContain('docker inspect --format');
    expect(sidecarCommand).toContain('rollback');
    expect(sidecarCommand).toContain('trap on_exit EXIT');
    expect(sidecarCommand).toContain(
      'compose() { docker compose --project-name gateway --project-directory /srv/gateway -f /srv/gateway/docker-compose.yml "$@"; }'
    );
    expect(sidecarCommand).toContain('cp -p "$FOUNDATION_BACKUP_DIR/.env" /srv/gateway/.env');
    expect(sidecarCommand).toContain('service_exists() { compose config --services | grep -qx "$1"; }');
    expect(sidecarCommand).toContain('compose stop app');
    expect(sidecarCommand).not.toContain('compose stop app relay');
    expect(sidecarCommand).toContain(
      'if [ "$rollback_has_relay" -eq 1 ]; then\n    compose up -d --no-deps app\n  else\n    compose up -d app\n  fi'
    );
    expect(sidecarCommand).toContain(
      'if service_exists relay; then\n  compose up -d --no-deps --force-recreate app\nelse\n  compose up -d --force-recreate app\nfi'
    );
    expect(sidecarCommand).toContain('relay_reachable()');
    expect(sidecarCommand).toContain('net.connect(9443,"relay"');
    expect(sidecarCommand).toContain('relay_networks="$(docker inspect');
    expect(sidecarCommand).toContain('relay_public_port="$(docker port "$relay_id" 9443/tcp)"');
    expect(sidecarCommand).toContain('[ "$app_working_dir" = /srv/gateway ]');
    expect(sidecarCommand).not.toContain(
      'if [ "$app_health" = unhealthy ] || [ "$relay_health" = unhealthy ]; then break; fi'
    );
    expect(sidecarCommand).toContain('CREATE OR REPLACE VIEW "public"."gateway_relay_bindings_v1"');
    const syntax = spawnSync('/bin/sh', ['-n'], { input: sidecarCommand, encoding: 'utf8' });
    expect(syntax.stderr).toBe('');
    expect(syntax.status).toBe(0);
  });

  it('updates relay without recreating the Gateway app', async () => {
    const dockerService = makeDockerService();
    const relayRuntime = {
      setMaintenance: vi.fn().mockResolvedValue(undefined),
      setExpectedArtifact: vi.fn(),
      updateSecureLinkConnectorImage: vi.fn().mockResolvedValue(undefined),
      probeNow: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeUpdateService(dockerService, relayRuntime);
    const relay = makeRelayArtifact();

    await service.performRelayUpdate('v2.4.3', relay);

    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(1, relay.imageRef);
    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(2, DOCKER_COMPOSE_CLI_IMAGE_REF);
    const updateCommand = dockerService.runOneShot.mock.calls[2]?.[0]?.Cmd?.[2];
    expect(updateCommand).toContain('compose up -d --no-deps --force-recreate relay');
    expect(updateCommand).not.toContain('force-recreate app');
    expect(dockerService.runDetached).not.toHaveBeenCalled();
    expect(relayRuntime.setMaintenance).toHaveBeenNthCalledWith(1, true);
    expect(relayRuntime.setMaintenance).toHaveBeenLastCalledWith(false);
    expect(relayRuntime.setExpectedArtifact).toHaveBeenCalledWith(
      relay.imageRef,
      relay.buildVersion,
      relay.protocolMajor
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Cmd: expect.arrayContaining(['--secure-link-connector-image', relay.secureLinkConnectorImage]),
      })
    );
    expect(relayRuntime.updateSecureLinkConnectorImage).toHaveBeenCalledWith(relay.secureLinkConnectorImage);
    expect(relayRuntime.probeNow).toHaveBeenCalled();
  });

  it('keeps the Relay update operation on the server', () => {
    const service = makeUpdateService(makeDockerService());

    service.startRelayUpdate('v2.6.13');
    expect((service as unknown as { relayUpdateOperation: unknown }).relayUpdateOperation).toMatchObject({
      status: 'updating',
      targetVersion: 'v2.6.13',
      error: null,
    });

    expect(() => service.startRelayUpdate('v2.6.14')).toThrow('already in progress');
    service.completeRelayUpdate();
    expect((service as unknown as { relayUpdateOperation: unknown }).relayUpdateOperation).toBeNull();
  });

  it('does not recreate the app when migrated compose validation fails', async () => {
    const dockerService = makeDockerService();
    dockerService.runOneShot
      .mockResolvedValueOnce({ exitCode: 0, output: '{"ok":true}' })
      .mockResolvedValueOnce({
        exitCode: 0,
        output:
          '{"ok":true,"changedFiles":["docker-compose.yml"],"backupDir":"/host/.gateway-foundation-backups/test","sandboxWorkspaceDir":"/var/lib/gateway/sandbox-workspaces"}',
      })
      .mockResolvedValueOnce({ exitCode: 0, output: '' })
      .mockResolvedValueOnce({ exitCode: 1, output: 'bad compose' })
      .mockResolvedValueOnce({ exitCode: 0, output: '' });
    const service = makeUpdateService(dockerService);

    await expect(
      service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway:v2.4.3'))
    ).rejects.toThrow('Migrated docker-compose.yml failed validation');

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        Image: 'registry.example.com/wiolett/gateway:v2.4.3',
        Env: ['FOUNDATION_BACKUP_DIR=/host/.gateway-foundation-backups/test'],
      })
    );
    expect(dockerService.runDetached).not.toHaveBeenCalled();
  });

  it('persists the verified database connector image through the foundation migration', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const connectorImage = 'registry.example.com/wiolett/gateway/database-connector@sha256:connector-digest';

    await service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway:v2.4.3', connectorImage));

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Cmd: expect.arrayContaining(['--database-connector-image', connectorImage]),
      })
    );
  });

  it('persists the verified Secure Link connector image through the foundation migration', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const connectorImage = 'registry.example.com/wiolett/gateway/secure-link-connector@sha256:connector-digest';

    await service.performUpdate(
      'v2.4.3',
      makeArtifact('registry.example.com/wiolett/gateway:v2.4.3', undefined, connectorImage)
    );

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Cmd: expect.arrayContaining(['--secure-link-connector-image', connectorImage]),
      })
    );
  });

  it('prepares a custom sandbox workspace directory from the migrator output', async () => {
    const dockerService = makeDockerService();
    dockerService.runOneShot.mockResolvedValueOnce({ exitCode: 0, output: '{"ok":true}' }).mockResolvedValueOnce({
      exitCode: 0,
      output:
        '{"ok":true,"changedFiles":[".env","docker-compose.yml"],"backupDir":"/host/.gateway-foundation-backups/test","sandboxWorkspaceDir":"/srv/gateway-workspaces"}',
    });
    const service = makeUpdateService(dockerService);
    const artifact = makeArtifact('registry.example.com/wiolett/gateway:v2.4.3');

    await service.performUpdate('v2.4.3', artifact);

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Env: ['SANDBOX_WORKSPACE_DIR=/srv/gateway-workspaces'],
        HostConfig: { Binds: ['/srv/gateway-workspaces:/srv/gateway-workspaces'] },
      })
    );
  });
});

function makeUpdateService(
  dockerService: ReturnType<typeof makeDockerService>,
  relayRuntime?: ConstructorParameters<typeof UpdateService>[3]
): UpdateService {
  return new UpdateService(
    {} as never,
    dockerService as never,
    {
      APP_VERSION: 'v2.4.2',
      COMPOSE_PROJECT_DIR: '/srv/gateway',
      GITLAB_API_URL: 'https://gitlab.example.com/api/v4',
      GITLAB_PROJECT_PATH: 'wiolett/gateway',
      GATEWAY_RELAY_IMAGE_REF: `registry.example.com/wiolett/gateway/relay@sha256:${'b'.repeat(64)}`,
      GATEWAY_RELAY_BUILD_VERSION: 'v2.4.2',
      GATEWAY_RELAY_PROTOCOL_MAJOR: 1,
    } as never,
    relayRuntime
  );
}

function makeDockerService() {
  return {
    inspectSelf: vi.fn().mockResolvedValue({
      Config: {
        Image: 'registry.example.com/wiolett/gateway:v2.4.2',
        Labels: {
          'com.docker.compose.project.working_dir': '/srv/gateway',
          'com.docker.compose.project': 'gateway',
        },
      },
    }),
    pullImageRef: vi.fn().mockResolvedValue(undefined),
    runOneShot: vi.fn().mockResolvedValue({
      exitCode: 0,
      output:
        '{"ok":true,"changedFiles":[],"backupDir":"/host/.gateway-foundation-backups/test","sandboxWorkspaceDir":"/var/lib/gateway/sandbox-workspaces"}',
    }),
    runDetached: vi.fn().mockResolvedValue('sidecar-1'),
  };
}

function makeArtifact(
  imageRef: string,
  databaseConnectorImage?: string,
  secureLinkConnectorImage?: string
): TrustedGatewayUpdateArtifact {
  return {
    imageRef,
    digest: 'sha256:new',
    signedManifest: 'signed',
    payload: {
      kind: 'gateway-image',
      version: 'v2.4.3',
      tag: 'v2.4.3',
      image: 'registry.example.com/wiolett/gateway',
      digest: 'sha256:new',
      imageRef,
      ...(databaseConnectorImage ? { databaseConnectorImage } : {}),
      ...(secureLinkConnectorImage ? { secureLinkConnectorImage } : {}),
      createdAt: '2026-06-30T00:00:00.000Z',
    },
    ...(databaseConnectorImage ? { databaseConnectorImage } : {}),
    ...(secureLinkConnectorImage ? { secureLinkConnectorImage } : {}),
  };
}

function makeRelayArtifact(): TrustedRelayUpdateArtifact {
  const imageRef = `registry.example.com/wiolett/gateway/relay@sha256:${'a'.repeat(64)}`;
  const secureLinkConnectorImage = `registry.example.com/wiolett/gateway/secure-link-connector@sha256:${'c'.repeat(64)}`;
  return {
    imageRef,
    digest: `sha256:${'a'.repeat(64)}`,
    buildVersion: 'v2.4.3',
    protocolMajor: 1,
    secureLinkConnectorImage,
    signedManifest: 'signed-relay',
    payload: {
      kind: 'relay-image',
      version: 'v2.4.3',
      tag: 'v2.4.3-relay',
      image: 'registry.example.com/wiolett/gateway/relay',
      digest: `sha256:${'a'.repeat(64)}`,
      imageRef,
      protocolMajor: 1,
      secureLinkConnectorImage,
      createdAt: '2026-06-30T00:00:00.000Z',
    },
  };
}
