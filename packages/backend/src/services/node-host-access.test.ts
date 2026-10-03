import { describe, expect, it } from 'vitest';
import { NodeDispatchService } from './node-dispatch.service.js';
import {
  NODE_CONSOLE_DISABLED_CAPABILITY,
  NODE_FILES_DISABLED_CAPABILITY,
  nodeHostAccessFlags,
} from './node-host-access.js';

function dispatchFor(advertised: string[]) {
  const sent: unknown[] = [];
  const registry = {
    hasCapability: (_nodeId: string, capability: string) => advertised.includes(capability),
    sendCommand: async (_nodeId: string, command: unknown) => {
      sent.push(command);
      return { commandId: 'c', success: true };
    },
  };
  return { dispatch: new NodeDispatchService(registry as never, {} as never), sent };
}

describe('node host access switches', () => {
  it('maps the disabled markers a daemon advertises to node capability flags', () => {
    expect(nodeHostAccessFlags(undefined)).toEqual({});
    expect(nodeHostAccessFlags(['docker_compose_v1'])).toEqual({});
    expect(nodeHostAccessFlags([NODE_CONSOLE_DISABLED_CAPABILITY, NODE_FILES_DISABLED_CAPABILITY])).toEqual({
      nodeConsoleDisabled: true,
      nodeFilesDisabled: true,
    });
  });

  it('refuses console commands with a 409 before dispatching when the node disabled its console', async () => {
    const { dispatch, sent } = dispatchFor([NODE_CONSOLE_DISABLED_CAPABILITY]);
    for (const action of ['create', 'resize', 'run']) {
      await expect(dispatch.sendNodeExecCommand('node-1', action, { command: ['id'] })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_CONSOLE_DISABLED',
        message: expect.stringContaining("Console is disabled in this node's daemon configuration"),
      });
    }
    expect(sent).toEqual([]);
    // The console switch does not touch file access.
    await expect(dispatch.sendNodeFileCommand('node-1', 'list', { path: '/' })).resolves.toMatchObject({
      success: true,
    });
  });

  it('refuses host file operations with a 409 when the node disabled file access, but keeps the host identity read', async () => {
    const { dispatch, sent } = dispatchFor([NODE_FILES_DISABLED_CAPABILITY]);
    for (const action of ['list', 'read', 'write', 'delete', 'move', 'upload-init', 'upload-abort']) {
      await expect(dispatch.sendNodeFileCommand('node-1', action, { path: '/etc/passwd' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_FILES_DISABLED',
      });
    }
    expect(sent).toEqual([]);
    await expect(dispatch.sendNodeFileCommand('node-1', 'ensure-host-identity')).resolves.toMatchObject({
      success: true,
    });
    await expect(dispatch.sendNodeExecCommand('node-1', 'run', { command: ['id'] })).resolves.toMatchObject({
      success: true,
    });
    expect(sent).toHaveLength(2);
  });

  it('dispatches console and file commands to a node that disabled nothing', async () => {
    const { dispatch, sent } = dispatchFor([]);
    await dispatch.sendNodeExecCommand('node-1', 'create', { tty: true });
    await dispatch.sendNodeFileCommand('node-1', 'read', { path: '/etc/hostname' });
    expect(sent).toHaveLength(2);
  });
});
