import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { AdminNodes } from "@/pages/AdminNodes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { makeNode, makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import { DEFAULT_HOSTING_SETTINGS, type HostingConnector } from "@/types/hosting";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

describe("AdminNodes", () => {
  const hostedConnector: HostingConnector = {
    id: "do",
    name: "DO test",
    provider: "digitalocean",
    baseUrl: "https://api.digitalocean.com",
    enabled: true,
    capabilities: { create: true },
    settings: DEFAULT_HOSTING_SETTINGS,
    tokenLast4: "1234",
    hasCustomCa: false,
    certificateFingerprint: null,
    syncStatus: "success",
    syncLastError: null,
    testedAt: null,
    syncedAt: null,
    createdAt: "2026-09-05T00:00:00Z",
  };
  const prepareChoice = (connectors: HostingConnector[] = []) => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(api, "listNodeHostingBindings").mockResolvedValue({});
    const list = vi.spyOn(api, "listHostingConnectors").mockResolvedValue(connectors);
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "nodes:details",
          "nodes:create",
          "hosting:resources:create",
          "integrations:hosting:view",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    return list;
  };
  it("keeps the original nodes-only page when no hosting accounts are connected", async () => {
    const list = prepareChoice();
    renderWithRouter(<AdminNodes />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole("tab", { name: "Providers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Nodes" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /add node/i }).length).toBeGreaterThan(0);
  });
  it("reuses the integration account list in Providers and opens the selected account", async () => {
    prepareChoice([hostedConnector]);
    renderWithRouter(<AdminNodes />, {
      path: "/nodes",
      route: "/nodes",
      extraRoutes: <Route path="/hosting/do" element={<div>Hosting account detail</div>} />,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Providers" }));
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: /add node/i })).not.toBeInTheDocument();
    expect(await screen.findByText("DigitalOcean")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect DO test" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Open DO test" }));
    expect(await screen.findByText("Hosting account detail")).toBeInTheDocument();
  });
  it("retains disabled but still connected providers, then returns to Nodes when the last account is removed", async () => {
    const list = prepareChoice([{ ...hostedConnector, enabled: false }]);
    renderWithRouter(<AdminNodes />);
    await userEvent.click(await screen.findByRole("tab", { name: "Providers" }));
    expect(await screen.findByText("disabled")).toBeInTheDocument();
    list.mockResolvedValue([]);
    await act(async () => {
      const callbacks = vi
        .mocked(useRealtime)
        .mock.calls.filter((call) => call[0] === "integration.connector.changed");
      for (const call of callbacks) call[1]?.({ id: "do", provider: "hosting" });
    });
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Providers" })).not.toBeInTheDocument()
    );
    expect(screen.getAllByRole("button", { name: /add node/i }).length).toBeGreaterThan(0);
  });
  it("does not load or expose provider tabs without hosting visibility", async () => {
    const list = prepareChoice([hostedConnector]);
    useAuthStore.setState({ user: makeUser({ scopes: ["nodes:details"] }) });
    renderWithRouter(<AdminNodes />);
    await screen.findByText(/No nodes found/);
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Providers" })).not.toBeInTheDocument();
  });
  it("always offers both VM choices and sends missing-hosting CTA to the highlighted integration section", async () => {
    prepareChoice();
    const Destination = () => {
      const location = useLocation();
      return (
        <div>
          {location.pathname}:{location.state?.scrollTarget}
        </div>
      );
    };
    renderWithRouter(<AdminNodes />, {
      path: "/nodes",
      route: "/nodes",
      extraRoutes: <Route path="/settings/integrations" element={<Destination />} />,
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: /add node/i }))[0]!);
    expect(screen.getByRole("button", { name: /External VM/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Hosted VM/ })).toBeEnabled();
    expect(screen.queryByRole("combobox", { name: "Node Type" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Hosted VM/ }));
    await screen.findByRole("heading", { name: "Connect a hosting provider" });
    await user.click(screen.getByRole("button", { name: "Open integrations" }));
    expect(
      await screen.findByText("/settings/integrations:hosting-integrations")
    ).toBeInTheDocument();
  });
  it("opens hosted creation only after the choice and keeps the selected mode fixed", async () => {
    prepareChoice([hostedConnector]);
    renderWithRouter(<AdminNodes />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /add node/i })[0]!);
    await user.click(screen.getByRole("button", { name: /Hosted VM/ }));
    await screen.findByRole("combobox", { name: "Node Type" });
    expect(screen.queryByRole("tab", { name: "External" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /External VM/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getAllByRole("button", { name: /add node/i })[0]!);
    expect(screen.getByRole("button", { name: /External VM/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hosted VM/ })).toBeInTheDocument();
  });
  it("does not turn a connector lookup error into a no-hosting message", async () => {
    const list = prepareChoice();
    renderWithRouter(<AdminNodes />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    list.mockRejectedValue(new Error("Hosting access denied"));
    const error = vi.spyOn(toast, "error");
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /add node/i })[0]!);
    await user.click(screen.getByRole("button", { name: /Hosted VM/ }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Hosting access denied"));
    expect(
      screen.queryByRole("heading", { name: "Connect a hosting provider" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hosted VM/ })).toBeEnabled();
  });
  it("does not reopen a dismissed choice when a slow hosting lookup finishes", async () => {
    const list = prepareChoice();
    renderWithRouter(<AdminNodes />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    let resolve!: (value: HostingConnector[]) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /add node/i })[0]!);
    await user.click(screen.getByRole("button", { name: /Hosted VM/ }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => resolve([hostedConnector]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it.each([
    ["pending", "Pending"],
    ["failed", "Provisioning failed"],
  ] as const)("labels a reserved hosted node using its %s operation", async (phase, label) => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [makeNode({ id: "hosted", status: "pending", isConnected: false })],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    });
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(api, "listNodeHostingBindings").mockResolvedValue({
      hosted: {
        resourceId: null,
        connectorId: "do",
        connectorName: "DO test",
        provider: "digitalocean",
        operationAction: "create",
        operationPhase: phase,
      },
    });
    vi.spyOn(api, "listHostingConnectors").mockResolvedValue([]);
    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "nodes:delete"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    renderWithRouter(<AdminNodes />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove node" })).toBeEnabled();
    expect(screen.queryByText("online")).not.toBeInTheDocument();
  });
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
    expect(screen.queryByRole("button", { name: "Create hosted node" })).not.toBeInTheDocument();

    const user = userEvent.setup();
    const addNodeButton = screen.getAllByRole("button", { name: /add node/i })[0];
    if (!addNodeButton) throw new Error("Primary Add Node button not found");
    await user.click(addNodeButton);
    await user.click(screen.getByRole("button", { name: /External VM/ }));
    expect(
      screen.getByText("Terminates TLS and serves public domains and routes.")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Node Type" }));
    expect(screen.getByRole("option", { name: "Relay" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Bastion/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("Adds a physical host to the Secure Link Relay Pool.")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Ingress" }));
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
    await user.click(screen.getByRole("button", { name: /External VM/ }));
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Build Worker" }));

    expect(
      screen.getByText("Builds Git revisions and scans artifacts on an isolated Docker worker.")
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
