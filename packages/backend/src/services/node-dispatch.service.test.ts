import { describe, expect, it, vi } from 'vitest';
import { NodeDispatchService } from './node-dispatch.service.js';

function createService(nodeType = 'docker') {
  const registry = {
    sendCommand: vi.fn().mockResolvedValue({ success: true }),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: vi.fn().mockResolvedValue([{ type: nodeType }]) }),
      }),
    }),
  };
  const service = new NodeDispatchService(registry as never, db as never);
  return { registry, service };
}

describe('NodeDispatchService', () => {
  it('forwards per-user session keys for Docker and node consoles', async () => {
    const { registry, service } = createService();

    await service.sendDockerExecCommand('node-1', 'create', {
      containerId: 'container-1',
      sessionKey: 'user-1',
    });
    await service.sendNodeExecCommand('node-1', 'create', {
      sessionKey: 'user-1',
    });

    expect(registry.sendCommand).toHaveBeenNthCalledWith(
      1,
      'node-1',
      {
        dockerExec: {
          action: 'create',
          containerId: 'container-1',
          sessionKey: 'user-1',
        },
      },
      undefined
    );
    expect(registry.sendCommand).toHaveBeenNthCalledWith(
      2,
      'node-1',
      {
        nodeExec: {
          action: 'create',
          sessionKey: 'user-1',
        },
      },
      undefined
    );
  });

  it('sends docker file string content as UTF-8 bytes', async () => {
    const { registry, service } = createService();

    await service.sendDockerFileCommand('node-1', 'write', {
      containerId: 'container-1',
      path: '/tmp/file.txt',
      content: 'Hello',
    });

    expect(registry.sendCommand).toHaveBeenCalledWith('node-1', {
      dockerFile: {
        action: 'write',
        containerId: 'container-1',
        path: '/tmp/file.txt',
        content: Buffer.from('Hello'),
      },
    });
  });

  it('passes docker file buffer content through unchanged', async () => {
    const { registry, service } = createService();
    const content = Buffer.from([0, 1, 2, 3]);

    await service.sendDockerFileCommand('node-1', 'write', {
      containerId: 'container-1',
      path: '/tmp/file.bin',
      content,
    });

    expect(registry.sendCommand).toHaveBeenCalledWith('node-1', {
      dockerFile: {
        action: 'write',
        containerId: 'container-1',
        path: '/tmp/file.bin',
        content,
      },
    });
  });

  it('uses a bounded long timeout for durable managed database operations', async () => {
    const { registry, service } = createService('databases');

    await service.sendDockerDatabaseCommand('node-1', 'create', 'database-1', '{"operationId":"op-1"}');

    expect(registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      { dockerDatabase: { action: 'create', managedDatabaseId: 'database-1', configJson: '{"operationId":"op-1"}' } },
      15 * 60 * 1000
    );
  });

  it('sends managed database logs through the restricted database command', async () => {
    const { registry, service } = createService('databases');

    await service.sendManagedDatabaseLogsCommand('node-1', 'database-1', {
      tailLines: 200,
      follow: true,
      timestamps: true,
    });

    expect(registry.sendCommand).toHaveBeenCalledWith('node-1', {
      dockerDatabase: {
        action: 'logs',
        managedDatabaseId: 'database-1',
        configJson: JSON.stringify({ tailLines: 200, follow: true, timestamps: true }),
      },
    });

    await service.stopManagedDatabaseLogStream('node-1', 'database-1');
    expect(registry.sendCommand).toHaveBeenLastCalledWith('node-1', {
      dockerDatabase: {
        action: 'logs_stop',
        managedDatabaseId: 'database-1',
        configJson: '{}',
      },
    });
  });
});
