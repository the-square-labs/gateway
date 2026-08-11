const invalidateCache = vi.fn();
const invalidateNodes = vi.fn();
const invalidatePinnedNodes = vi.fn();
const removePinnedDatabase = vi.fn();

vi.mock("@/services/api", () => ({
  api: {
    invalidateCache,
  },
}));

vi.mock("@/stores/nodes", () => ({
  useNodesStore: {
    getState: () => ({ invalidate: invalidateNodes }),
  },
}));

vi.mock("@/stores/pinned-nodes", () => ({
  usePinnedNodesStore: {
    getState: () => ({ invalidate: invalidatePinnedNodes }),
  },
}));

vi.mock("@/stores/pinned-databases", () => ({
  usePinnedDatabasesStore: {
    getState: () => ({ removePin: removePinnedDatabase }),
  },
}));

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("eventStream", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    invalidateCache.mockClear();
    invalidateNodes.mockClear();
    invalidatePinnedNodes.mockClear();
    removePinnedDatabase.mockClear();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(async () => {
    const { eventStream } = await import("@/services/event-stream");
    eventStream.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("subscribes to node.changed and invalidates node caches on incoming events", async () => {
    const { eventStream } = await import("@/services/event-stream");
    const handler = vi.fn();

    const unsubscribe = eventStream.subscribe("node.changed", handler);
    eventStream.start();
    vi.runAllTimers();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    expect(socket.sent).toContain(
      JSON.stringify({ type: "subscribe", channels: ["node.changed"] })
    );

    const payload = { id: "node-1", status: "offline" };
    socket.emit({ type: "event", channel: "node.changed", payload });
    await vi.advanceTimersByTimeAsync(750);
    await vi.dynamicImportSettled();

    expect(invalidateCache).toHaveBeenCalledWith("req:/api/nodes");
    expect(invalidateNodes).toHaveBeenCalledTimes(1);
    expect(invalidatePinnedNodes).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);

    unsubscribe();
  });

  it("invalidates GitLab integration and Docker registry caches on integration changes", async () => {
    const { eventStream } = await import("@/services/event-stream");
    const handler = vi.fn();

    const unsubscribe = eventStream.subscribe("integration.connector.changed", handler);
    eventStream.start();
    vi.runAllTimers();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    const payload = { id: "connector-1", provider: "gitlab", action: "synced" };
    socket.emit({ type: "event", channel: "integration.connector.changed", payload });

    expect(invalidateCache).toHaveBeenCalledWith("req:/api/integrations/gitlab/connectors");
    expect(invalidateCache).toHaveBeenCalledWith("settings:gitlab-connectors");
    expect(invalidateCache).toHaveBeenCalledWith("req:/api/integrations/cloudflare/connectors");
    expect(invalidateCache).toHaveBeenCalledWith("settings:cloudflare-connectors");
    expect(invalidateCache).toHaveBeenCalledWith("req:/api/docker/registries");
    expect(invalidateCache).toHaveBeenCalledWith("settings:docker-registries");
    expect(handler).toHaveBeenCalledWith(payload);

    unsubscribe();
  });

  it("coalesces noisy node.changed events before refetching", async () => {
    const { eventStream } = await import("@/services/event-stream");
    const handler = vi.fn();

    const unsubscribe = eventStream.subscribe("node.changed", handler);
    eventStream.start();
    vi.runAllTimers();

    const socket = MockWebSocket.instances[0];
    if (!socket) throw new Error("Expected websocket");
    socket.open();

    socket.emit({
      type: "event",
      channel: "node.changed",
      payload: { id: "node-1", status: "online" },
    });
    socket.emit({
      type: "event",
      channel: "node.changed",
      payload: { id: "node-1", status: "offline" },
    });
    socket.emit({
      type: "event",
      channel: "node.changed",
      payload: { id: "node-1", status: "online" },
    });

    await vi.advanceTimersByTimeAsync(749);
    await vi.dynamicImportSettled();
    expect(handler).not.toHaveBeenCalled();
    expect(invalidateNodes).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.dynamicImportSettled();

    expect(invalidateNodes).toHaveBeenCalledTimes(1);
    expect(invalidatePinnedNodes).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "node-1", status: "online" });

    unsubscribe();
  });

  it("removes deleted database pins from database.changed events", async () => {
    const { eventStream } = await import("@/services/event-stream");
    const handler = vi.fn();

    const unsubscribe = eventStream.subscribe("database.changed", handler);
    eventStream.start();
    vi.runAllTimers();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    const payload = { id: "db-1", action: "deleted" };
    socket.emit({ type: "event", channel: "database.changed", payload });

    expect(invalidateCache).toHaveBeenCalledWith("req:/api/databases");
    expect(removePinnedDatabase).toHaveBeenCalledWith("db-1");
    expect(handler).toHaveBeenCalledWith(payload);

    unsubscribe();
  });

  it("notifies reconnect listeners only after the first connection", async () => {
    const { eventStream } = await import("@/services/event-stream");
    const onReconnect = vi.fn();
    const unsubscribe = eventStream.onReconnect(onReconnect);
    eventStream.start();
    vi.runAllTimers();
    MockWebSocket.instances[0]?.open();
    expect(onReconnect).not.toHaveBeenCalled();

    MockWebSocket.instances[0]?.onclose?.({});
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.instances[1]?.open();

    expect(onReconnect).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("opens the restarting screen when the server closes the event stream for restart", async () => {
    const { eventStream } = await import("@/services/event-stream");
    const { useAppStatusStore } = await import("@/stores/app-status");
    useAppStatusStore.setState({ gatewayRestartingActive: false });
    eventStream.start();
    vi.runAllTimers();
    const socket = MockWebSocket.instances[0];
    socket?.open();

    socket?.onclose?.({ code: 1012, reason: "Service Restart" });

    expect(useAppStatusStore.getState().gatewayRestartingActive).toBe(true);
  });
});
