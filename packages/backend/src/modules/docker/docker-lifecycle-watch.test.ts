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
});
