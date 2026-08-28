import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { LogsTab } from "./LogsTab";

class FakeProxyLogSocket {
  static instances: FakeProxyLogSocket[] = [];

  readyState: number = WebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();

  constructor() {
    FakeProxyLogSocket.instances.push(this);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }
}

vi.mock("@/components/ui/virtual-log-list", () => ({
  VirtualLogList: ({
    lines,
    renderLine,
    emptyState,
    onLoadMore,
  }: {
    lines: unknown[];
    renderLine: (line: unknown, index: number) => ReactNode;
    emptyState: ReactNode;
    onLoadMore?: () => void;
  }) => (
    <div data-testid="virtual-log-list">
      <button type="button" onClick={onLoadMore}>
        Load older test logs
      </button>
      {lines.length === 0 ? emptyState : lines.map(renderLine)}
    </div>
  ),
}));

const entry = {
  hostId: "host-1",
  timestamp: "28/Aug/2026:09:41:44 +0000",
  remoteAddr: "104.23.162.134",
  method: "GET",
  path: "/health",
  status: 200,
  bodyBytesSent: "21720",
  raw: '104.23.162.134 - - [28/Aug/2026:09:41:44 +0000] "GET /health HTTP/1.1" 200 21720',
  logType: "access",
  level: "",
};

describe("proxy LogsTab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeProxyLogSocket.instances = [];
    vi.spyOn(api, "createProxyLogStreamWebSocket").mockImplementation(
      () => new FakeProxyLogSocket() as unknown as WebSocket
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the virtual log viewport, pages upward, and shows full raw details", async () => {
    render(<LogsTab hostId="host-1" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const socket = FakeProxyLogSocket.instances[0];
    act(() => {
      socket.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "initial", entries: [entry], hasMore: true }),
        })
      );
    });

    expect(screen.getByTestId("virtual-log-list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older test logs" }));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "load_more" }));

    fireEvent.click(screen.getByText("/health"));
    expect(screen.getByText("Raw").nextElementSibling).toHaveTextContent(entry.raw);
  });

  it("reuses the bounded view cache immediately when the tab remounts", async () => {
    const first = render(<LogsTab hostId="host-cache-test" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    act(() => {
      FakeProxyLogSocket.instances[0].onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "initial", entries: [entry], hasMore: false }),
        })
      );
    });
    first.unmount();

    render(<LogsTab hostId="host-cache-test" />);
    expect(screen.getByText("/health")).toBeInTheDocument();
  });
});
