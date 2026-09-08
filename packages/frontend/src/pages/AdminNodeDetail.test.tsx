import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { makeNode, makeUser } from "@/test/fixtures";
import type { NodeHealthReport } from "@/types";
import { AdminNodeDetail } from "./AdminNodeDetail";

function CurrentRoute() {
  const location = useLocation();
  return (
    <output aria-label="Current route">
      {location.pathname}
      {location.search}
    </output>
  );
}
const realtimeHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (channel: string | null, handler: (payload: unknown) => void) => {
    if (channel) realtimeHandlers.set(channel, handler);
  },
}));
vi.mock("@/components/nodes/NodeFirewallTab", () => ({
  NodeFirewallTab: () => <div>Firewall content</div>,
}));

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  setPointerCapture: { configurable: true, value: () => undefined },
  releasePointerCapture: { configurable: true, value: () => undefined },
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/api", () => ({
  api: {
    getNode: vi.fn(),
    getNodeHealthHistory: vi.fn(),
    getNodeHosting: vi.fn().mockResolvedValue(null),
    listHostingResources: vi.fn(),
    getHostingCatalog: vi.fn(),
    updateNode: vi.fn(),
  },
}));

vi.mock("./node-detail/NodeDetailsTab", () => ({
  NodeDetailsTab: () => <div>Node details content</div>,
}));
vi.mock("@/components/nodes/NodeSnapshotsTab", () => ({
  NodeSnapshotsTab: () => <div>Snapshot inventory content</div>,
}));

vi.mock("./node-detail/NodeMonitoringTab", () => ({
  NodeMonitoringTab: () => <div>Node monitoring content</div>,
}));

vi.mock("./node-detail/NodeConfigTab", () => ({
  NodeConfigTab: () => <div>Node config content</div>,
}));

vi.mock("./node-detail/BuilderJobsTab", () => ({
  BuilderJobsTab: () => <div>Builder jobs content</div>,
}));

vi.mock("./node-detail/NodeConsoleTab", () => ({
  NodeConsoleTab: () => <div>Node console content</div>,
}));

vi.mock("./node-detail/NodeLogsTab", () => ({
  NodeLogsTab: () => <div>Node logs content</div>,
}));

vi.mock("./node-detail/NodeNginxLogsTab", () => ({
  NodeNginxLogsTab: () => <div>Nginx logs content</div>,
}));

vi.mock("./DockerContainers", () => ({
  DockerContainers: () => <div>Docker containers content</div>,
}));

vi.mock("./DockerImages", () => ({
  DockerImages: () => <div>Docker images content</div>,
}));

vi.mock("./DockerVolumes", () => ({
  DockerVolumes: () => <div>Docker volumes content</div>,
}));

vi.mock("./DockerNetworks", () => ({
  DockerNetworks: () => <div>Docker networks content</div>,
}));

vi.mock("./DockerComposeProjects", () => ({
  DockerComposeProjects: () => <div>Docker compose content</div>,
}));

vi.mock("./Databases", () => ({
  Databases: () => <div>Managed databases content</div>,
}));

describe("AdminNodeDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtimeHandlers.clear();
    vi.mocked(api.getNodeHosting).mockResolvedValue(null);
  });
  it.each([
    "docker",
    "nginx",
    "databases",
    "builder",
  ] as const)("uses decorative icons on every visible %s node tab", async (type) => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "nodes:details",
          "nodes:config:view",
          "nodes:files:read",
          "nodes:console",
          "nodes:logs",
          "hosting:resources:view",
          "hosting:snapshots:view",
          "integrations:hosting:view",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type, status: "online", isConnected: true }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.getNodeHosting).mockResolvedValue({
      kind: "vm",
      provider: "proxmox",
      resourceId: "vm",
      connectorId: "account",
      operation: null,
      actions: {},
    } as never);
    render(
      <MemoryRouter initialEntries={["/nodes/node-1/overview"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole("tab", { name: "Snapshots" });
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("gap-1.5");
      expect(tab.querySelector("svg")).toHaveClass("h-3.5", "w-3.5");
      expect(tab.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });
  it.each([
    "snapshots",
    "firewall",
  ])("retains a direct %s URL while hosting loads and across a failed refresh", async (tab) => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "nodes:details",
          "nodes:config:view",
          "hosting:resources:view",
          "hosting:snapshots:view",
          "integrations:hosting:view",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", status: "online" }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    let resolveHosting!: (value: unknown) => void;
    vi.mocked(api.getNodeHosting).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHosting = resolve;
        }) as never
    );
    render(
      <MemoryRouter initialEntries={[`/nodes/node-1/${tab}`]}>
        <CurrentRoute />
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByLabelText("Current route")).toHaveTextContent(`/nodes/node-1/${tab}`);
    expect(screen.getByText("Loading hosting information…")).toBeInTheDocument();
    await act(async () =>
      resolveHosting({
        kind: "vm",
        resourceId: "vm",
        connectorId: "account",
        provider: "proxmox",
        operation: null,
        actions: {},
      })
    );
    const content = tab === "snapshots" ? "Snapshot inventory content" : "Firewall content";
    expect(await screen.findByText(content)).toBeInTheDocument();
    vi.mocked(api.getNodeHosting).mockRejectedValueOnce(new Error("Temporary failure"));
    await act(async () => realtimeHandlers.get("integration.connector.changed")?.({}));
    expect(screen.getByText(content)).toBeInTheDocument();
    expect(screen.getByLabelText("Current route")).toHaveTextContent(`/nodes/node-1/${tab}`);
    vi.mocked(api.getNodeHosting).mockRejectedValueOnce(
      new ApiRequestError("Forbidden", { status: 403 })
    );
    await act(async () => realtimeHandlers.get("integration.connector.changed")?.({}));
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent("/nodes/node-1/overview")
    );
    expect(screen.queryByText(content)).not.toBeInTheDocument();
  });

  it("uses Overview and preserves the legacy Details URL as an alias", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", status: "online" }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <CurrentRoute />
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole("tab", { name: "Overview" });
    await waitFor(() =>
      expect(screen.getByLabelText("Current route")).toHaveTextContent("/nodes/node-1/overview")
    );
    for (const name of ["Details", "Containers", "Images", "Volumes", "Networks", "Compose"])
      expect(screen.queryByRole("tab", { name })).not.toBeInTheDocument();
  });
  it.each([
    { snapshotScopes: [] },
    { snapshotScopes: ["hosting:snapshots:view:vm"] },
    { snapshotScopes: ["hosting:snapshots:create:vm"] },
    { snapshotScopes: ["hosting:snapshots:view:other"] },
  ])("gates snapshot tab and direct navigation using VM-specific snapshot access: $snapshotScopes", async ({
    snapshotScopes,
  }) => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "hosting:resources:view", ...snapshotScopes] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", status: "online" }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.getNodeHosting).mockResolvedValue({
      resourceId: "vm",
      provider: "proxmox",
      operation: null,
      actions: {},
    } as never);
    render(
      <MemoryRouter initialEntries={["/nodes/node-1/snapshots"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole("heading", { level: 1 });
    const allowed = snapshotScopes.some((s) => s.endsWith(":vm"));
    await waitFor(() => {
      if (allowed) expect(screen.getByRole("tab", { name: "Snapshots" })).toBeInTheDocument();
      else expect(screen.queryByRole("tab", { name: "Snapshots" })).not.toBeInTheDocument();
    });
    if (allowed) {
      expect(await screen.findByText("Snapshot inventory content")).toBeInTheDocument();
    } else expect(screen.queryByText("Snapshot inventory content")).not.toBeInTheDocument();
  });

  it("opens the shared resize dialog in place and puts Pin first in the menu", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "nodes:details",
          "integrations:hosting:view",
          "hosting:resources:view",
          "hosting:resources:resize",
          "hosting:snapshots:view",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", status: "offline" }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.getNodeHosting).mockResolvedValueOnce({
      connectorId: "provider",
      resourceId: "vm",
      provider: "hetzner",
      kind: "vm",
      incarnation: "original",
      actions: { resize: { available: true } },
      operation: null,
    } as never);
    vi.mocked(api.listHostingResources).mockResolvedValue([
      {
        id: "vm",
        name: "test-vm",
        remoteId: "42",
        location: "fsn1",
        incarnation: "original",
        nodes: [],
        sizeId: "cpx12",
      },
    ] as never);
    vi.mocked(api.getHostingCatalog).mockResolvedValue({
      sizes: [
        {
          id: "cpx12",
          name: "cpx12",
          cpu: 2,
          memoryMb: 4096,
          diskGb: 40,
          price: { amount: "5.99", currency: "EUR" },
        },
      ],
    } as never);
    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText("Node details content");
    expect(screen.getByRole("tab", { name: "Snapshots" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Page actions" }));
    expect(screen.getAllByRole("menuitem")[0]).toHaveTextContent("Pin");
    expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("menuitem", { name: "Resize VM" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Resize provider resource");
    expect(screen.getByText("Node details content")).toBeInTheDocument();
  });

  it("keeps the node page mounted when switching URL-backed tabs", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "nodes:config:view", "nodes:logs"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "nginx", hostname: "edge-1" }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Link to="/nodes/node-1/monitoring">Switch externally</Link>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Node details content")).toBeInTheDocument();
    expect(api.getNode).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("link", { name: "Switch externally" }));

    expect(await screen.findByText("Node monitoring content")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edge 1" })).toBeInTheDocument();
    await waitFor(() => expect(api.getNode).toHaveBeenCalledTimes(1));
  });

  it("disables live tabs and returns to details while the node is offline", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:files:read", "nodes:console", "nodes:logs"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({
        id: "node-1",
        type: "nginx",
        hostname: "edge-1",
        status: "offline",
        isConnected: false,
      }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/daemon-logs"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Node details content")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Monitoring" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Files" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Console" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Nginx Logs" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Logs" })).toBeDisabled();
    expect(screen.queryByText("Node logs content")).not.toBeInTheDocument();
  });

  it("redirects an old Docker node tab to the filtered Docker list", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "docker:compose:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({
        id: "node-1",
        type: "docker",
        hostname: "docker-1",
        status: "offline",
        isConnected: false,
      }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/compose"]}>
        <CurrentRoute />
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
          <Route path="/docker/:tab" element={<div>Docker list</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Docker list")).toBeInTheDocument();
    expect(screen.getByLabelText("Current route")).toHaveTextContent(
      "/docker/compose?nodeId=node-1&filters=1"
    );
    expect(screen.queryByText("Node details content")).not.toBeInTheDocument();
  });

  it("blocks live and workload tabs for a pending node, including a direct route", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:files:read", "nodes:console", "nodes:logs"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", status: "pending", isConnected: false }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/nodes/node-1/containers"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText("Node details content")).toBeInTheDocument();
    for (const name of ["Files", "Logs"]) expect(screen.getByRole("tab", { name })).toBeDisabled();
    for (const name of ["Containers", "Images", "Volumes", "Networks", "Compose"])
      expect(screen.queryByRole("tab", { name })).not.toBeInTheDocument();
    const consoleTab = screen.queryByRole("tab", { name: "Console" });
    if (consoleTab) expect(consoleTab).toBeDisabled();
    expect(screen.queryByText("Docker containers content")).not.toBeInTheDocument();
  });

  it.each([
    ["provisioning", "pending"],
    ["installing", "installing"],
    ["enrolling", "enrolling"],
    ["failed", "provisioning failed"],
  ] as const)("uses the hosting %s phase and permits pending removal while other management stays locked", async (phase, label) => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:rename", "nodes:delete", "nodes:lock", "admin:update"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", status: "pending", isConnected: false }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.getNodeHosting).mockResolvedValueOnce({
      resourceId: null,
      connectorId: "do",
      provider: "digitalocean",
      connectorName: "DO",
      remoteId: "",
      location: "",
      origin: "created",
      kind: "vm",
      powerState: "unknown",
      cpu: null,
      memoryMb: null,
      diskGb: null,
      incarnation: null,
      observedAt: "2026-09-05T00:00:00Z",
      identityConflict: false,
      operation: { action: "create", phase },
      actions: {},
    });
    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText("Node details content");
    expect(await screen.findByText(label, { exact: true })).toBeInTheDocument();
    const visibleNames = new Set<string>();
    for (const name of ["Settings", "Remove", "Lock new services", "Check for updates"]) {
      const visible = screen.queryAllByRole("button", { name });
      if (visible.length) visibleNames.add(name);
      for (const button of visible) {
        if (name === "Remove") expect(button).toBeEnabled();
        else expect(button).toBeDisabled();
      }
    }
    const menu = screen.queryByRole("button", { name: "Page actions" });
    if (menu) {
      await userEvent.click(menu);
      for (const name of ["Settings", "Remove", "Lock new services", "Check for updates"]) {
        const item = screen.queryByRole("menuitem", { name });
        if (item) {
          visibleNames.add(name);
          if (name === "Remove") expect(item).not.toHaveAttribute("data-disabled");
          else expect(item).toHaveAttribute("data-disabled");
        }
      }
    }
    expect([...visibleNames].sort()).toEqual([
      "Check for updates",
      "Lock new services",
      "Remove",
      "Settings",
    ]);
  });

  it("keeps standard console and files and adds the managed database list on a databases node", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:files:read", "nodes:console", "nodes:logs"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({
        id: "database-node",
        slug: "database-node",
        type: "databases",
        hostname: "database-1",
      }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/database-node/databases"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Managed databases content")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Files" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: "Console" })).toBeEnabled();
  });

  it("adds the Jobs tab to Build Worker nodes", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({
        id: "builder-node",
        slug: "builder-node",
        type: "builder",
        hostname: "builder-1",
      }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/builder-node/jobs"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Builder jobs content")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Jobs" })).toBeEnabled();
  });

  it("edits Build Worker parallelism and timeout in the standard node settings dialog", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:config:edit:builder-node"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    const builder = {
      ...makeNode({
        id: "builder-node",
        slug: "builder-node",
        type: "builder",
        hostname: "builder-1",
        displayName: "Builder 1",
        metadata: { builderSettings: { parallelism: 2, timeoutMinutes: 40 } },
      }),
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    };
    vi.mocked(api.getNode).mockResolvedValue(builder);
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.updateNode).mockResolvedValue(builder);

    render(
      <MemoryRouter initialEntries={["/nodes/builder-node/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Builder 1" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByLabelText("Display Name")).toBeDisabled();
    const parallelism = screen.getByLabelText("Parallel jobs");
    const timeout = screen.getByLabelText("Build timeout (minutes)");
    expect(parallelism).toHaveValue(2);
    expect(timeout).toHaveValue(40);
    await user.clear(parallelism);
    await user.type(parallelism, "3");
    await user.clear(timeout);
    await user.type(timeout, "60");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updateNode).toHaveBeenCalledWith("builder-node", {
        builderSettings: { parallelism: 3, timeoutMinutes: 60 },
      })
    );
  });

  it("saves node appearance name and predefined color", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:rename:node-1", "docker:containers:config:node-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", hostname: "docker-1", displayName: "Docker 1" }),
      lastHealthReport: {
        localIpAddresses: ["192.168.1.20"],
        publicIpAddresses: ["8.8.8.8"],
      } as unknown as NodeHealthReport,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.updateNode).mockResolvedValue(
      makeNode({
        id: "node-1",
        type: "docker",
        hostname: "docker-1",
        displayName: "Docker Blue",
        appearanceColor: "blue",
      })
    );

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Docker 1" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /settings/i }));
    const displayNameInput = screen.getByLabelText(/display name/i);
    await user.clear(displayNameInput);
    await user.type(displayNameInput, "Docker Blue");
    await user.click(screen.getByRole("button", { name: "Blue color" }));
    await user.click(screen.getByRole("combobox", { name: "Service Address 1" }));
    await user.click(await screen.findByRole("button", { name: "8.8.8.8" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updateNode).toHaveBeenCalledWith("node-1", {
        displayName: "Docker Blue",
        appearanceColor: "blue",
        serviceAddresses: ["8.8.8.8"],
      })
    );
  });

  it("shows the public address as the automatic fallback when no local address exists", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:rename:node-1", "docker:containers:config:node-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "docker", hostname: "docker-1" }),
      lastHealthReport: {
        localIpAddresses: [],
        publicIpAddresses: ["8.8.8.8"],
      } as unknown as NodeHealthReport,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Edge 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    expect(screen.getByRole("combobox", { name: "Service Address 1" })).toHaveAttribute(
      "placeholder",
      "Automatic (8.8.8.8)"
    );
  });

  it("offers detected addresses and accepts a custom public IP for Nginx", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:rename:node-1", "nodes:config:edit:node-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "nginx", hostname: "edge-1" }),
      publicServiceAddresses: ["1.1.1.1", "2606:4700:4700::1111"],
      lastHealthReport: {
        localIpAddresses: ["192.168.1.20"],
        publicIpAddresses: ["1.1.1.1", "2606:4700:4700::1111"],
      } as unknown as NodeHealthReport,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);
    vi.mocked(api.updateNode).mockResolvedValue(
      makeNode({
        id: "node-1",
        type: "nginx",
        hostname: "edge-1",
        serviceAddress: "9.9.9.9",
      })
    );

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Edge 1" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /settings/i }));
    const serviceAddress = screen.getByRole("combobox", { name: "Service Address 1" });
    await user.click(serviceAddress);

    expect(await screen.findByRole("button", { name: "1.1.1.1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2606:4700:4700::1111" })).toBeInTheDocument();
    expect(screen.getByText("Detected public addresses")).toBeInTheDocument();
    expect(screen.queryByText("192.168.1.20")).not.toBeInTheDocument();
    await user.type(serviceAddress, "9.9.9.9");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updateNode).toHaveBeenCalledWith("node-1", {
        displayName: "Edge 1",
        appearanceColor: null,
        serviceAddresses: ["9.9.9.9"],
      })
    );
  });

  it("adds and removes service address rows and blocks duplicate addresses", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:rename:node-1", "nodes:config:edit:node-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({ id: "node-1", type: "nginx", hostname: "edge-1" }),
      publicServiceAddresses: ["1.1.1.1", "8.8.8.8"],
      lastHealthReport: {
        localIpAddresses: [],
        publicIpAddresses: ["1.1.1.1", "8.8.8.8"],
      } as unknown as NodeHealthReport,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Edge 1" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /settings/i }));
    const firstAddress = screen.getByRole("combobox", { name: "Service Address 1" });
    await user.click(firstAddress);
    await user.click(await screen.findByRole("button", { name: "1.1.1.1" }));
    await user.click(screen.getByRole("button", { name: "Add service address" }));
    const secondAddress = screen.getByRole("combobox", { name: "Service Address 2" });
    await user.click(secondAddress);
    await user.click(await screen.findByRole("button", { name: "1.1.1.1" }));
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

    await user.clear(secondAddress);
    await user.type(secondAddress, "https://invalid.example");
    expect(
      screen.getByText("Enter a valid IPv4, IPv6, or hostname for every address.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

    await user.clear(secondAddress);
    await user.type(secondAddress, "8.8.8.8");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Remove service address 1" }));
    await waitFor(() =>
      expect(screen.getAllByRole("combobox", { name: "Service Address 1" })).toHaveLength(1)
    );
    expect(screen.getByRole("combobox", { name: "Service Address 1" })).toHaveValue("8.8.8.8");
    expect(screen.queryByRole("combobox", { name: "Service Address 2" })).not.toBeInTheDocument();
  });

  it("preserves migrated addresses and caps the list at ten rows", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["nodes:details", "nodes:rename:node-1", "nodes:config:edit:node-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(api.getNode).mockResolvedValue({
      ...makeNode({
        id: "node-1",
        type: "nginx",
        hostname: "edge-1",
        serviceAddresses: ["1.1.1.1", "8.8.8.8"],
      }),
      publicServiceAddresses: ["1.1.1.1", "8.8.8.8"],
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    vi.mocked(api.getNodeHealthHistory).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Edge 1" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("combobox", { name: "Service Address 1" })).toHaveValue("1.1.1.1");
    expect(screen.getByRole("combobox", { name: "Service Address 2" })).toHaveValue("8.8.8.8");
    expect(screen.queryByText("Secondary Address")).not.toBeInTheDocument();

    for (let index = 0; index < 8; index += 1) {
      await user.click(screen.getByRole("button", { name: "Add service address" }));
    }
    expect(screen.getAllByRole("combobox", { name: /Service Address \d+/ })).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "Add service address" })).not.toBeInTheDocument();
  });
});
