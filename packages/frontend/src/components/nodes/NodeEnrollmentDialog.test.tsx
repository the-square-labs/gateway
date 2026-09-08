import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeNode, makeUser } from "@/test/fixtures";
import {
  DEFAULT_HOSTING_SETTINGS,
  type HostingConnector,
  type HostingOperation,
} from "@/types/hosting";
import { NodeEnrollmentDialog } from "./NodeEnrollmentDialog";

let realtimeHandler: ((payload: unknown) => void) | undefined;

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn((_channel: string | null, handler: (payload: unknown) => void) => {
    realtimeHandler = handler;
  }),
}));

describe("NodeEnrollmentDialog", () => {
  const hostingDefaults: HostingConnector = {
    id: "connector-1",
    name: "DO",
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
  it("owns the shared External and Hosting creation shell", async () => {
    const connector = {
      ...hostingDefaults,
      id: "connector-1",
      name: "Hosting account",
      enabled: true,
      capabilities: { create: true },
      provider: "digitalocean",
    } as HostingConnector;
    vi.spyOn(api, "listHostingConnectors").mockResolvedValue([connector]);
    vi.spyOn(api, "getHostingCatalog").mockResolvedValue({
      locations: [{ id: "ams3", name: "Amsterdam" }],
      sizes: [{ id: "small", name: "Small" }],
      images: [{ id: "debian", name: "Debian", supportedRoles: ["docker"] }],
    });

    render(
      <MemoryRouter>
        <NodeEnrollmentDialog open initialMode="hosting" onOpenChange={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "External" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Hosting" })).toHaveAttribute("data-state", "active");
    const nodeType = await screen.findByRole("combobox", { name: "Node Type" });
    expect(nodeType.parentElement).toHaveClass("space-y-1.5");
    expect(screen.getByLabelText("Node name").parentElement).toHaveClass("space-y-1.5");
  });

  it("ignores old operations in browser storage and opens creation in a fixed provider context", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["hosting:resources:create"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    const lookup = vi.spyOn(api, "getHostingOperation").mockResolvedValue({
      id: "operation-1",
      connectorId: "connector-1",
      resourceId: null,
      nodeId: "node-1",
      action: "create",
      phase: "pending",
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-09-05T00:00:00Z",
      updatedAt: "2026-09-05T00:00:00Z",
      completedAt: null,
      result: null,
    } satisfies HostingOperation);
    localStorage.setItem(
      "hosting-node:user-1:connector-1:new",
      JSON.stringify({
        operationId: "operation-1",
        input: { connectorId: "connector-1", name: "old-worker" },
      })
    );

    render(
      <MemoryRouter>
        <NodeEnrollmentDialog
          open
          initialMode="hosting"
          hosting={{ connectorId: "connector-1" }}
          onOpenChange={vi.fn()}
        />
      </MemoryRouter>
    );

    await screen.findByRole("combobox", { name: "Node Type" });
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.queryByText("Provisioning")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "External" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Hosting/i })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Close" })) {
      expect(button.closest("[data-dialog-body]")).toBeNull();
    }
  });

  it("uses the fixed provider context and keeps actions in the standard footer slot", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ scopes: ["hosting:resources:create"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "listHostingConnectors").mockResolvedValue([
      {
        ...hostingDefaults,
        id: "fixed",
        name: "DO",
        provider: "digitalocean",
        enabled: true,
        capabilities: { create: true },
        settings: DEFAULT_HOSTING_SETTINGS,
      } as HostingConnector,
    ]);
    vi.spyOn(api, "getHostingCatalog").mockResolvedValue({
      locations: [{ id: "ams3", name: "Amsterdam" }],
      sizes: [{ id: "small", name: "Basic" }],
      images: [{ id: "debian", name: "Debian", supportedRoles: ["docker"] }],
    });
    render(
      <MemoryRouter>
        <NodeEnrollmentDialog open hosting={{ connectorId: "fixed" }} onOpenChange={vi.fn()} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Hosting/i })).not.toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next.closest("[data-dialog-body]")).toBeNull();
    expect(next.parentElement?.parentElement).toHaveClass(
      "shrink-0",
      "px-4",
      "pb-4",
      "pt-4",
      "sm:px-6",
      "sm:pb-6"
    );
    await user.click(next);
    expect(await screen.findByRole("combobox", { name: "Location" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Hosting/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("combobox", { name: "Node Type" })).toBeInTheDocument();
  });

  it("animates the Relay-only field inside the existing dialog", async () => {
    const user = userEvent.setup();

    render(<NodeEnrollmentDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByPlaceholderText("relay.example.com")).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const form = screen.getByRole("combobox", { name: "Node Type" }).parentElement?.parentElement;
    expect(form?.children).toHaveLength(2);

    await user.click(screen.getByRole("combobox", { name: "Node Type" }));
    await user.click(screen.getByRole("option", { name: /Relay/ }));

    const relayAddress = await screen.findByPlaceholderText("relay.example.com");
    expect(relayAddress).toBeInTheDocument();
    expect(relayAddress.parentElement?.style.height).toBe("");
    expect(relayAddress.parentElement?.parentElement).toBe(form);
    expect(form?.children).toHaveLength(3);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("uses the standard locked Relay enrollment flow and closes after that node connects", async () => {
    const user = userEvent.setup();
    const pendingNode = makeNode({ id: "relay-node-1", type: "relay", status: "pending" });
    vi.spyOn(api, "createNode").mockResolvedValue({
      node: pendingNode,
      enrollmentToken: "relay-token",
      gatewayCertSha256: `sha256:${"a".repeat(64)}`,
      gatewayEnrollmentTargets: {
        public: { label: "Public node", gateway: "gateway.example.com:9443" },
      },
    });
    vi.spyOn(api, "getNode").mockResolvedValue({
      ...pendingNode,
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    const onNodeEnrolled = vi.fn();

    render(
      <NodeEnrollmentDialog
        open
        onOpenChange={vi.fn()}
        initialType="relay"
        lockType
        onNodeEnrolled={onNodeEnrolled}
      />
    );

    const typeSelector = screen.getByRole("combobox", { name: "Node Type" });
    expect(typeSelector).toBeDisabled();
    expect(
      screen.getByText("Adds a physical host to the Secure Link Relay Pool.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Bastion")).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("EU Relay"), "EU Relay 1");
    await user.type(screen.getByPlaceholderText("relay.example.com"), "relay-1.example.com");
    await user.click(screen.getByRole("button", { name: "Create Node" }));

    expect(api.createNode).toHaveBeenCalledWith({
      type: "relay",
      hostname: "pending",
      displayName: "EU Relay 1",
      serviceAddresses: ["relay-1.example.com"],
      servicePort: 9443,
    });
    expect(await screen.findByText("Node Created")).toBeInTheDocument();
    const command = screen.getByText(/setup-relay-node\.sh/);
    expect(command).toHaveTextContent("--advertise-address relay-1.example.com");

    act(() => realtimeHandler?.({ id: "relay-node-1", status: "online" }));

    await waitFor(() => expect(screen.queryByText("Node Created")).not.toBeInTheDocument());
    expect(onNodeEnrolled).toHaveBeenCalledWith("relay-node-1");
  });
});
