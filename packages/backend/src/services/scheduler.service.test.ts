import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './scheduler.service.js';

describe('SchedulerService shutdown', () => {
  it('waits for an active interval and prevents new callbacks after stop', async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerService();
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    scheduler.registerInterval('slow', 100, task);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    vi.useRealTimers();
  });
});
