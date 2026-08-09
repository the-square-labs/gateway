import { api } from "@/services/api";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import type { DashboardBootstrap } from "@/types";

const SNAPSHOT = {
  fetchedAt: "2026-08-05T00:00:00.000Z",
  attention: { severity: "warning", notices: [{ id: "mfa", severity: "warning" }] },
} as DashboardBootstrap;

describe("dashboard bootstrap store", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDashboardBootstrap").mockReset();
    useDashboardBootstrapStore.getState().clear();
  });

  it("shares one request for Dashboard and Sidebar when their scope and pins match", async () => {
    vi.mocked(api.getDashboardBootstrap).mockResolvedValueOnce(SNAPSHOT);

    const request = { pins: { dashboard: { nodeIds: [] }, sidebar: { nodeIds: [] } } };
    const [fromSidebar, fromDashboard] = await Promise.all([
      useDashboardBootstrapStore.getState().load("user:scope:pins", request),
      useDashboardBootstrapStore.getState().load("user:scope:pins", request),
    ]);

    expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(1);
    expect(fromSidebar?.attention.severity).toBe("warning");
    expect(fromDashboard).toBe(SNAPSHOT);
  });

  it("does not refetch when a component reruns its effect with the same snapshot key", async () => {
    vi.mocked(api.getDashboardBootstrap).mockResolvedValue(SNAPSHOT);

    await useDashboardBootstrapStore.getState().load("user:scope:pins", {
      pins: { dashboard: { nodeIds: [] }, sidebar: { nodeIds: [] } },
    });
    await useDashboardBootstrapStore.getState().load("user:scope:pins", {
      pins: { dashboard: { nodeIds: [] }, sidebar: { nodeIds: [] } },
    });

    expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(1);
  });

  it("reloads after a realtime invalidation without clearing the visible snapshot", async () => {
    vi.mocked(api.getDashboardBootstrap).mockResolvedValue(SNAPSHOT);
    await useDashboardBootstrapStore.getState().load("user:scope:pins", {});

    useDashboardBootstrapStore.getState().invalidate();
    expect(useDashboardBootstrapStore.getState().snapshot).toBe(SNAPSHOT);
    await vi.waitFor(() => expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(2));

    expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of realtime invalidations into one refresh", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.getDashboardBootstrap).mockResolvedValue(SNAPSHOT);
      await useDashboardBootstrapStore.getState().load("user:scope:pins", {});

      useDashboardBootstrapStore.getState().invalidate();
      useDashboardBootstrapStore.getState().invalidate();
      useDashboardBootstrapStore.getState().invalidate();
      await vi.advanceTimersByTimeAsync(250);

      expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a critical relay attention state after the realtime refresh becomes healthy", async () => {
    const critical = {
      ...SNAPSHOT,
      relay: {
        state: "critical",
        impact: "Managed nodes and secure database connections are disconnected.",
        attempt: 3,
        maxAttempts: 3,
        lastHealthyAt: null,
      },
      attention: { severity: "critical", notices: [{ id: "gateway-relay", severity: "critical" }] },
    } as DashboardBootstrap;
    const healthy = {
      ...SNAPSHOT,
      relay: {
        state: "healthy",
        impact: null,
        attempt: 0,
        maxAttempts: 3,
        lastHealthyAt: "2026-08-05T00:01:00.000Z",
      },
      attention: { severity: null, notices: [] },
    } as DashboardBootstrap;
    vi.mocked(api.getDashboardBootstrap)
      .mockResolvedValueOnce(critical)
      .mockResolvedValueOnce(healthy);

    await useDashboardBootstrapStore.getState().load("user:scope:pins", {});
    useDashboardBootstrapStore.getState().invalidate();

    await vi.waitFor(() =>
      expect(useDashboardBootstrapStore.getState().snapshot?.relay?.state).toBe("healthy")
    );
    expect(useDashboardBootstrapStore.getState().snapshot?.attention.severity).toBeNull();
  });

  it("refetches after an invalidation that arrives while the previous request is in flight", async () => {
    let resolveRefresh: (snapshot: DashboardBootstrap) => void;
    const refreshRequest = new Promise<DashboardBootstrap>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshedSnapshot = {
      ...SNAPSHOT,
      fetchedAt: "2026-08-05T00:01:00.000Z",
    };
    vi.mocked(api.getDashboardBootstrap)
      .mockResolvedValueOnce(SNAPSHOT)
      .mockReturnValueOnce(refreshRequest)
      .mockResolvedValueOnce(refreshedSnapshot);

    const request = { pins: { dashboard: { nodeIds: [] }, sidebar: { nodeIds: [] } } };
    await useDashboardBootstrapStore.getState().load("user:scope:pins", request);
    useDashboardBootstrapStore.getState().invalidate();
    await vi.waitFor(() => expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(2));
    useDashboardBootstrapStore.getState().invalidate();
    useDashboardBootstrapStore.getState().invalidate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    resolveRefresh!(SNAPSHOT);
    await vi.waitFor(() => expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(3));

    await vi.waitFor(() =>
      expect(useDashboardBootstrapStore.getState().snapshot?.fetchedAt).toBe(
        refreshedSnapshot.fetchedAt
      )
    );
  });

  it("can recover an initial bootstrap failure through a later invalidation", async () => {
    vi.mocked(api.getDashboardBootstrap).mockRejectedValueOnce(
      new Error("temporarily unavailable")
    );
    vi.mocked(api.getDashboardBootstrap).mockResolvedValueOnce(SNAPSHOT);

    await useDashboardBootstrapStore.getState().load("user:scope:pins", {});
    useDashboardBootstrapStore.getState().invalidate();

    await vi.waitFor(() => expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(2));
    expect(useDashboardBootstrapStore.getState().snapshot).toBe(SNAPSHOT);
  });

  it("exposes a retryable error when the initial bootstrap retry budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.getDashboardBootstrap).mockRejectedValue(new Error("temporarily unavailable"));

      await useDashboardBootstrapStore.getState().load("user:scope:pins", {});
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      expect(api.getDashboardBootstrap).toHaveBeenCalledTimes(4);
      expect(useDashboardBootstrapStore.getState().error).toBe(true);
      expect(useDashboardBootstrapStore.getState().loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
