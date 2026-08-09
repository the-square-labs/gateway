import { describe, expect, it, vi } from 'vitest';
import { shutdownGrpcServerInstance } from './server.js';

describe('bounded gRPC shutdown', () => {
  it('forces a server whose graceful shutdown does not finish', async () => {
    vi.useFakeTimers();
    const instance = { tryShutdown: vi.fn(), forceShutdown: vi.fn() };
    const stopping = shutdownGrpcServerInstance(instance, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(stopping).resolves.toBe(true);
    expect(instance.forceShutdown).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not force a server that stops gracefully', async () => {
    const instance = {
      tryShutdown: vi.fn((callback: () => void) => callback()),
      forceShutdown: vi.fn(),
    };
    await expect(shutdownGrpcServerInstance(instance, 3000)).resolves.toBe(false);
    expect(instance.forceShutdown).not.toHaveBeenCalled();
  });
});
