import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SidebarPinnedResources } from "@/components/layout/SidebarPinnedResources";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedStorageStore } from "@/stores/pinned-storage";
import { makeUser } from "@/test/fixtures";
import type { DashboardBootstrap } from "@/types";
import {
  buildDashboardBootstrapRequest,
  type DashboardBootstrapInputs,
  useLoadDashboardBootstrap,
} from "./use-dashboard-bootstrap";

const EMPTY_PINS = { nodes: [], proxies: [], databases: [], dockerResources: [], storages: [] };

function snapshot(): DashboardBootstrap {
  return {
    fetchedAt: "2026-09-26T00:00:00.000Z",
    attention: { severity: null, notices: [] },
    navigationAttention: { nodes: null, "proxy-hosts": null, docker: null },
    pinned: {
      dashboard: EMPTY_PINS,
      sidebar: {
        ...EMPTY_PINS,
        // The server's view of the pinned container differs from the stored
        // metadata, so the sidebar writes new metadata after every response.
        dockerResources: [
          {
            id: "container-1",
            nodeId: "node-1",
            nodeSlug: "edge-1",
            name: "web",
            state: "running",
            kind: "container",
            scopeBase: "docker:containers:view",
          },
        ],
      },
    },
  } as unknown as DashboardBootstrap;
}

/** Stands in for the Dashboard page, which loads the same snapshot. */
function DashboardProbe() {
  useLoadDashboardBootstrap();
  return null;
}

function inputs(storageIds: string[]): DashboardBootstrapInputs {
  return {
    userId: "user-1",
    scopes: ["b", "a"],
    showSystemCertificates: false,
    showUpdateNotifications: true,
    dashboard: { nodeIds: [], proxyHostIds: [], databaseIds: [], dockerIds: [] },
    sidebar: {
      nodeIds: [],
      proxyHostIds: [],
      databaseIds: [],
      storageIds,
      dockerIds: ["container-1"],
    },
    dockerMeta: { "container-1": { nodeId: "node-1", kind: "container" } },
  };
}

describe("dashboard bootstrap request", () => {
  beforeEach(() => {
    api.invalidateCache("dashboard:bootstrap:");
    useDashboardBootstrapStore.getState().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keys the snapshot by every sidebar pin, storage included", () => {
    const withStorage = buildDashboardBootstrapRequest(inputs(["storage-1"]));
    const withoutStorage = buildDashboardBootstrapRequest(inputs([]));

    expect(withStorage.key).not.toBe(withoutStorage.key);
    expect(withStorage.request.pins?.sidebar?.storageIds).toEqual(["storage-1"]);
    expect(withStorage.request.pins?.sidebar?.dockerResources).toEqual([
      { id: "container-1", nodeId: "node-1", kind: "container", scopeResourceId: undefined },
    ]);
  });

  it("loads once for the dashboard and the sidebar while a Docker resource is pinned", async () => {
    const getDashboardBootstrap = vi
      .spyOn(api, "getDashboardBootstrap")
      .mockImplementation(async () => snapshot());
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:view", "storage:view"] }),
    });
    usePinnedStorageStore.setState({ sidebarStorageIds: ["storage-1"] });
    usePinnedContainersStore.setState({
      dashboardContainerIds: [],
      sidebarContainerIds: ["container-1"],
      containerMeta: {
        "container-1": { nodeId: "node-1", nodeSlug: "edge-1", name: "web", kind: "container" },
      },
    });

    render(
      <MemoryRouter>
        <SidebarPinnedResources loadBootstrap />
        <DashboardProbe />
      </MemoryRouter>
    );

    await waitFor(() => expect(useDashboardBootstrapStore.getState().snapshot).not.toBeNull());
    // Let the metadata update and any follow-up loads run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(usePinnedContainersStore.getState().containerMeta["container-1"]?.state).toBe("running");
    expect(getDashboardBootstrap).toHaveBeenCalledTimes(1);
    expect(getDashboardBootstrap.mock.calls[0]?.[0].pins?.sidebar?.storageIds).toEqual([
      "storage-1",
    ]);
  });
});
