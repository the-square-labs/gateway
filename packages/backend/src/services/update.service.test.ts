import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { TrustedGatewayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import {
  imageRepositoryFromRef,
  isGatewayReleaseTag,
  selectLatestGatewayRelease,
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
    });
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
    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(2, artifact.relayImageRef);
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
          '--relay-build-version',
          artifact.relayBuildVersion,
          '--relay-protocol-major',
          '1',
          '--relay-image-ref',
          artifact.relayImageRef,
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
        Env: ['FOUNDATION_BACKUP_DIR=/project/.gateway-foundation-backups/test'],
      })
    );
    const sidecarCommand = dockerService.runDetached.mock.calls[0]?.[0]?.Cmd?.[2];
    if (typeof sidecarCommand !== 'string') throw new Error('Update sidecar command was not recorded');
    expect(sidecarCommand).toContain('docker inspect --format');
    expect(sidecarCommand).toContain('rollback');
    expect(sidecarCommand).toContain('trap on_exit EXIT');
    expect(sidecarCommand).toContain('cp -p "$FOUNDATION_BACKUP_DIR/.env" /project/.env');
    expect(sidecarCommand).toContain('service_exists() { compose config --services | grep -qx "$1"; }');
    expect(sidecarCommand).toContain(
      'if service_exists relay; then\n    rollback_has_relay=1\n    compose stop app relay\n  else\n    compose stop app\n  fi'
    );
    expect(sidecarCommand).toContain(
      'if [ "$rollback_has_relay" -eq 1 ]; then\n    compose up -d app relay\n  else\n    compose up -d app\n  fi'
    );
    expect(sidecarCommand).toContain('sleep 2\ncompose up -d --force-recreate app\ncompose up -d relay');
    expect(sidecarCommand).not.toContain(
      'if [ "$app_health" = unhealthy ] || [ "$relay_health" = unhealthy ]; then break; fi'
    );
    expect(sidecarCommand).toContain('CREATE OR REPLACE VIEW "public"."gateway_relay_bindings_v1"');
    const syntax = spawnSync('/bin/sh', ['-n'], { input: sidecarCommand, encoding: 'utf8' });
    expect(syntax.stderr).toBe('');
    expect(syntax.status).toBe(0);
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

function makeUpdateService(dockerService: ReturnType<typeof makeDockerService>): UpdateService {
  return new UpdateService(
    {} as never,
    dockerService as never,
    {
      APP_VERSION: 'v2.4.2',
      COMPOSE_PROJECT_DIR: '/srv/gateway',
      GITLAB_API_URL: 'https://gitlab.example.com/api/v4',
      GITLAB_PROJECT_PATH: 'wiolett/gateway',
    } as never
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
    relayBuildVersion: 'v2.4.3-relay',
    relayProtocolMajor: 1,
    relayImageRef: `registry.example.com/wiolett/gateway/relay@sha256:${'a'.repeat(64)}`,
    signedManifest: 'signed',
    payload: {
      kind: 'gateway-image',
      version: 'v2.4.3',
      tag: 'v2.4.3',
      image: 'registry.example.com/wiolett/gateway',
      digest: 'sha256:new',
      imageRef,
      relayBuildVersion: 'v2.4.3-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry.example.com/wiolett/gateway/relay@sha256:${'a'.repeat(64)}`,
      ...(databaseConnectorImage ? { databaseConnectorImage } : {}),
      ...(secureLinkConnectorImage ? { secureLinkConnectorImage } : {}),
      createdAt: '2026-06-30T00:00:00.000Z',
    },
    ...(databaseConnectorImage ? { databaseConnectorImage } : {}),
    ...(secureLinkConnectorImage ? { secureLinkConnectorImage } : {}),
  };
}
