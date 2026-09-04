import { act, render, screen } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogsTab, type LogsTabSource, mergeReconnectLogLines } from "./LogsTab";

vi.mock("./DockerLogViewport", () => ({
  DockerLogViewport: ({
    lines,
    renderContent,
  }: {
    lines: unknown[];
    renderContent?: (line: unknown) => ReactNode;
  }) => (
    <div data-testid="log-output">
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index ? "\n" : ""}
          {typeof line === "string" ? line : renderContent?.(line)}
        </Fragment>
      ))}
    </div>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

class FakeLogSocket {
  static instances: FakeLogSocket[] = [];

  readyState: number = WebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeLogSocket.instances.push(this);
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
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

  it("replaces history when switching A to B to A and ignores late messages from old sockets", async () => {
    const first = source();
    const second = { ...source(), channelId: "node-2:container-2" };
    const view = render(<LogsTab source={first} />);
    const emit = (socket: FakeLogSocket, type: string, lines: string[]) =>
      act(() => {
        socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type, lines }) }));
      });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const oldSocket = FakeLogSocket.instances[0];
    emit(oldSocket, "initial", ["A1", "A2"]);
    view.rerender(<LogsTab source={second} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    emit(FakeLogSocket.instances[1], "initial", ["B1"]);
    emit(oldSocket, "new", ["stale-A"]);
    expect(screen.getByTestId("log-output").textContent).toBe("B1");
    view.rerender(<LogsTab source={first} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    emit(FakeLogSocket.instances[2], "initial", ["A1", "A2"]);
    expect(screen.getByTestId("log-output").textContent).toBe("A1\nA2");
    expect(oldSocket.readyState).toBe(WebSocket.CLOSED);
  });
});

function aggregateSource(channelId: string, title = channelId): LogsTabSource {
  return {
    ...source(),
    channelId,
    title,
    createWebSocket: vi.fn(() => new FakeLogSocket() as unknown as WebSocket),
  };
}

function emit(socket: FakeLogSocket, message: Record<string, unknown>) {
  act(() => socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })));
}

describe("Aggregated LogsTab recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeLogSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects only the ended source after three seconds and merges its tail without cross-source deduplication", async () => {
    const first = aggregateSource("one", "same title");
    const second = aggregateSource("two", "same title");
    const view = render(<LogsTab sources={[first, second]} />);
    const [a, b] = FakeLogSocket.instances;
    emit(a, { type: "initial", lines: ["A1", "shared"] });
    emit(b, { type: "initial", lines: ["B1", "shared"] });
    emit(a, { type: "logs_ended" });
    expect(a.readyState).toBe(WebSocket.CLOSED);
    expect(b.readyState).toBe(WebSocket.OPEN);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(first.createWebSocket).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(first.createWebSocket).toHaveBeenCalledTimes(2);
    expect(second.createWebSocket).toHaveBeenCalledTimes(1);
    const replacement = FakeLogSocket.instances[2];
    emit(replacement, { type: "initial", lines: ["older", "A1", "shared", "A2"] });
    emit(replacement, { type: "new", lines: ["fresh live line"] });
    emit(b, { type: "new", lines: ["B2"] });
    expect(screen.getByTestId("log-output").textContent).toBe(
      ["A1", "shared", "B1", "shared", "A2", "fresh live line", "B2"]
        .map((line) => `[same title]${line}`)
        .join("\n")
    );
    view.unmount();
  });

  it("keeps equivalent source arrays connected and uses the latest factory on reconnect", async () => {
    const first = aggregateSource("one");
    const second = aggregateSource("two");
    const view = render(<LogsTab sources={[first, second]} />);
    const [a, b] = FakeLogSocket.instances;
    emit(a, { type: "initial", lines: ["preserved"] });
    const latestFirst = aggregateSource("one");
    const latestSecond = aggregateSource("two");
    view.rerender(<LogsTab sources={[latestFirst, latestSecond]} />);
    expect(FakeLogSocket.instances).toHaveLength(2);
    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(screen.getByText("preserved")).toBeInTheDocument();
    emit(a, { type: "logs_ended" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(latestFirst.createWebSocket).toHaveBeenCalledExactlyOnceWith(200);
    expect(latestSecond.createWebSocket).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    { type: "auth_error", message: "Session expired" },
    { type: "error", message: "No such container" },
    { type: "error", message: "Container not found" },
    { type: "error", message: "Access denied" },
    { type: "error", message: "Unauthorized" },
    { type: "error", message: "Forbidden" },
  ])("does not retry terminal $type: $message", async (message) => {
    const first = aggregateSource("one");
    const second = aggregateSource("two");
    const view = render(<LogsTab sources={[first, second]} />);
    const [a, b] = FakeLogSocket.instances;
    emit(a, message);
    expect(a.readyState).toBe(WebSocket.CLOSED);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(first.createWebSocket).toHaveBeenCalledTimes(1);
    expect(second.createWebSocket).toHaveBeenCalledTimes(1);
    emit(b, { type: "new", lines: ["other source stays live"] });
    expect(screen.getByText("other source stays live")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(message.message);
    view.unmount();
  });

  it("ignores stale terminal/message/close handlers after reconnect", async () => {
    const first = aggregateSource("one");
    const view = render(<LogsTab sources={[first]} />);
    const old = FakeLogSocket.instances[0];
    const oldMessage = old.onmessage!;
    const oldClose = old.onclose!;
    const oldError = old.onerror!;
    emit(old, { type: "initial", lines: ["history"] });
    emit(old, { type: "logs_ended" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const replacement = FakeLogSocket.instances[1];
    act(() => {
      oldMessage(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "auth_error", message: "stale denial" }),
        })
      );
      oldMessage(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "new", lines: ["stale line"] }),
        })
      );
      oldClose(new CloseEvent("close", { code: 1008 }));
      oldError();
    });
    emit(replacement, { type: "initial", lines: ["history", "fresh"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(FakeLogSocket.instances).toHaveLength(2);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
    expect(screen.getByTestId("log-output").textContent).toBe("[one]history\n[one]fresh");
    expect(toast.error).not.toHaveBeenCalled();
    view.unmount();
  });

  it("cancels timers and ignores late callbacks when the source runtime changes or the view unmounts", async () => {
    const first = { ...aggregateSource("one"), runtimeKey: "old" };
    const second = aggregateSource("two");
    const view = render(<LogsTab sources={[first, second]} />);
    const [a, b] = FakeLogSocket.instances;
    const lateMessage = b.onmessage!;
    emit(a, { type: "logs_ended" });
    view.rerender(<LogsTab sources={[{ ...first, runtimeKey: "new" }, second]} />);
    expect(b.readyState).toBe(WebSocket.CLOSED);
    act(() =>
      lateMessage(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "error", message: "late error" }),
        })
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(FakeLogSocket.instances).toHaveLength(4);
    emit(FakeLogSocket.instances[2], { type: "logs_ended" });
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(FakeLogSocket.instances).toHaveLength(4);
    expect(FakeLogSocket.instances.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(
      true
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the global cap while appending fresh reconnect lines to full history", async () => {
    const view = render(<LogsTab sources={[aggregateSource("one")]} />);
    emit(FakeLogSocket.instances[0], {
      type: "initial",
      lines: Array.from({ length: 10001 }, (_, index) => `line-${index}`),
    });
    emit(FakeLogSocket.instances[0], { type: "logs_ended" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    emit(FakeLogSocket.instances[1], { type: "initial", lines: ["line-10000", "fresh"] });
    const output = screen.getByTestId("log-output").textContent!.split("\n");
    expect(output).toHaveLength(10000);
    expect(output[0]).toBe("[one]line-2");
    expect(output.at(-1)).toBe("[one]fresh");
    expect(output.filter((line) => line === "[one]line-10000")).toHaveLength(1);
    view.unmount();
  });
});
