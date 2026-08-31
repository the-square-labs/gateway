import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTransition } from "@/components/common/PageTransition";
import { api } from "@/services/api";
import { isMonitoringSampleForRuntime, StatsTab } from "./StatsTab";

vi.mock("@/components/ui/stat-card", () => ({
  StatCard: ({ label, value }: { label: string; value: string }) => (
    <div>{`${label}: ${value}`}</div>
  ),
}));
vi.mock("@/components/docker/GpuMonitoringSection", () => ({
  GpuMonitoringSection: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeMonitoringStream {
  addEventListener = vi.fn();
  close = vi.fn();
}

function runningInspect(id: string, startedAt: string) {
  return {
    Id: id,
    State: { Running: true, Status: "running", StartedAt: startedAt },
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StatsTab runtime identity", () => {
  it("reveals a stable first frame after HTTP bootstrap without waiting for SSE", async () => {
    const history = deferred<Record<string, unknown>[]>();
    const processes = deferred<any>();
    vi.spyOn(api, "createNodeMonitoringStream").mockImplementation(
      () => new FakeMonitoringStream() as unknown as EventSource
    );
    vi.spyOn(api, "getContainerStatsHistory").mockReturnValue(history.promise);
    vi.spyOn(api, "getContainerTop").mockReturnValue(processes.promise);

    render(
      <PageTransition>
        <StatsTab
          nodeId="node-1"
          containerId="container-1"
          data={runningInspect("container-1", "2026-08-24T12:00:00.000Z")}
        />
      </PageTransition>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(api.createNodeMonitoringStream).toHaveBeenCalledWith("node-1");

    await act(async () => {
      history.resolve([
        {
          timestamp: Date.parse("2026-08-24T12:00:01.000Z"),
          cpuPercent: 20,
          memoryUsageBytes: 1024,
          memoryLimitBytes: 4096,
          pids: 2,
        },
      ]);
    });
    expect(screen.getByText("CPU: 20.0%")).toBeInTheDocument();
    expect(transition).toHaveStyle({ visibility: "hidden" });

    await act(async () => {
      processes.resolve({ Titles: ["PID", "CMD"], Processes: [["2", "ready-process"]] });
    });

    await waitFor(() => {
      expect(screen.getByText("ready-process")).toBeVisible();
      expect(transition).toHaveStyle({ visibility: "visible" });
    });
  });

  it("filters saved monitoring history to the current runtime start", () => {
    const startedAt = Date.parse("2026-08-24T12:00:00.000Z");

    expect(isMonitoringSampleForRuntime({ timestamp: startedAt - 1 }, startedAt)).toBe(false);
    expect(isMonitoringSampleForRuntime({ timestamp: startedAt + 1 }, startedAt)).toBe(true);
    expect(isMonitoringSampleForRuntime({}, startedAt)).toBe(false);
  });

  it("ignores late stats and process responses from the replaced runtime", async () => {
    const oldHistory = deferred<Record<string, unknown>[]>();
    const newHistory = deferred<Record<string, unknown>[]>();
    const oldProcesses = deferred<any>();
    const newProcesses = deferred<any>();
    vi.spyOn(api, "createNodeMonitoringStream").mockImplementation(
      () => new FakeMonitoringStream() as unknown as EventSource
    );
    vi.spyOn(api, "getContainerStatsHistory").mockImplementation((_nodeId, containerId) =>
      containerId === "container-old" ? oldHistory.promise : newHistory.promise
    );
    vi.spyOn(api, "getContainerTop").mockImplementation((_nodeId, containerId) =>
      containerId === "container-old" ? oldProcesses.promise : newProcesses.promise
    );

    const { rerender } = render(
      <StatsTab
        nodeId="node-1"
        containerId="container-old"
        data={runningInspect("container-old", "2026-08-24T10:00:00.000Z")}
      />
    );
    await waitFor(() =>
      expect(api.getContainerStatsHistory).toHaveBeenCalledWith("node-1", "container-old")
    );

    rerender(
      <StatsTab
        nodeId="node-1"
        containerId="container-new"
        data={runningInspect("container-new", "2026-08-24T11:00:00.000Z")}
      />
    );
    await waitFor(() =>
      expect(api.getContainerStatsHistory).toHaveBeenCalledWith("node-1", "container-new")
    );

    await act(async () => {
      newHistory.resolve([
        {
          timestamp: Date.parse("2026-08-24T11:00:01.000Z"),
          cpuPercent: 20,
          pids: 2,
        },
      ]);
      newProcesses.resolve({ Titles: ["PID", "CMD"], Processes: [["2", "new-process"]] });
    });
    expect(await screen.findByText("CPU: 20.0%")).toBeInTheDocument();
    expect(await screen.findByText("new-process")).toBeInTheDocument();

    await act(async () => {
      oldHistory.resolve([
        {
          timestamp: Date.parse("2026-08-24T10:00:01.000Z"),
          cpuPercent: 90,
          pids: 99,
        },
      ]);
      oldProcesses.resolve({ Titles: ["PID", "CMD"], Processes: [["99", "old-process"]] });
    });

    expect(screen.queryByText("CPU: 90.0%")).not.toBeInTheDocument();
    expect(screen.queryByText("old-process")).not.toBeInTheDocument();
    expect(screen.getByText("CPU: 20.0%")).toBeInTheDocument();
    expect(screen.getByText("new-process")).toBeInTheDocument();
  });

  it("keeps the process panel visible while top is temporarily unavailable", async () => {
    vi.spyOn(api, "createNodeMonitoringStream").mockImplementation(
      () => new FakeMonitoringStream() as unknown as EventSource
    );
    vi.spyOn(api, "getContainerStatsHistory").mockResolvedValue([]);
    vi.spyOn(api, "getContainerTop").mockRejectedValue(new Error("restarting"));

    render(
      <StatsTab
        nodeId="node-1"
        containerId="container-1"
        data={runningInspect("container-1", "2026-08-24T12:00:00.000Z")}
      />
    );

    expect(screen.getByText("Process List")).toBeInTheDocument();
    expect(
      await screen.findByText("Process list is temporarily unavailable. Retrying automatically.")
    ).toBeInTheDocument();
  });
});
