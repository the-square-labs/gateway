import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBusService } from '@/services/event-bus.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function createReconciler(dispatchOverrides: Record<string, unknown> = {}) {
  const deletedNodes = new Set<string>();
  const snapshots = {
    markListRefreshing: vi.fn().mockResolvedValue(undefined),
    replaceList: vi.fn().mockResolvedValue(undefined),
    reconcileComposeProjects: vi.fn().mockResolvedValue(undefined),
    markListError: vi.fn().mockResolvedValue(undefined),
    replaceDetail: vi.fn().mockResolvedValue(undefined),
    markDetailError: vi.fn().mockResolvedValue(undefined),
    getList: vi.fn().mockResolvedValue({ data: [] }),
    getDetail: vi.fn().mockResolvedValue(null),
    getDetails: vi.fn().mockResolvedValue({}),
    purgeNode: vi.fn().mockResolvedValue(undefined),
    publishNodeAvailability: vi.fn().mockResolvedValue(undefined),
    markNodeDeleted: vi.fn((nodeId: string) => deletedNodes.add(nodeId)),
    reviveNode: vi.fn((nodeId: string) => deletedNodes.delete(nodeId)),
    isNodeDeleted: vi.fn((nodeId: string) => deletedNodes.has(nodeId)),
  };
  const ok = { success: true, detail: '[]' };
  const dispatch = {
    sendDockerContainerCommand: vi.fn().mockResolvedValue(ok),
    sendDockerImageCommand: vi.fn().mockResolvedValue(ok),
    sendDockerVolumeCommand: vi.fn().mockResolvedValue(ok),
    sendDockerNetworkCommand: vi.fn().mockResolvedValue(ok),
    ...dispatchOverrides,
  };
  const registry = {
    getNodesByType: vi.fn().mockReturnValue([]),
    getNode: vi.fn((nodeId: string) => ({ nodeId, type: 'docker' })),
  };
  const eventBus = new EventBusService();
  const reconciler = new DockerSnapshotReconciler(snapshots as never, dispatch as never, registry as never, eventBus);
  return { reconciler, snapshots, dispatch, registry, eventBus };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerSnapshotReconciler', () => {
  it('forces and awaits an immediate snapshot refresh', async () => {
    const { reconciler, snapshots, dispatch } = createReconciler();

    await reconciler.refreshNow('node-1', 'containers');

    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'list', {}, 10_000);
    expect(snapshots.replaceList).toHaveBeenCalledWith('node-1', 'containers', []);
    expect(snapshots.reconcileComposeProjects).toHaveBeenCalledWith('node-1');
  });

  it('collects volume metrics through the snapshot reconciler instead of the request path', async () => {
    const metrics = {
      storageKind: 'regular',
      usedBytes: 42,
      runningAttachmentCount: 1,
      collectedAt: '2026-08-24T12:00:00.000Z',
    };
    const sendDockerVolumeCommand = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify(metrics),
    });
    const { reconciler, snapshots } = createReconciler({ sendDockerVolumeCommand });

    await reconciler.refreshNow('node-1', 'volume-metrics', 'data');

    expect(sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'metrics', { name: 'data' }, 60_000);
    expect(snapshots.replaceDetail).toHaveBeenCalledWith('node-1', 'volume-metrics', 'data', metrics);
  });

  it('inspects a recreated container by its current stable name instead of a stale runtime ID', async () => {
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ Id: 'new-id', Name: '/api' }),
    });
    const { reconciler, snapshots } = createReconciler({ sendDockerContainerCommand });
    snapshots.getList.mockResolvedValue({ data: [{ id: 'new-id', name: 'api' }] });
    snapshots.getDetail.mockResolvedValue({ data: { Id: 'old-id', Name: '/api' } });

    await reconciler.refreshNow('node-1', 'container-detail', 'old-id');

    expect(sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'inspect', { containerId: 'api' }, 10_000);
    expect(sendDockerContainerCommand).not.toHaveBeenCalledWith('node-1', 'inspect', { containerId: 'old-id' }, 10_000);
    expect(snapshots.replaceDetail).toHaveBeenCalledWith('node-1', 'container-detail', 'old-id', {
      Id: 'new-id',
      Name: '/api',
    });
  });

  it('coalesces an in-flight duplicate into exactly one follow-up refresh', async () => {
    const first = deferred<{ success: boolean; detail: string }>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler } = createReconciler({ sendDockerContainerCommand: send });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    first.resolve({ success: true, detail: '[]' });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'node-1', 'list', {}, 10_000);
  });

  it('does not let a hung node block another node refresh', async () => {
    const hung = deferred<{ success: boolean; detail: string }>();
    const send = vi.fn((nodeId: string) =>
      nodeId === 'node-1' ? hung.promise : Promise.resolve({ success: true, detail: '[]' })
    );
    const { reconciler, snapshots } = createReconciler({ sendDockerContainerCommand: send });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    reconciler.enqueue({ nodeId: 'node-2', kind: 'containers' });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(snapshots.replaceList).toHaveBeenCalledWith('node-2', 'containers', []));
    expect(snapshots.replaceList).not.toHaveBeenCalledWith('node-1', 'containers', []);
    hung.resolve({ success: true, detail: '[]' });
  });

  it('serializes different refresh kinds for the same node', async () => {
    const first = deferred<{ success: boolean; detail: string }>();
    const containerSend = vi.fn(() => first.promise);
    const imageSend = vi.fn().mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler } = createReconciler({
      sendDockerContainerCommand: containerSend,
      sendDockerImageCommand: imageSend,
    });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    reconciler.enqueue({ nodeId: 'node-1', kind: 'images' });
    await vi.waitFor(() => expect(containerSend).toHaveBeenCalledTimes(1));
    expect(imageSend).not.toHaveBeenCalled();
    first.resolve({ success: true, detail: '[]' });
    await vi.waitFor(() => expect(imageSend).toHaveBeenCalledTimes(1));
  });

  it('does not let slow volume metrics block inventory refreshes for the same node', async () => {
    const metrics = deferred<{ success: boolean; detail: string }>();
    const sendDockerVolumeCommand = vi.fn(() => metrics.promise);
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler, snapshots } = createReconciler({
      sendDockerVolumeCommand,
      sendDockerContainerCommand,
    });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'volume-metrics', key: 'data' });
    await vi.waitFor(() => expect(sendDockerVolumeCommand).toHaveBeenCalledTimes(1));
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });

    await vi.waitFor(() => expect(sendDockerContainerCommand).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(snapshots.replaceList).toHaveBeenCalledWith('node-1', 'containers', []));
    expect(snapshots.replaceDetail).not.toHaveBeenCalledWith('node-1', 'volume-metrics', 'data', expect.anything());

    metrics.resolve({ success: true, detail: '{"usedBytes":42}' });
    await vi.waitFor(() =>
      expect(snapshots.replaceDetail).toHaveBeenCalledWith('node-1', 'volume-metrics', 'data', { usedBytes: 42 })
    );
  });

  it('reserves global refresh capacity while slow volume metrics are running', async () => {
    const pendingMetrics = Array.from({ length: 4 }, () => deferred<{ success: boolean; detail: string }>());
    const sendDockerVolumeCommand = vi.fn((nodeId: string) => pendingMetrics[Number(nodeId.slice(-1)) - 1]!.promise);
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler } = createReconciler({ sendDockerVolumeCommand, sendDockerContainerCommand });

    for (let index = 1; index <= 4; index += 1) {
      reconciler.enqueue({ nodeId: `node-${index}`, kind: 'volume-metrics', key: 'data' });
    }
    reconciler.enqueue({ nodeId: 'node-5', kind: 'containers' });

    await vi.waitFor(() => expect(sendDockerVolumeCommand).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sendDockerContainerCommand).toHaveBeenCalledTimes(1));

    for (const pending of pendingMetrics) pending.resolve({ success: true, detail: '{}' });
    await vi.waitFor(() => expect(sendDockerVolumeCommand).toHaveBeenCalledTimes(4));
  });

  it('turns a write event into targeted list/detail refreshes without purging old data', async () => {
    const sendDockerContainerCommand = vi.fn((_nodeId: string, action: string) =>
      Promise.resolve({
        success: true,
        detail: action === 'list' ? JSON.stringify([{ id: 'container-1', name: 'web' }]) : '{}',
      })
    );
    const { reconciler, dispatch, snapshots, eventBus } = createReconciler({ sendDockerContainerCommand });
    snapshots.getList.mockResolvedValue({ data: [{ id: 'container-1', name: 'web' }] });
    reconciler.start();

    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-1',
      name: 'web',
      action: 'updated',
    });

    await vi.waitFor(() =>
      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'list', {}, 10_000)
    );
    await vi.waitFor(() =>
      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith(
        'node-1',
        'inspect',
        { containerId: 'web' },
        10_000
      )
    );
    expect(snapshots.purgeNode).not.toHaveBeenCalled();
    reconciler.stop();
  });

  it('does not persist a transient exited inspect while a container recreate is active', async () => {
    let currentContainer = { id: 'container-old', name: 'web' };
    const sendDockerContainerCommand = vi.fn((_nodeId: string, action: string) =>
      Promise.resolve({
        success: true,
        detail: action === 'list' ? JSON.stringify([currentContainer]) : '{}',
      })
    );
    const { reconciler, dispatch, snapshots, eventBus } = createReconciler({ sendDockerContainerCommand });
    snapshots.getList.mockImplementation(async () => ({ data: [currentContainer] }));
    reconciler.start();

    currentContainer = { id: 'container-new', name: 'web' };
    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-old',
      name: 'web',
      action: 'transitioning',
      transition: 'recreating',
    });
    await vi.waitFor(() =>
      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'list', {}, 10_000)
    );
    dispatch.sendDockerContainerCommand.mockClear();

    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-old',
      name: 'web',
      action: 'updated',
      state: 'exited',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalledWith(
      'node-1',
      'inspect',
      expect.anything(),
      10_000
    );
    expect(snapshots.replaceDetail).not.toHaveBeenCalledWith(
      'node-1',
      'container-detail',
      expect.anything(),
      expect.anything()
    );

    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-new',
      oldId: 'container-old',
      name: 'web',
      action: 'recreated',
    });

    await vi.waitFor(() =>
      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith(
        'node-1',
        'inspect',
        { containerId: 'web' },
        10_000
      )
    );
    reconciler.stop();
  });

  it('does not dispatch an explicit detail refresh while a container recreate is active', async () => {
    const { reconciler, dispatch, eventBus } = createReconciler();
    reconciler.start();

    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-old',
      name: 'web',
      action: 'transitioning',
      transition: 'updating',
    });
    await vi.waitFor(() =>
      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'list', {}, 10_000)
    );
    dispatch.sendDockerContainerCommand.mockClear();

    await reconciler.refreshNow('node-1', 'container-detail', 'web');

    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalledWith(
      'node-1',
      'inspect',
      expect.anything(),
      10_000
    );
    reconciler.stop();
  });

  it('keeps the previous container inventory entry visible until recreate completes', async () => {
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify([{ id: 'container-new', name: 'web', state: 'created' }]),
    });
    const { reconciler, snapshots, eventBus } = createReconciler({ sendDockerContainerCommand });
    snapshots.getList.mockResolvedValue({
      data: [{ id: 'container-old', name: 'web', state: 'created' }],
    });
    reconciler.start();

    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-old',
      name: 'web',
      action: 'transitioning',
      transition: 'updating',
    });

    await vi.waitFor(() =>
      expect(snapshots.replaceList).toHaveBeenCalledWith('node-1', 'containers', [
        { id: 'container-old', name: 'web', state: 'created' },
      ])
    );

    snapshots.replaceList.mockClear();
    eventBus.publish('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-old',
      name: 'web',
      action: 'transitioning',
      transition: null,
    });

    await vi.waitFor(() =>
      expect(snapshots.replaceList).toHaveBeenCalledWith('node-1', 'containers', [
        { id: 'container-new', name: 'web', state: 'created' },
      ])
    );
    reconciler.stop();
  });

  it('purges on explicit deletion and refreshes all inventory kinds on reconnect', async () => {
    const { reconciler, dispatch, snapshots, eventBus } = createReconciler();
    reconciler.start();
    eventBus.publish('node.changed', { id: 'node-1', action: 'deleted' });
    await vi.waitFor(() => expect(snapshots.purgeNode).toHaveBeenCalledWith('node-1'));

    eventBus.publish('node.changed', { id: 'node-1', action: 'updated', status: 'online' });
    await vi.waitFor(() => expect(dispatch.sendDockerContainerCommand).toHaveBeenCalled());
    await vi.waitFor(() => expect(dispatch.sendDockerImageCommand).toHaveBeenCalled());
    await vi.waitFor(() => expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalled());
    await vi.waitFor(() => expect(dispatch.sendDockerNetworkCommand).toHaveBeenCalled());
    reconciler.stop();
  });

  it('announces snapshot availability changes when a node disconnects', async () => {
    const { reconciler, snapshots, eventBus } = createReconciler();
    reconciler.start();

    eventBus.publish('node.changed', { id: 'node-1', action: 'updated', status: 'offline' });

    await vi.waitFor(() => expect(snapshots.publishNodeAvailability).toHaveBeenCalledWith('node-1'));
    reconciler.stop();
  });

  it('automatically retries a failed job after 10 seconds without accumulating duplicates', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler } = createReconciler({ sendDockerContainerCommand: send });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('cancels a failed queued retry when its node is explicitly deleted', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error('timeout'));
    const { reconciler, eventBus, snapshots } = createReconciler({ sendDockerContainerCommand: send });
    reconciler.start();

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    eventBus.publish('node.changed', { id: 'node-1', action: 'deleted' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(snapshots.purgeNode).toHaveBeenCalledWith('node-1');
    reconciler.stop();
  });

  it('discards an in-flight success after node deletion instead of recreating snapshots', async () => {
    const pending = deferred<{ success: boolean; detail: string }>();
    const send = vi.fn(() => pending.promise);
    const { reconciler, eventBus, snapshots } = createReconciler({ sendDockerContainerCommand: send });
    reconciler.start();

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventBus.publish('node.changed', { id: 'node-1', action: 'deleted' });
    pending.resolve({ success: true, detail: '[{"id":"late"}]' });
    await vi.waitFor(() => expect(snapshots.purgeNode).toHaveBeenCalledWith('node-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(snapshots.replaceList).not.toHaveBeenCalledWith('node-1', 'containers', [{ id: 'late' }]);
    reconciler.stop();
  });

  it('lets an urgent refresh bypass an existing backoff without adding duplicates', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler } = createReconciler({ sendDockerContainerCommand: send });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' }, { urgent: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('runs an urgent dirty follow-up immediately when the in-flight attempt fails', async () => {
    vi.useFakeTimers();
    const first = deferred<{ success: boolean; detail: string }>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ success: true, detail: '[]' });
    const { reconciler } = createReconciler({ sendDockerContainerCommand: send });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' });
    await vi.advanceTimersByTimeAsync(0);
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' }, { urgent: true });
    first.reject(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('runs an urgent list before queued background details', async () => {
    const first = deferred<{ success: boolean; detail: string }>();
    const calls: string[] = [];
    const containerSend = vi.fn((_nodeId: string, action: string, options: { containerId?: string }) => {
      calls.push(action === 'inspect' ? `inspect:${options.containerId}` : action);
      if (action === 'inspect' && options.containerId === 'first') return first.promise;
      return Promise.resolve({ success: true, detail: action === 'list' ? '[]' : '{}' });
    });
    const { reconciler, snapshots } = createReconciler({ sendDockerContainerCommand: containerSend });
    snapshots.getList.mockResolvedValue({ data: [{ name: 'first' }, { name: 'second' }] });

    reconciler.enqueue({ nodeId: 'node-1', kind: 'container-detail', key: 'first' });
    reconciler.enqueue({ nodeId: 'node-1', kind: 'container-detail', key: 'second' });
    reconciler.enqueue({ nodeId: 'node-1', kind: 'containers' }, { urgent: true });
    first.resolve({ success: true, detail: '{}' });

    await vi.waitFor(() => expect(calls).toContain('inspect:second'));
    expect(calls).toEqual(['inspect:first', 'list', 'inspect:second']);
  });

  it('enqueues stale details in bounded round-robin batches', async () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ name: `container-${index}` }));
    const { reconciler, snapshots, registry, dispatch } = createReconciler();
    registry.getNodesByType.mockReturnValue([{ nodeId: 'node-1' }]);
    snapshots.getList.mockImplementation(async (_nodeId: string, kind: string) => ({
      data: kind === 'containers' ? items : [],
    }));

    await reconciler.enqueueDueDetails();
    await vi.waitFor(() => expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(snapshots.replaceDetail).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch.sendDockerContainerCommand.mock.calls.map((call) => call[2])).toEqual([
      { containerId: 'container-0' },
      { containerId: 'container-1' },
    ]);

    await reconciler.enqueueDueDetails();
    await vi.waitFor(() => expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(4));
    expect(dispatch.sendDockerContainerCommand.mock.calls.slice(2).map((call) => call[2])).toEqual([
      { containerId: 'container-2' },
      { containerId: 'container-3' },
    ]);
  });

  it('background-refreshes volume metrics from the volume inventory', async () => {
    const sendDockerVolumeCommand = vi.fn((_nodeId: string, action: string) =>
      Promise.resolve({ success: true, detail: action === 'metrics' ? '{"usedBytes":42}' : '{}' })
    );
    const { reconciler, snapshots, registry } = createReconciler({ sendDockerVolumeCommand });
    registry.getNodesByType.mockReturnValue([{ nodeId: 'node-1' }]);
    snapshots.getList.mockImplementation(async (_nodeId: string, kind: string) => ({
      data: kind === 'volumes' ? [{ name: 'data' }] : [],
    }));

    await reconciler.enqueueDueDetails();

    await vi.waitFor(() =>
      expect(sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'metrics', { name: 'data' }, 60_000)
    );
    await vi.waitFor(() =>
      expect(snapshots.replaceDetail).toHaveBeenCalledWith('node-1', 'volume-metrics', 'data', { usedBytes: 42 })
    );
  });

  it('does not grow the background detail backlog across ticks on a slow node', async () => {
    const first = deferred<{ success: boolean; detail: string }>();
    const second = deferred<{ success: boolean; detail: string }>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const items = Array.from({ length: 7 }, (_, index) => ({ name: `container-${index}` }));
    const { reconciler, snapshots, registry } = createReconciler({ sendDockerContainerCommand: send });
    registry.getNodesByType.mockReturnValue([{ nodeId: 'node-1' }]);
    snapshots.getList.mockImplementation(async (_nodeId: string, kind: string) => ({
      data: kind === 'containers' ? items : [],
    }));

    await reconciler.enqueueDueDetails();
    await reconciler.enqueueDueDetails();
    await reconciler.enqueueDueDetails();
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve({ success: true, detail: '{}' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    second.resolve({ success: true, detail: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refreshes a third resource while two persistent failures remain in backoff', async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ name: `container-${index}` }));
    const send = vi.fn((_nodeId: string, _action: string, options: { containerId?: string }) =>
      options.containerId === 'container-2'
        ? Promise.resolve({ success: true, detail: '{}' })
        : Promise.reject(new Error('persistent failure'))
    );
    const { reconciler, snapshots, registry } = createReconciler({ sendDockerContainerCommand: send });
    registry.getNodesByType.mockReturnValue([{ nodeId: 'node-1' }]);
    snapshots.getList.mockImplementation(async (_nodeId: string, kind: string) => ({
      data: kind === 'containers' ? items : [],
    }));

    await reconciler.enqueueDueDetails();
    await vi.waitFor(() => expect(snapshots.markDetailError).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reconciler.enqueueDueDetails();

    await vi.waitFor(() =>
      expect(snapshots.replaceDetail).toHaveBeenCalledWith('node-1', 'container-detail', 'container-2', {})
    );
    expect(send.mock.calls.map((call) => call[2])).toEqual([
      { containerId: 'container-0' },
      { containerId: 'container-1' },
      { containerId: 'container-2' },
    ]);
  });

  it('cancels queued and in-flight detail jobs removed from the latest list', async () => {
    const first = deferred<{ success: boolean; detail: string }>();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ success: true, detail: '{}' });
    let items = [{ name: 'removed-inflight' }, { name: 'removed-queued' }];
    const { reconciler, snapshots, registry } = createReconciler({ sendDockerContainerCommand: send });
    registry.getNodesByType.mockReturnValue([{ nodeId: 'node-1' }]);
    snapshots.getList.mockImplementation(async (_nodeId: string, kind: string) => ({
      data: kind === 'containers' ? items : [],
    }));

    await reconciler.enqueueDueDetails();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    items = [{ name: 'current' }];
    await reconciler.enqueueDueDetails();
    first.resolve({ success: true, detail: '{}' });

    await vi.waitFor(() =>
      expect(snapshots.replaceDetail).toHaveBeenCalledWith('node-1', 'container-detail', 'current', {})
    );
    expect(send.mock.calls.map((call) => call[2])).toEqual([
      { containerId: 'removed-inflight' },
      { containerId: 'current' },
    ]);
    expect(snapshots.replaceDetail).not.toHaveBeenCalledWith('node-1', 'container-detail', 'removed-inflight', {});
  });
});
