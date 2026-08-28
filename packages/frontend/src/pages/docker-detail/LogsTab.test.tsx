import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogsTab, type LogsTabSource, mergeReconnectLogLines } from "./LogsTab";

class FakeLogSocket {
  static instances: FakeLogSocket[] = [];

  readyState: number = WebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeLogSocket.instances.push(this);
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }

  send() {}
}

function source(): LogsTabSource {
  return {
    channelId: "node-1:container-1",
    title: "Container Logs",
    description: "test stream",
    state: "running",
    downloadFileName: "logs.txt",
    createWebSocket: () => new FakeLogSocket() as unknown as WebSocket,
    getLogs: vi.fn().mockResolvedValue([]),
  };
}

describe("LogsTab reconnect lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeLogSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects when Docker ends the follow stream during a restart", async () => {
    const view = render(<LogsTab source={source()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(FakeLogSocket.instances).toHaveLength(1);

    act(() => {
      FakeLogSocket.instances[0].onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ type: "logs_ended" }) })
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(FakeLogSocket.instances).toHaveLength(2);

    view.unmount();
  });

  it("merges reconnect tails without replacing the existing viewport history", () => {
    expect(
      mergeReconnectLogLines(["one", "two", "three"], ["older", "two", "three", "four", "five"])
    ).toEqual(["one", "two", "three", "four", "five"]);
  });
});
