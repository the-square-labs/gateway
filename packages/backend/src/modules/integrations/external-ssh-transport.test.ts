import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { execOnClient, isSshOperationCancelled } from './external-ssh-transport.js';

function fakeClient() {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  const client = {
    exec: vi.fn((_command: string, callback: (error: Error | undefined, stream: typeof channel) => void) =>
      callback(undefined, channel)
    ),
    end: vi.fn(),
  };
  return { client, channel, asClient: client as unknown as Client };
}

describe('execOnClient', () => {
  it('returns the output and exit code when the command finishes', async () => {
    const { channel, asClient } = fakeClient();
    const running = execOnClient(asClient, 'true', new AbortController().signal);
    channel.emit('data', Buffer.from('ok'));
    channel.emit('close', 0);
    await expect(running).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('ends the session and rejects as cancelled when the signal aborts mid-command', async () => {
    const { client, channel, asClient } = fakeClient();
    const controller = new AbortController();
    const running = execOnClient(asClient, 'sleep 600', controller.signal);
    controller.abort();
    const error = await running.catch((caught: unknown) => caught);
    expect(isSshOperationCancelled(error)).toBe(true);
    expect(client.end).toHaveBeenCalledOnce();
    // A late close after the abort does not settle the promise again.
    channel.emit('close', 0);
  });

  it('does not send the command when the signal is already aborted', async () => {
    const { client, asClient } = fakeClient();
    const error = await execOnClient(asClient, 'install', AbortSignal.abort()).catch((caught: unknown) => caught);
    expect(isSshOperationCancelled(error)).toBe(true);
    expect(client.exec).not.toHaveBeenCalled();
  });
});
