import { describe, expect, it, vi } from 'vitest';
import { DockerComposeNodeDispatcher } from './compose-node-dispatcher.js';

describe('DockerComposeNodeDispatcher', () => {
  it('serializes the canonical revision without exposing daemon paths', async () => {
    const nodeDispatch = {
      sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true, detail: 'done' }),
    };
    const dispatcher = new DockerComposeNodeDispatcher(nodeDispatch as never);

    await expect(
      dispatcher.execute('node-1', {
        operationId: 'operation-1',
        projectId: 'project-1',
        projectName: 'demo',
        revisionId: 'revision-1',
        configDigest: 'sha256:digest',
        yaml: 'services: {}',
        normalizedModel: { name: 'demo', services: {}, volumes: {}, networks: {} },
        variables: { TAG: 'latest' },
        secrets: { TOKEN: 'secret' },
        action: 'apply',
        options: { removeOrphans: true, volumeNames: ['data'] },
      })
    ).resolves.toEqual({ success: true, message: undefined, detail: 'done' });

    expect(nodeDispatch.sendDockerComposeCommand).toHaveBeenCalledWith('node-1', 'apply', {
      operationId: 'operation-1',
      projectId: 'project-1',
      projectName: 'demo',
      revisionId: 'revision-1',
      configDigest: 'sha256:digest',
      composeYaml: Buffer.from('services: {}'),
      normalizedModelJson: JSON.stringify({ name: 'demo', services: {}, volumes: {}, networks: {} }),
      variables: { TAG: 'latest' },
      secrets: { TOKEN: 'secret' },
      removeOrphans: true,
      volumeNames: ['data'],
    });
  });
});
