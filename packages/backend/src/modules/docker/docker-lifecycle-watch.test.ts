import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchDockerRecreateByName } from './docker-lifecycle-watch.js';

afterEach(() => {
  vi.useRealTimers();
});

function recreateWatchContext() {
  const taskService = { update: vi.fn().mockResolvedValue(undefined) };
  const context = {
    nodeDispatch: {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify([{ id: 'container-2', name: 'api', state: 'running' }]),
      }),
    },
    taskService,
    parseResult: (result: { detail?: string }) => JSON.parse(result.detail || 'null'),
    clearTransition: vi.fn(),
    emitContainer: vi.fn(),
    preserveContainerIdentity: vi.fn().mockResolvedValue(undefined),
    failTask: vi.fn().mockResolvedValue(undefined),
  };
  return { context, taskService };
}

describe('watchDockerRecreateByName finalization', () => {
  it('runs completion persistence before reporting task success', async () => {
    vi.useFakeTimers();
    const { context, taskService } = recreateWatchContext();
    const onComplete = vi.fn().mockResolvedValue(undefined);

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container env updated',
      'running',
      60000,
      onComplete
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(onComplete).toHaveBeenCalledWith('container-2');
    expect(taskService.update).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'succeeded', progress: 'Container env updated' })
    );
    expect(context.emitContainer).toHaveBeenCalledWith('node-1', 'api', 'container-2', 'recreated', {
      oldId: 'container-1',
    });
  });

  it('fails the task and suppresses success when completion persistence fails', async () => {
    vi.useFakeTimers();
    const { context, taskService } = recreateWatchContext();
    const onComplete = vi.fn().mockRejectedValue(new Error('env persistence failed'));

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container env updated',
      'running',
      60000,
      onComplete
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(context.failTask).toHaveBeenCalledWith('task-1', 'env persistence failed', 'node-1', 'api');
    expect(taskService.update).not.toHaveBeenCalled();
    expect(context.emitContainer).not.toHaveBeenCalled();
  });

  it('propagates an asynchronous daemon task failure without waiting for the watcher timeout', async () => {
    vi.useFakeTimers();
    const { context } = recreateWatchContext();
    context.nodeDispatch.sendDockerContainerCommand
      .mockResolvedValueOnce({ success: true, detail: JSON.stringify([]) })
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify({ id: 'daemon-task-1', status: 'failed', error: 'volume copy failed' }),
      });

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container recreated',
      'running',
      630000,
      undefined,
      'daemon-task-1'
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(context.nodeDispatch.sendDockerContainerCommand).toHaveBeenNthCalledWith(2, 'node-1', 'task_status', {
      containerId: 'daemon-task-1',
    });
    expect(context.failTask).toHaveBeenCalledWith('task-1', 'volume copy failed', 'node-1', 'api');
  });

  it('does not mistake a healthy rollback container for a successful recreate', async () => {
    vi.useFakeTimers();
    const { context, taskService } = recreateWatchContext();
    context.nodeDispatch.sendDockerContainerCommand
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify([{ id: 'rollback-container', name: 'api', state: 'running' }]),
      })
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify({
          id: 'daemon-task-1',
          status: 'failed',
          error: 'create container failed; original container restored',
        }),
      });

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container recreated',
      'running',
      630000,
      undefined,
      'daemon-task-1'
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(context.failTask).toHaveBeenCalledWith(
      'task-1',
      'create container failed; original container restored',
      'node-1',
      'api'
    );
    expect(taskService.update).not.toHaveBeenCalled();
    expect(context.emitContainer).not.toHaveBeenCalled();
  });

  it('accepts an actually running replacement while daemon task bookkeeping is still running', async () => {
    vi.useFakeTimers();
    const { context, taskService } = recreateWatchContext();
    context.nodeDispatch.sendDockerContainerCommand
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify([{ id: 'container-2', name: 'api', state: 'running' }]),
      })
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify({ id: 'daemon-task-1', status: 'running' }),
      })
      ;

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container recreated',
      'running',
      630000,
      undefined,
      'daemon-task-1'
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskService.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(context.emitContainer).toHaveBeenCalledWith('node-1', 'api', 'container-2', 'recreated', {
      oldId: 'container-1',
    });
  });

  it('falls back to replacement inspection when an older daemon does not support task status', async () => {
    vi.useFakeTimers();
    const { context, taskService } = recreateWatchContext();
    context.nodeDispatch.sendDockerContainerCommand
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify([{ id: 'container-2', name: 'api', state: 'running' }]),
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'unknown container action: task_status',
        detail: '',
      });

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container recreated',
      'running',
      630000,
      undefined,
      'daemon-task-1'
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(taskService.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(context.failTask).not.toHaveBeenCalled();
  });

  it('does not treat other daemon task-status failures as legacy compatibility responses', async () => {
    vi.useFakeTimers();
    const { context, taskService } = recreateWatchContext();
    context.parseResult = ((result: { success: boolean; error?: string; detail?: string }) => {
      if (!result.success) throw new Error(result.error || 'command failed');
      return JSON.parse(result.detail || 'null');
    }) as never;
    context.nodeDispatch.sendDockerContainerCommand
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify([{ id: 'container-2', name: 'api', state: 'running' }]),
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'docker task not found',
        detail: '',
      });

    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      'container-1',
      'task-1',
      'Container recreated',
      'running',
      630000,
      undefined,
      'daemon-task-1'
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(taskService.update).not.toHaveBeenCalled();
    expect(context.emitContainer).not.toHaveBeenCalled();
  });
});
