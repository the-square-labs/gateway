import { describe, expect, it, vi } from 'vitest';
import { DockerTaskService } from './docker-task.service.js';

describe('DockerTaskService', () => {
  it('marks stale active tasks as failed and emits updates', async () => {
    const staleTask = {
      id: 'task-1',
      nodeId: '11111111-1111-4111-8111-111111111111',
      status: 'failed',
      progress: null,
      error: 'Timed out after backend restart or lost task watcher',
    };
    const returning = vi.fn().mockResolvedValue([staleTask]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const publish = vi.fn();
    const service = new DockerTaskService({ update } as never);
    service.setEventBus({ publish } as never);

    await expect(service.markStaleActiveTasksFailed(new Date('2026-04-30T12:00:00Z'))).resolves.toBe(1);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Timed out after backend restart or lost task watcher',
      })
    );
    expect(publish).toHaveBeenCalledWith(
      'docker.task.changed',
      expect.objectContaining({
        taskId: staleTask.id,
        nodeId: staleTask.nodeId,
        status: 'failed',
        error: staleTask.error,
      })
    );
  });

  it('marks active tasks as lost during startup and emits updates', async () => {
    const lostTask = {
      id: 'task-1',
      nodeId: '11111111-1111-4111-8111-111111111111',
      status: 'failed',
      progress: null,
      error: 'Task tracking interrupted by backend restart',
    };
    const returning = vi.fn().mockResolvedValue([lostTask]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const publish = vi.fn();
    const service = new DockerTaskService({ update } as never);
    service.setEventBus({ publish } as never);

    await expect(service.markActiveTasksLostOnStartup(new Date('2026-04-30T12:00:00Z'))).resolves.toBe(1);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Task tracking interrupted by backend restart',
        completedAt: expect.any(Date),
      })
    );
    expect(publish).toHaveBeenCalledWith(
      'docker.task.changed',
      expect.objectContaining({
        taskId: lostTask.id,
        nodeId: lostTask.nodeId,
        status: 'failed',
        error: lostTask.error,
      })
    );
  });

  it('force-cancels active tasks and emits updates', async () => {
    const existingTask = {
      id: 'task-1',
      nodeId: '11111111-1111-4111-8111-111111111111',
      containerId: 'container-1',
      containerName: 'api',
      status: 'running',
    };
    const cancelledTask = {
      ...existingTask,
      status: 'failed',
      progress: null,
      error: 'Force-cancelled by user',
    };
    const selectLimit = vi.fn().mockResolvedValue([existingTask]);
    const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });
    const returning = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([cancelledTask]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set });
    const publish = vi.fn();
    const terminal = vi.fn();
    const service = new DockerTaskService({ select, update } as never);
    service.setEventBus({ publish } as never);
    service.setContainerTaskTerminalHandler(terminal);

    await expect(service.forceCancel('task-1')).resolves.toEqual(cancelledTask);

    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Force-cancelled by user',
        completedAt: expect.any(Date),
      })
    );
    expect(publish).toHaveBeenCalledWith(
      'docker.task.changed',
      expect.objectContaining({
        taskId: cancelledTask.id,
        nodeId: cancelledTask.nodeId,
        status: 'failed',
        error: cancelledTask.error,
      })
    );
    expect(terminal).toHaveBeenCalledWith({
      nodeId: existingTask.nodeId,
      containerId: existingTask.containerId,
      containerName: existingTask.containerName,
    });
  });

  it('rejects force-cancel for completed tasks', async () => {
    const selectLimit = vi.fn().mockResolvedValue([{ id: 'task-1', status: 'succeeded' }]);
    const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const service = new DockerTaskService({ select, update } as never);

    await expect(service.forceCancel('task-1')).rejects.toMatchObject({
      code: 'TASK_NOT_ACTIVE',
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Timed out after backend restart or lost task watcher',
      })
    );
  });
});
