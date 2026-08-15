import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeNode, makeUser } from "@/test/fixtures";
import type { NodeHealthReport } from "@/types";
import { AdminNodeDetail } from "./AdminNodeDetail";

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
    updateNode: vi.fn(),
  },
}));

vi.mock("./node-detail/NodeDetailsTab", () => ({
  NodeDetailsTab: () => <div>Node details content</div>,
}));

vi.mock("./node-detail/NodeMonitoringTab", () => ({
  NodeMonitoringTab: () => <div>Node monitoring content</div>,
}));

vi.mock("./node-detail/NodeConfigTab", () => ({
  NodeConfigTab: () => <div>Node config content</div>,
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

vi.mock("./Databases", () => ({
  Databases: () => <div>Managed databases content</div>,
}));

describe("AdminNodeDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("8.8.8.8"));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updateNode).toHaveBeenCalledWith("node-1", {
        displayName: "Docker Blue",
        appearanceColor: "blue",
        serviceAddress: "8.8.8.8",
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

    expect(screen.getByRole("combobox")).toHaveTextContent("Automatic (8.8.8.8)");
  });

  it("offers only detected public addresses for an Nginx service address", async () => {
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

    render(
      <MemoryRouter initialEntries={["/nodes/node-1/details"]}>
        <Routes>
          <Route path="/nodes/:id/:tab?" element={<AdminNodeDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Edge 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByText("1.1.1.1")).toBeInTheDocument();
    expect(screen.getByText("2606:4700:4700::1111")).toBeInTheDocument();
    expect(screen.queryByText("192.168.1.20")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom address")).not.toBeInTheDocument();
  });
});
