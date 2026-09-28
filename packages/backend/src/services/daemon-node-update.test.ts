import { describe, expect, it, vi } from 'vitest';
import { dispatchNodeDaemonUpdate, resumeQueuedDaemonUpdates } from './daemon-node-update.js';

function deps(options: { leaseMember: boolean; beginQueued?: boolean }) {
  const node = { id: 'node-1', type: 'docker', capabilities: { architecture: 'x86_64' } };
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [node] }) }) })),
  };
  const daemonUpdateService = {
    getLatestRelease: vi.fn(async () => ({ tagName: 'v2.11.0-docker', version: 'v2.11.0' })),
    prepareTrustedDaemonUpdate: vi.fn(async () => ({
      downloadUrl: 'https://example/docker-daemon',
      checksum: 'abc',
      signedManifest: 'manifest',
    })),
    markNodeUpdateInProgress: vi.fn(async () => 'op-1'),
    beginQueuedNodeUpdate: vi.fn(async () => options.beginQueued ?? true),
    recordNodeUpdateWait: vi.fn(async () => undefined),
    trackNodeUpdateCompletion: vi.fn(),
    clearNodeUpdateInProgress: vi.fn(async () => true),
    failNodeUpdate: vi.fn(async () => true),
    listQueuedNodeUpdates: vi.fn(async () => [] as Array<{ nodeId: string; operationId: string }>),
  };
  const dispatch = {
    sendUpdateDaemonCommand: vi.fn(async () => ({ accepted: Promise.resolve(), result: new Promise(() => undefined) })),
  };
  let queuedRun: (() => Promise<void>) | null = null;
  const rollout = {
    isLeaseMember: vi.fn(async () => options.leaseMember),
    enqueue: vi.fn((request: { run: () => Promise<void> }) => {
      queuedRun = request.run;
      return new Promise<void>(() => undefined);
    }),
  };
  return {
    deps: { db, daemonUpdateService, dispatch, rollout } as never,
    daemonUpdateService,
    dispatch,
    rollout,
    runQueued: () => queuedRun!(),
  };
}

describe('dispatchNodeDaemonUpdate', () => {
  it('sends an update of a node outside every lease policy at once, as before', async () => {
    const { deps: d, dispatch, rollout, daemonUpdateService } = deps({ leaseMember: false });
    await expect(dispatchNodeDaemonUpdate('node-1', d)).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.11.0',
    });
    expect(daemonUpdateService.markNodeUpdateInProgress).toHaveBeenCalledWith('node-1', 'v2.11.0');
    expect(dispatch.sendUpdateDaemonCommand).toHaveBeenCalledOnce();
    expect(rollout.enqueue).not.toHaveBeenCalled();
  });

  it('queues the update of a lease member and sends it when the rollout lets it go', async () => {
    const { deps: d, dispatch, rollout, daemonUpdateService, runQueued } = deps({ leaseMember: true });
    await expect(dispatchNodeDaemonUpdate('node-1', d)).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.11.0',
      leaseSequenced: true,
    });
    expect(daemonUpdateService.markNodeUpdateInProgress).toHaveBeenCalledWith('node-1', 'v2.11.0', {
      waitForLeasePeers: true,
    });
    expect(rollout.enqueue).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'node-1' }));
    expect(dispatch.sendUpdateDaemonCommand).not.toHaveBeenCalled();

    await runQueued();
    expect(daemonUpdateService.beginQueuedNodeUpdate).toHaveBeenCalledWith('node-1', 'op-1');
    expect(dispatch.sendUpdateDaemonCommand).toHaveBeenCalledOnce();
    expect(daemonUpdateService.trackNodeUpdateCompletion).toHaveBeenCalledWith('node-1', 'op-1', expect.any(Promise));
  });

  it('does not send a queued update that expired or was replaced meanwhile', async () => {
    const { deps: d, dispatch, runQueued } = deps({ leaseMember: true, beginQueued: false });
    await dispatchNodeDaemonUpdate('node-1', d);
    await runQueued();
    expect(dispatch.sendUpdateDaemonCommand).not.toHaveBeenCalled();
  });

  it('keeps the reason on the node when a queued update cannot be sent', async () => {
    const { deps: d, dispatch, daemonUpdateService, runQueued } = deps({ leaseMember: true });
    dispatch.sendUpdateDaemonCommand.mockRejectedValue(new Error('Node disconnected'));
    await dispatchNodeDaemonUpdate('node-1', d);
    await expect(runQueued()).rejects.toThrow('Node disconnected');
    expect(daemonUpdateService.failNodeUpdate).toHaveBeenCalledWith('node-1', 'op-1', 'Node disconnected');
  });

  it('takes queued updates up again after a Gateway restart', async () => {
    const { deps: d, daemonUpdateService, rollout } = deps({ leaseMember: true });
    daemonUpdateService.listQueuedNodeUpdates.mockResolvedValue([{ nodeId: 'node-1', operationId: 'op-old' }]);
    await expect(resumeQueuedDaemonUpdates(d)).resolves.toBe(1);
    expect(daemonUpdateService.clearNodeUpdateInProgress).toHaveBeenCalledWith('node-1', 'op-old');
    expect(rollout.enqueue).toHaveBeenCalledOnce();
  });
});
