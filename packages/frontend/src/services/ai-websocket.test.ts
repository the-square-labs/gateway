import { AIWebSocketClient } from "./ai-websocket";

class PendingWebSocket {
  static readonly OPEN = 1;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  close() {}
  send() {}
}

describe("AIWebSocketClient reconnects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", PendingWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a reconnecting state instead of a per-attempt timeout", async () => {
    const client = new AIWebSocketClient();
    const onConnectionError = vi.fn();
    client.onConnectionError(onConnectionError);

    const initialAttempt = client.connect();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(initialAttempt).resolves.toBe(false);
    expect(onConnectionError).toHaveBeenLastCalledWith("Reconnecting...");
    expect(onConnectionError).not.toHaveBeenCalledWith("AI connection timed out");

    client.disconnect();
  });
});
