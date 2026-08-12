import { AIWebSocketClient } from "./ai-websocket";

class PendingWebSocket {
  static readonly OPEN = 1;
  static instances: PendingWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    PendingWebSocket.instances.push(this);
  }

  close() {}
  send(message: string) {
    this.sent.push(message);
  }
}

describe("AIWebSocketClient reconnects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    PendingWebSocket.instances = [];
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

  it("does not send commands until websocket authentication completes", async () => {
    const client = new AIWebSocketClient();
    const connecting = client.connect();
    const socket = PendingWebSocket.instances[0];
    socket.readyState = PendingWebSocket.OPEN;

    expect(() => client.send({ type: "ping" })).toThrow("AI connection is not open");

    socket.onmessage?.({
      data: JSON.stringify({ type: "auth_ok", userId: "user-1" }),
    } as MessageEvent);

    await expect(connecting).resolves.toBe(true);
    expect(client.send({ type: "ping" })).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ type: "ping" })]);

    client.disconnect();
  });

  it("keeps reconnecting after repeated network failures", async () => {
    const client = new AIWebSocketClient();
    const onConnectionError = vi.fn();
    client.onConnectionError(onConnectionError);

    void client.connect();
    for (let attempt = 0; attempt < 7; attempt++) {
      const socket = PendingWebSocket.instances[attempt];
      socket.onerror?.();
      await vi.advanceTimersByTimeAsync(reconnectDelayForAttempt(attempt));
    }

    expect(PendingWebSocket.instances).toHaveLength(8);
    expect(onConnectionError).toHaveBeenLastCalledWith("Reconnecting...");
    expect(onConnectionError).not.toHaveBeenCalledWith("AI connection failed");
    expect(onConnectionError).not.toHaveBeenCalledWith("AI connection unavailable");

    client.disconnect();
  });
});

function reconnectDelayForAttempt(attempt: number): number {
  return [1000, 2000, 4000, 8000, 8000][attempt] ?? 8000;
}
