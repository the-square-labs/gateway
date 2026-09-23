import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayLifecycleService } from './gateway-lifecycle.service.js';
import { ShutdownCoordinator, type ShutdownHooks, waitForShutdownTasks } from './shutdown-coordinator.service.js';

function hooks(overrides: Partial<ShutdownHooks> = {}): ShutdownHooks {
  return {
    freezeStatusPage: vi.fn().mockResolvedValue(undefined),
    quiesce: vi.fn().mockResolvedValue(undefined),
    drainUserWork: vi.fn().mockResolvedValue(undefined),
    drainOrchestration: vi.fn().mockResolvedValue(0),
    forceCloseUserWork: vi.fn().mockResolvedValue(undefined),
    closeLogging: vi.fn().mockResolvedValue(undefined),
    closeHttp: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    closeApplicationLogger: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ShutdownCoordinator', () => {
  afterEach(() => vi.useRealTimers());

  it('runs all phases once and exits cleanly', async () => {
    const lifecycle = new GatewayLifecycleService();
    const lifecycleHooks = hooks();
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      lifecycle,
      getSettings: () => ({
        userRequestDrainSeconds: 0,
        structuredLogDrainSeconds: 0,
        finalizationTimeoutSeconds: 5,
      }),
      hooks: lifecycleHooks,
      exit,
    });

    await coordinator.request('SIGTERM');

    expect(lifecycle.getState()).toBe('terminating');
    expect(lifecycleHooks.freezeStatusPage).toHaveBeenCalledOnce();
    expect(lifecycleHooks.quiesce).toHaveBeenCalledOnce();
    expect(lifecycleHooks.closeLogging).toHaveBeenCalledOnce();
    expect(lifecycleHooks.closeHttp).toHaveBeenCalledOnce();
    expect(lifecycleHooks.finalize).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('forces exit on a repeated signal without starting another shutdown', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const lifecycleHooks = hooks({ freezeStatusPage: vi.fn(() => blocked) });
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      lifecycle: new GatewayLifecycleService(),
      getSettings: () => ({
        userRequestDrainSeconds: 1,
        structuredLogDrainSeconds: 0,
        finalizationTimeoutSeconds: 5,
      }),
      hooks: lifecycleHooks,
      exit,
    });

    const first = coordinator.request('SIGTERM');
    coordinator.request('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    expect(lifecycleHooks.freezeStatusPage).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('forces exit when the global hard deadline is exhausted', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      lifecycle: new GatewayLifecycleService(),
      getSettings: () => ({
        userRequestDrainSeconds: 1,
        structuredLogDrainSeconds: 1,
        finalizationTimeoutSeconds: 5,
      }),
      hooks: hooks({ finalize: vi.fn(() => blocked) }),
      exit,
    });

    const stopping = coordinator.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(exit).toHaveBeenCalledWith(1);

    release();
    await stopping;
  });

  it('starts dependency finalization after the user deadline even when drain work never settles', async () => {
    vi.useFakeTimers();
    const blocked = new Promise<void>(() => undefined);
    const lifecycleHooks = hooks({ drainUserWork: vi.fn(() => blocked) });
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      lifecycle: new GatewayLifecycleService(),
      getSettings: () => ({
        userRequestDrainSeconds: 1,
        structuredLogDrainSeconds: 0,
        finalizationTimeoutSeconds: 5,
      }),
      hooks: lifecycleHooks,
      exit,
    });

    const stopping = coordinator.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(lifecycleHooks.finalize).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('waits for running orchestration work within the user drain deadline', async () => {
    vi.useFakeTimers();
    let finishOperations!: (remaining: number) => void;
    const operations = new Promise<number>((resolve) => (finishOperations = resolve));
    const lifecycleHooks = hooks({ drainOrchestration: vi.fn(() => operations) });
    const coordinator = new ShutdownCoordinator({
      lifecycle: new GatewayLifecycleService(),
      getSettings: () => ({
        userRequestDrainSeconds: 10,
        structuredLogDrainSeconds: 0,
        finalizationTimeoutSeconds: 5,
      }),
      hooks: lifecycleHooks,
      exit: vi.fn(),
    });

    const startedAt = Date.now();
    const stopping = coordinator.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(lifecycleHooks.drainOrchestration).toHaveBeenCalledWith(startedAt + 10_000);
    // User work is only force-closed once running operations finished.
    expect(lifecycleHooks.forceCloseUserWork).not.toHaveBeenCalled();

    finishOperations(0);
    await stopping;
    expect(lifecycleHooks.forceCloseUserWork).toHaveBeenCalledOnce();
    expect(lifecycleHooks.finalize).toHaveBeenCalledOnce();
  });

  it('bounds the dependency barrier and reports unresolved drain work', async () => {
    vi.useFakeTimers();
    const blocked = new Promise<void>(() => undefined);
    const waiting = waitForShutdownTasks([blocked], Date.now() + 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe(false);
  });
});
