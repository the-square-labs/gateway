import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainWebSocketsForRestart, terminateRemainingWebSockets } from './websocket-shutdown.js';

describe('WebSocket graceful shutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('sends a restart close frame immediately and terminates a stubborn peer at the boundary', async () => {
    vi.useFakeTimers();
    const client = { close: vi.fn(), terminate: vi.fn() };
    const clients = new Set([client]);
    const draining = drainWebSocketsForRestart(clients, Date.now() + 1_000);

    expect(client.close).toHaveBeenCalledWith(1012, 'Service Restart');
    await vi.advanceTimersByTimeAsync(1_000);
    await draining;

    terminateRemainingWebSockets(clients);
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it('does not terminate a peer that accepts the restart close frame', async () => {
    vi.useFakeTimers();
    const clients = new Set<{ close: () => void; terminate: () => void }>();
    const client = {
      close: vi.fn(() => clients.delete(client)),
      terminate: vi.fn(),
    };
    clients.add(client);

    const draining = drainWebSocketsForRestart(clients, Date.now() + 1_000);
    await draining;
    terminateRemainingWebSockets(clients);

    expect(client.close).toHaveBeenCalledOnce();
    expect(client.terminate).not.toHaveBeenCalled();
  });
});
