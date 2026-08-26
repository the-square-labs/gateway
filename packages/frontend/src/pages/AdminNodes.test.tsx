import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { AdminNodes } from "@/pages/AdminNodes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { makeNode, makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

describe("AdminNodes", () => {
  it("shows offline status instead of an available daemon update", async () => {
    useDaemonUpdatesStore.getState().setDaemonUpdates([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [
        makeNode({
          id: "node-offline",
          status: "offline",
          isConnected: false,
          daemonVersion: "2.4.0",
        }),
      ],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    });
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(api, "getDaemonUpdates").mockResolvedValue([
      {
        daemonType: "nginx",
        latestVersion: "v2.5.0",
        lastCheckedAt: new Date().toISOString(),
        nodes: [
          {
            nodeId: "node-offline",
            hostname: "edge-1",
            currentVersion: "2.4.0",
            updateAvailable: true,
          },
        ],
      },
    ]);
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "admin:update"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<AdminNodes />);

    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.getByText("Ingress")).toBeInTheDocument();
    expect(screen.queryByText("v2.5.0")).not.toBeInTheDocument();
  });

  it("creates a node and shows the enrollment token and setup command", async () => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(api, "getDaemonUpdates").mockResolvedValue([]);
    const createNodeSpy = vi.spyOn(api, "createNode").mockResolvedValue({
      node: makeNode({ id: "node-2", status: "pending", type: "nginx" }),
      enrollmentToken: "token-123",
      gatewayCertSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "nodes:create"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<AdminNodes />);

    await waitFor(() => {
      expect(api.listNodes).toHaveBeenCalled();
    });

    const user = userEvent.setup();
    const addNodeButton = screen.getAllByRole("button", { name: /add node/i })[0];
    if (!addNodeButton) throw new Error("Primary Add Node button not found");
    await user.click(addNodeButton);
    expect(
      screen.getByText("Serve public domains and routes with the Nginx daemon")
    ).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("US-East Ingress"), "Branch Edge");
    await user.click(screen.getByRole("button", { name: /create node/i }));

    expect(createNodeSpy).toHaveBeenCalledWith({
      type: "nginx",
      hostname: "pending",
      displayName: "Branch Edge",
    });

    expect(await screen.findByText("Node Created")).toBeInTheDocument();
    expect(screen.getByText(/single-use/i)).toBeInTheDocument();
    expect(screen.getByText("token-123")).toBeInTheDocument();
    expect(screen.getByText(/setup-node\.sh/)).not.toHaveTextContent("--type");
    expect(screen.getByText(/setup-node\.sh/)).toHaveTextContent("--token token-123");
    expect(screen.getByText(/setup-node\.sh/)).toHaveTextContent(
      "--gateway-cert-sha256 sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("creates a Build Worker with the isolated builder installer profile", async () => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(api, "getDaemonUpdates").mockResolvedValue([]);
    const createNodeSpy = vi.spyOn(api, "createNode").mockResolvedValue({
      node: makeNode({ id: "builder-1", status: "pending", type: "builder" }),
      enrollmentToken: "builder-token",
      gatewayCertSha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "nodes:create"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<AdminNodes />);
    await waitFor(() => expect(api.listNodes).toHaveBeenCalled());

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /add node/i })[0]!);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Build Worker" }));

    expect(
      screen.getByText("Dedicated isolated worker for Git builds and artifact scanning")
    ).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("US-East Ingress"), "Build Worker EU");
    await user.click(screen.getByRole("button", { name: /create node/i }));

    expect(createNodeSpy).toHaveBeenCalledWith({
      type: "builder",
      hostname: "pending",
      displayName: "Build Worker EU",
    });

    expect(await screen.findByText("Node Created")).toBeInTheDocument();
    const command = screen.getByText(/setup-docker-node\.sh/);
    expect(command).toHaveTextContent("--mode builder");
    expect(command).toHaveTextContent("--token builder-token");
  });
});
