import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { makeNode, makeUser } from "@/test/fixtures";
import type { DashboardBootstrap, NodeStatus } from "@/types";
import { SidebarPinnedResources } from "./SidebarPinnedResources";

const EMPTY_PINS = { nodes: [], proxies: [], databases: [], dockerResources: [], storages: [] };

function renderWithNodes(statuses: NodeStatus[]) {
  const nodes = statuses.map((status) =>
    makeNode({ id: `node-${status}`, slug: status, displayName: `Node ${status}`, status })
  );
  useDashboardBootstrapStore.setState({
    snapshot: {
      pinned: { dashboard: EMPTY_PINS, sidebar: { ...EMPTY_PINS, nodes } },
    } as unknown as DashboardBootstrap,
  });
  render(
    <MemoryRouter>
      <SidebarPinnedResources />
    </MemoryRouter>
  );
}

function dotOf(name: string) {
  return screen.getByRole("link", { name }).querySelector("span:last-child");
}

describe("SidebarPinnedResources node dots", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: makeUser({ scopes: ["nodes:details"] }) });
  });

  it("shows solid warning for every node state that is not settled", () => {
    renderWithNodes(["pending", "online", "degraded", "offline", "error"] as NodeStatus[]);

    expect(dotOf("Node pending")).toHaveClass("bg-warning");
    expect(dotOf("Node degraded")).toHaveClass("bg-warning");
    expect(dotOf("Node online")).toHaveClass("bg-success");
    expect(dotOf("Node offline")).toHaveClass("bg-destructive");
    expect(dotOf("Node error")).toHaveClass("bg-destructive");
    expect(dotOf("Node pending")).not.toHaveClass("bg-warning/15");
  });
});
