import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InitialPageLoadContext } from "@/components/common/PageTransition";
import { api } from "@/services/api";
import { MultiContainerMonitoring } from "./MultiContainerMonitoring";

const statsReady = vi.hoisted(() => new Map<string, () => void>());

vi.mock("./StatsTab", () => ({
  StatsTab: ({
    containerId,
    data,
    onInitialLoadComplete,
  }: {
    containerId: string;
    data: { HostConfig?: { Memory?: number } };
    onInitialLoadComplete: () => void;
  }) => {
    statsReady.set(containerId, onInitialLoadComplete);
    return (
      <div data-testid="stats-runtime" data-memory={data.HostConfig?.Memory}>
        {containerId}
      </div>
    );
  },
}));

describe("MultiContainerMonitoring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    statsReady.clear();
    vi.spyOn(api, "inspectContainer").mockImplementation(async (_nodeId, containerId) => ({
      Id: `resolved-${containerId}`,
      State: { Running: true, Status: "running" },
    }));
    vi.spyOn(api, "getContainerTop").mockResolvedValue({
      Titles: ["PID", "TTY", "COMMAND"],
      Processes: [["1", "?", "nginx"]],
    });
  });

  it("holds the initial page transition until every instance has loaded metrics", async () => {
    let pendingLoads = 0;
    const register = () => {
      pendingLoads += 1;
      return () => {
        pendingLoads -= 1;
      };
    };
    render(
      <InitialPageLoadContext.Provider value={register}>
        <MultiContainerMonitoring
          instances={[
            { id: "a", title: "web", nodeId: "a", containerId: "web-a" },
            { id: "b", title: "web", nodeId: "b", containerId: "web-b" },
          ]}
        />
      </InitialPageLoadContext.Provider>
    );
    expect(pendingLoads).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByTestId("stats-runtime")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText("nginx")).toHaveLength(2));
    expect(pendingLoads).toBeGreaterThan(0);
    act(() => statsReady.get("web-a")!());
    expect(pendingLoads).toBeGreaterThan(0);
    act(() => statsReady.get("web-b")!());
    expect(pendingLoads).toBe(0);
  });

  it("shows every instance and groups its process list without refetching on an equivalent rerender", async () => {
    const instances = [
      {
        id: "placement-1",
        title: "api",
        groupTitle: "Node A",
        nodeId: "node-a",
        containerId: "api-a",
      },
      {
        id: "placement-2",
        title: "api",
        groupTitle: "Node B",
        nodeId: "node-b",
        containerId: "api-b",
      },
    ];
    const { rerender } = render(<MultiContainerMonitoring instances={instances} />);

    expect(screen.getByText("Node A")).toBeInTheDocument();
    expect(screen.getByText("Node B")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("nginx")).toHaveLength(2));
    expect(screen.getAllByTestId("stats-runtime").map((item) => item.textContent)).toEqual([
      "api-a",
      "api-b",
    ]);
    expect(screen.queryByText("TTY")).not.toBeInTheDocument();

    rerender(
      <MultiContainerMonitoring instances={instances.map((instance) => ({ ...instance }))} />
    );
    await Promise.resolve();

    expect(api.inspectContainer).toHaveBeenCalledTimes(2);
    expect(api.getContainerTop).toHaveBeenCalledTimes(2);
  });

  it("passes refreshed inspect limits through for an unchanged container identity", async () => {
    const instance = {
      id: "runtime",
      title: "app",
      nodeId: "node",
      containerId: "container",
      data: { State: { Running: true }, HostConfig: { Memory: 256 } },
    };
    const { rerender } = render(<MultiContainerMonitoring instances={[instance]} />);
    await waitFor(() =>
      expect(screen.getByTestId("stats-runtime")).toHaveAttribute("data-memory", "256")
    );
    await screen.findByText("nginx");
    rerender(
      <MultiContainerMonitoring
        instances={[{ ...instance, data: { ...instance.data, HostConfig: { Memory: 512 } } }]}
      />
    );
    expect(screen.getByTestId("stats-runtime")).toHaveAttribute("data-memory", "512");
    expect(api.inspectContainer).not.toHaveBeenCalled();
  });
});
