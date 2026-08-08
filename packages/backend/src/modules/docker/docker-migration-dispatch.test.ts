import { describe, expect, it, vi } from 'vitest';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

function dispatchAdapter() {
  const dispatch = {
    sendDockerMigrationCommand: vi.fn().mockResolvedValue({ success: true, detail: '{}' }),
  };
  return { adapter: new DockerMigrationDispatchAdapter(dispatch as never), dispatch };
}

describe('GWCA daemon protocol compatibility', () => {
  it('requires the environment-safe export command only when environment is excluded', async () => {
    const { adapter, dispatch } = dispatchAdapter();
    await adapter.openArchiveExport({
      nodeId: NODE_ID,
      archiveId: 'archive-1',
      artifactId: 'image',
      containerId: 'container-1',
      includeWritableLayer: true,
      imageMode: 'portable',
      environment: {},
      secrets: {},
      secretKeys: [],
      includeEnvironment: false,
      includeSecrets: false,
    });
    expect(dispatch.sendDockerMigrationCommand).toHaveBeenCalledWith(
      NODE_ID,
      'open_archive_export_v2',
      expect.any(Object),
      15 * 60 * 1000
    );
  });

  it('keeps an upgraded daemon compatible with ordinary legacy exports', async () => {
    const { adapter, dispatch } = dispatchAdapter();
    await adapter.openArchiveExport({
      nodeId: NODE_ID,
      archiveId: 'archive-1',
      artifactId: 'image',
      containerId: 'container-1',
      includeWritableLayer: false,
      imageMode: 'portable',
      environment: { PUBLIC_VALUE: 'visible' },
      secrets: {},
      secretKeys: [],
      includeEnvironment: true,
      includeSecrets: false,
    });
    expect(dispatch.sendDockerMigrationCommand).toHaveBeenCalledWith(
      NODE_ID,
      'open_archive_export',
      expect.any(Object),
      15 * 60 * 1000
    );
  });

  it('uses the tag-safe import command for every archive import', async () => {
    const { adapter, dispatch } = dispatchAdapter();
    await adapter.openArchiveImport(NODE_ID, 'archive-1', 'image', {
      expectedImageId: IMAGE_ID,
      imageEmbedded: true,
    });
    expect(dispatch.sendDockerMigrationCommand).toHaveBeenCalledWith(
      NODE_ID,
      'open_archive_import_v2',
      expect.any(Object),
      15 * 60 * 1000
    );
  });
});
