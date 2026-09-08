import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route } from "react-router-dom";
import { toast } from "sonner";
import { vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import {
  DEFAULT_HOSTING_SETTINGS,
  type HostingAccountSummary,
  type HostingConnector,
  type HostingOperation,
  type HostingResource,
} from "@/types/hosting";
import { HostingIntegrationsSection } from "../settings/HostingIntegrationsSection";
import { HostingConnectorDialog, hostingSettingsInput } from "./HostingConnectorDialog";
import { HostingIntegrationDetail } from "./HostingIntegrationDetail";
import { HostingResourcesTab } from "./HostingResourcesTab";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn(async () => true) }));
const connector: HostingConnector = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "proxmox",
  name: "Lab",
  baseUrl: "https://pve.example.test:8006",
  enabled: true,
  tokenLast4: "1234",
  settings: { ...DEFAULT_HOSTING_SETTINGS, tokenId: "gateway@pve!hosting", clusterId: "lab" },
  hasCustomCa: false,
  certificateFingerprint: null,
  capabilities: { finance: true },
  syncStatus: "success",
  syncLastError: null,
  testedAt: null,
  syncedAt: null,
  createdAt: "2026-09-05T00:00:00Z",
};
const finance: HostingAccountSummary = {
  balance: { amount: "12", currency: "USD", estimated: false },
  monthlyExpenses: { amount: "6.47", currency: "USD", estimated: true, period: "month" },
  observedAt: "2026-09-05T00:00:00Z",
};
const operation: HostingOperation = {
  id: "22222222-2222-4222-8222-222222222222",
  connectorId: connector.id,
  resourceId: "vm-id",
  nodeId: null,
  action: "start",
  phase: "pending",
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
  completedAt: null,
  result: null,
};
const resource: HostingResource = {
  id: "vm-id",
  connectorId: connector.id,
  remoteId: "250",
  kind: "vm",
  name: "Test VM",
  location: "lab",
  origin: "adopted",
  incarnation: "vm-original",
  powerState: "stopped",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 32,
  addresses: [],
  observedAt: "2026-09-05T00:00:00Z",
  missingSince: null,
  adoptionReason: null,
  nodes: [],
  capabilities: Object.fromEntries(
    [
      "start",
      "shutdown",
      "reboot",
      "resize",
      "delete",
      "recover",
      "create",
      "finance",
      "topup",
      "guestIdentity",
      "bootstrap",
    ].map((key) => [key, { available: true }])
  ) as HostingResource["capabilities"],
};
function login(scopes: string[]) {
  useAuthStore.setState({ user: makeUser({ scopes }), isAuthenticated: true, isLoading: false });
}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(useRealtime).mockClear();
  vi.spyOn(toast, "error").mockImplementation(() => "error-toast");
  vi.spyOn(toast, "warning").mockImplementation(() => "warning-toast");
  vi.spyOn(toast, "success").mockImplementation(() => "success-toast");
  login(["integrations:hosting:view", "integrations:hosting:manage"]);
  vi.spyOn(api, "getHostingConfiguration").mockResolvedValue(connector);
  vi.spyOn(api, "previewHostingConnector").mockResolvedValue({ name: "Hosting", capabilities: {} });
  vi.spyOn(api, "testHostingConnector").mockResolvedValue({ success: true });
  vi.spyOn(api, "discoverHostingConnector").mockResolvedValue({
    hosts: [{ id: "lab", name: "Lab" }],
    templates: [{ id: "9000", name: "Debian", host: "lab", ready: true, diskGb: 16 }],
    storages: [
      { id: "local-lvm", name: "local-lvm", host: "lab", content: ["images"] },
      { id: "local", name: "local", host: "lab", content: ["import", "iso"] },
    ],
    bridges: [{ id: "vmbr0", name: "vmbr0", host: "lab" }],
    usedVmids: [250],
  });
  vi.spyOn(api, "getHostingAccountSummary").mockResolvedValue(null);
  vi.spyOn(api, "getHostingConnector").mockResolvedValue(connector);
  vi.spyOn(api, "listHostingResources").mockResolvedValue([]);
  vi.spyOn(api, "listHostingOperations").mockResolvedValue([]);
  vi.spyOn(api, "getHostingCatalog").mockResolvedValue({ locations: [], sizes: [], images: [] });
});

it("reloads the provider snapshot after reconnect without needing a new event", async () => {
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await screen.findByRole("tab", { name: "Virtual machines" });
  const before = vi.mocked(api.listHostingResources).mock.calls.length;
  vi.mocked(api.getHostingConnector).mockResolvedValue({
    ...connector,
    name: "Updated after reconnect",
  });
  const subscription = vi
    .mocked(useRealtime)
    .mock.calls.filter(([channel]) => channel === "integration.connector.changed")
    .at(-1);
  expect(subscription?.[2]?.onReconnect).toBeTypeOf("function");
  await act(async () => {
    await subscription![2]!.onReconnect!();
  });
  await screen.findByText("Updated after reconnect");
  expect(api.listHostingResources).toHaveBeenCalledTimes(before + 1);
});

it("reloads the connector list after reconnect to recover missed removals", async () => {
  vi.spyOn(api, "listHostingConnectors").mockResolvedValue([connector]);
  renderWithRouter(<HostingIntegrationsSection />);
  await screen.findByText("Lab");
  vi.mocked(api.listHostingConnectors).mockResolvedValue([]);
  const subscription = vi
    .mocked(useRealtime)
    .mock.calls.filter(([channel]) => channel === "integration.connector.changed")
    .at(-1);
  expect(subscription?.[2]?.onReconnect).toBeTypeOf("function");
  await act(async () => {
    await subscription![2]!.onReconnect!();
  });
  await waitFor(() => expect(screen.queryByText("Lab")).not.toBeInTheDocument());
  expect(api.listHostingConnectors).toHaveBeenCalledTimes(2);
});

it.each([
  "success",
  "error",
] as const)("ignores late pre-reconnect connector list %s", async (outcome) => {
  let resolveOld!: (value: HostingConnector[]) => void;
  let rejectOld!: (error: Error) => void;
  vi.spyOn(api, "listHostingConnectors")
    .mockReturnValueOnce(
      new Promise((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      })
    )
    .mockResolvedValue([{ ...connector, name: "Fresh connector" }]);
  renderWithRouter(<HostingIntegrationsSection />);
  await waitFor(() => expect(api.listHostingConnectors).toHaveBeenCalledOnce());
  const subscription = vi
    .mocked(useRealtime)
    .mock.calls.filter(([channel]) => channel === "integration.connector.changed")
    .at(-1);
  await act(async () => {
    await subscription![2]!.onReconnect!();
  });
  await screen.findByText("Fresh connector");
  await act(async () => {
    if (outcome === "success") resolveOld([connector]);
    else rejectOld(new Error("Stale request failed"));
  });
  expect(screen.getByText("Fresh connector")).toBeInTheDocument();
  expect(screen.queryByText("Lab")).not.toBeInTheDocument();
  expect(toast.error).not.toHaveBeenCalled();
});

it("shows an accepted create immediately, then replaces it with its real VM without duplication", () => {
  const pending: HostingOperation = {
    ...operation,
    action: "create",
    resourceId: null,
    nodeId: "node-new",
    node: { id: "node-new", name: "new-worker", type: "docker", location: "fra1" },
  };
  const view = renderWithRouter(
    <HostingResourcesTab connector={connector} resources={[]} operations={[pending]} />
  );
  expect(screen.getByText("new-worker")).toBeInTheDocument();
  expect(screen.getByText("Pending")).toBeInTheDocument();
  expect(screen.queryByText("No provider resources found.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Manage/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("new-worker"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(
    <HostingResourcesTab
      connector={connector}
      resources={[
        {
          ...resource,
          name: "new-worker",
          nodes: [
            {
              id: "node-new",
              name: "new-worker",
              type: "docker",
              status: "pending",
              slug: "new-worker",
            },
          ],
        },
      ]}
      operations={[{ ...pending, resourceId: resource.id, phase: "provisioning" }]}
    />
  );
  expect(screen.getAllByText("new-worker")).toHaveLength(1);
  expect(screen.queryByText("Awaiting provider ID")).not.toBeInTheDocument();
});

it("shows destroying in both the VM and node columns while deletion is pending", () => {
  const destroy: HostingOperation = { ...operation, action: "delete", phase: "pending" };
  renderWithRouter(
    <HostingResourcesTab connector={connector} resources={[resource]} operations={[destroy]} />
  );
  expect(screen.getAllByText(/destroying/i)).toHaveLength(2);
});
it("places the node status above its muted caption and keeps VM preparation pending", () => {
  renderWithRouter(
    <HostingResourcesTab
      connector={connector}
      resources={[resource]}
      operations={[{ ...operation, action: "create", phase: "provisioning" }]}
    />
  );
  const status = screen.getByText("Pending").parentElement!;
  expect(status.parentElement?.firstElementChild).toBe(status);
  expect(status.nextElementSibling).toHaveClass("mt-1", "text-xs", "text-muted-foreground");
  expect(screen.queryByText("Enrolling")).not.toBeInTheDocument();
});

it("keeps a rejected create visible as failed without pretending it has a provider VM", () => {
  renderWithRouter(
    <HostingResourcesTab
      connector={connector}
      resources={[]}
      operations={[
        {
          ...operation,
          action: "create",
          resourceId: null,
          nodeId: "node-new",
          phase: "failed",
          errorMessage: "DigitalOcean denied VM creation",
          node: { id: "node-new", name: "failed-worker", type: "docker", location: "fra1" },
        },
      ]}
    />
  );
  expect(screen.getByText("Provisioning failed")).toBeInTheDocument();
  expect(screen.getByText("DigitalOcean denied VM creation")).toBeInTheDocument();
  expect(screen.queryByText("Provisioning")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Manage/ })).not.toBeInTheDocument();
});

async function nextConnectorStep(step = 2) {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: /^(Continue|Review)$/ }));
  await screen.findByText(new RegExp(`Step ${step} of`));
}

async function discoverConnectorHost() {
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeEnabled()
  );
}

it("cancels the first connector step without creating anything", () => {
  const onClose = vi.fn();
  const create = vi.spyOn(api, "createHostingConnector");
  renderWithRouter(<HostingConnectorDialog open onClose={onClose} onSaved={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});

it("shows loading on the test action and reuses success until credentials change", async () => {
  let finishTest!: (value: Awaited<ReturnType<typeof api.previewHostingConnector>>) => void;
  vi.mocked(api.previewHostingConnector).mockReturnValueOnce(
    new Promise((resolve) => {
      finishTest = resolve;
    })
  );
  renderWithRouter(<HostingConnectorDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Connector name"), { target: { value: "Cloud" } });
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), { target: { value: "token" } });
  const testButton = screen.getByRole("button", { name: "Test Connection" });
  fireEvent.click(testButton);
  expect(testButton).toHaveAttribute("aria-busy", "true");
  expect(testButton.querySelector(".animate-spin")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute("aria-busy", "false");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.queryByText("Please wait…")).not.toBeInTheDocument();
  await act(async () => finishTest({ name: "Cloud", capabilities: {} }));
  expect(testButton).toHaveAttribute("aria-busy", "false");
  expect(testButton.querySelector(".lucide-check")).not.toBeNull();
  await nextConnectorStep();
  expect(api.previewHostingConnector).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(await screen.findByLabelText(/^API (?:key|token)$/), {
    target: { value: "new-token" },
  });
  expect(
    screen.getByRole("button", { name: "Test Connection" }).querySelector(".lucide-check")
  ).toBeNull();
  await nextConnectorStep();
  expect(api.previewHostingConnector).toHaveBeenCalledTimes(2);
});

it("shows actionable provider errors in sonner and resets the test action", async () => {
  const message =
    "Provider connection timed out. Check that Gateway can reach the API address and port through your firewall.";
  vi.mocked(api.previewHostingConnector).mockRejectedValueOnce(new Error(message));
  renderWithRouter(<HostingConnectorDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Connector name"), { target: { value: "Cloud" } });
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), { target: { value: "token" } });
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  expect(screen.getByRole("button", { name: "Test Connection" })).toHaveAttribute(
    "aria-busy",
    "false"
  );
  expect(screen.getByText("Step 1 of 2 — Connection")).toBeInTheDocument();
  expect(screen.queryByText(message)).not.toBeInTheDocument();
});

it("reports missing creation scopes in Sonner without blocking an inventory connection", async () => {
  const reason = "DigitalOcean token is missing required scopes: tag:create.";
  vi.mocked(api.previewHostingConnector).mockResolvedValue({
    name: "Cloud",
    capabilities: {
      create: { available: false, reasonCode: "permission_denied", reason },
    },
  });
  renderWithRouter(<HostingConnectorDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Connector name"), { target: { value: "Cloud" } });
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), { target: { value: "token" } });
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(toast.warning).toHaveBeenCalledWith("Connected with limited permissions", {
      description: reason,
    })
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.queryByText(reason)).not.toBeInTheDocument();
  await nextConnectorStep();
  expect(screen.getByText("Step 2 of 2 — Settings")).toBeInTheDocument();
});

it("validates the saved token and clears limited-permission feedback after a replacement", async () => {
  const saved: HostingConnector = {
    ...connector,
    provider: "digitalocean",
    baseUrl: "https://api.digitalocean.com",
  };
  vi.mocked(api.getHostingConfiguration).mockResolvedValue(saved);
  vi.mocked(api.testHostingConnector).mockResolvedValue({
    success: true,
    capabilities: {
      create: { available: false, reasonCode: "permission_denied", reason: "Missing tag:create" },
    },
  });
  renderWithRouter(
    <HostingConnectorDialog open connector={saved} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  const token = await screen.findByLabelText(/^API (?:key|token)$/);
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(toast.warning).toHaveBeenCalledWith("Connected with limited permissions", {
      description: "Missing tag:create",
    })
  );
  expect(api.previewHostingConnector).not.toHaveBeenCalled();
  fireEvent.change(token, { target: { value: "replacement-token" } });
  vi.mocked(api.previewHostingConnector).mockResolvedValue({
    name: "Cloud",
    capabilities: { create: { available: true } },
  });
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Connection successful"));
  expect(api.previewHostingConnector).toHaveBeenCalledOnce();
});

it("saves inventory-only Proxmox without a template, custom CA, or fingerprint", async () => {
  const save = vi.spyOn(api, "updateHostingConnector").mockResolvedValue(connector);
  renderWithRouter(
    <HostingConnectorDialog open connector={connector} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await nextConnectorStep();
  await discoverConnectorHost();
  await nextConnectorStep(3);
  expect(api.discoverHostingConnector).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const input = save.mock.calls[0][1];
  expect(input.settings.proxmox).toBeUndefined();
  expect(input.settings.caCertificate).toBeUndefined();
  expect(input.settings.certificateFingerprint).toBeUndefined();
  expect(input.token).toBeUndefined();
});

it("creates an enabled connector without an enabled toggle", async () => {
  const save = vi.spyOn(api, "createHostingConnector").mockResolvedValue(connector);
  renderWithRouter(<HostingConnectorDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText("API key")).toHaveAttribute(
    "placeholder",
    "Original HOSTKEY API key"
  );
  expect(screen.getByText(/Original HOSTKEY API key, not its displayed hash/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Enabled" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveClass("sm:max-w-2xl");
  expect(dialog.querySelector("[data-dialog-header]")).toHaveTextContent("Step 1 of 2");
  expect(screen.getByRole("button", { name: "About API origin" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Connector name" }), {
    target: { value: "Hosting" },
  });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), { target: { value: "   " } });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), {
    target: { value: "test-token" },
  });
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
  await nextConnectorStep();
  fireEvent.change(screen.getByLabelText("Sync interval"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Create connector" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Sync interval"), { target: { value: "300" } });
  fireEvent.click(screen.getByRole("button", { name: "Create connector" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0]).toMatchObject({ enabled: true, name: "Hosting" });
});

it("retains the enabled toggle for an existing disabled connector", async () => {
  const save = vi.spyOn(api, "updateHostingConnector").mockResolvedValue(connector);
  renderWithRouter(
    <HostingConnectorDialog
      open
      connector={{ ...connector, enabled: false }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeEnabled()
  );
  expect(screen.getByRole("button", { name: "Enabled", pressed: false })).toBeInTheDocument();
  await nextConnectorStep();
  await discoverConnectorHost();
  await nextConnectorStep(3);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].enabled).toBe(false);
  expect(api.discoverHostingConnector).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: true, connectorId: connector.id, tlsMode: "system" })
  );
});

it("embeds the standard empty state and gives the header add button a plus icon", async () => {
  vi.spyOn(api, "listHostingConnectors").mockResolvedValue([]);
  renderWithRouter(<HostingIntegrationsSection />);
  const message = await screen.findByText(/No hosting connectors configured/);
  expect(message.parentElement).toHaveClass("px-4", "py-8");
  expect(message.parentElement).not.toHaveClass("border");
  const [add] = screen.getAllByRole("button", { name: "Add connector" });
  expect(add.querySelector("svg")).not.toBeNull();
  fireEvent.click(add);
  expect(screen.getByRole("heading", { name: "Add hosting connector" })).toBeInTheDocument();
});

it("strips provider read-model fields and never silently certifies a clean template", () => {
  const settings = hostingSettingsInput(
    { ...connector.settings, accountName: "readonly" } as typeof connector.settings,
    false
  );
  expect(settings).not.toHaveProperty("accountName");
  expect(settings).not.toHaveProperty("proxmox");
});

it("keeps cloud credentials when navigating back without creating a connector", async () => {
  const create = vi.spyOn(api, "createHostingConnector");
  renderWithRouter(<HostingConnectorDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Connector name"), { target: { value: "Cloud" } });
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), { target: { value: "token" } });
  await nextConnectorStep();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByLabelText("Connector name")).toHaveValue("Cloud");
  expect(screen.getByLabelText(/^API (?:key|token)$/)).toHaveValue("token");
  expect(screen.queryByLabelText("Stable cluster ID")).not.toBeInTheDocument();
});

it("uses five Proxmox steps and refuses a static IP pool smaller than the VMID pool", async () => {
  const configured = {
    ...connector,
    settings: {
      ...connector.settings,
      proxmoxHost: "lab",
      proxmox: {
        nodes: ["lab"],
        templateId: 9000,
        templateNode: "lab",
        storage: "local-lvm",
        bridge: "vmbr0",
        cleanTemplate: true,
        network: "static" as const,
        vmidRange: "250-260,271,273-280",
        ipRange: "192.0.2.100-192.0.2.118",
        subnet: "192.0.2.0/24",
        gateway: "192.0.2.1",
        vlan: 20,
        defaultCpu: 3,
        defaultMemoryMb: 4096,
        defaultDiskGb: 32,
      },
    },
  };
  vi.mocked(api.getHostingConfiguration).mockResolvedValue(configured);
  const save = vi.spyOn(api, "updateHostingConnector").mockResolvedValue(configured);
  renderWithRouter(
    <HostingConnectorDialog open connector={configured} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await nextConnectorStep();
  expect(screen.getByText("Step 2 of 5 — Proxmox host")).toBeInTheDocument();
  expect(api.discoverHostingConnector).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  await discoverConnectorHost();
  await nextConnectorStep(3);
  expect(screen.getByText("Step 3 of 5 — Infrastructure")).toBeInTheDocument();
  expect(screen.queryByLabelText("Template")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("CPU cores")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Allowed VMIDs")).toHaveValue("250-260,271,273-280");
  fireEvent.change(screen.getByLabelText("Allowed VMIDs"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Allowed VMIDs"), {
    target: { value: "250-260,271,273-280" },
  });
  fireEvent.change(screen.getByLabelText("Maximum CPU budget (cores)"), { target: { value: "0" } });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Maximum CPU budget (cores)"), { target: { value: "3" } });
  await nextConnectorStep(4);
  expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /^(Continue|Review)$/ }));
  expect(toast.error).not.toHaveBeenCalled();
  expect(
    screen.queryByText("Provide at least 20 IP addresses for 20 VMIDs.")
  ).not.toBeInTheDocument();
  expect(screen.getByText("Step 4 of 5 — Network")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("IP pool"), {
    target: { value: "192.0.2.100-192.0.2.119" },
  });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Gateway"), { target: { value: " " } });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Gateway"), { target: { value: "192.0.2.1" } });
  fireEvent.change(screen.getByLabelText("DNS servers"), {
    target: { value: "192.0.2.53,192.0.2.54" },
  });
  await nextConnectorStep(5);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].settings).toMatchObject({
    proxmoxHost: "lab",
    proxmox: {
      nodes: ["lab"],
      vmidRange: "250-260,271,273-280",
      ipRange: "192.0.2.100-192.0.2.119",
      vlan: 20,
      dnsServers: ["192.0.2.53", "192.0.2.54"],
      maxCpu: 3,
    },
  });
});

it("does not advance or save when Proxmox discovery fails", async () => {
  vi.mocked(api.discoverHostingConnector).mockRejectedValue(
    new Error("Certificate could not be verified")
  );
  const save = vi.spyOn(api, "updateHostingConnector");
  renderWithRouter(
    <HostingConnectorDialog open connector={connector} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await nextConnectorStep();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Certificate could not be verified")
  );
  expect(screen.queryByText("Certificate could not be verified")).not.toBeInTheDocument();
  expect(screen.getByText("Step 2 of 3 — Proxmox host")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});

it("requires a discovered physical host and invalidates it when trust changes", async () => {
  vi.mocked(api.discoverHostingConnector).mockResolvedValue({
    hosts: [
      { id: "lab", name: "Lab" },
      { id: "second", name: "Second host" },
    ],
    templates: [],
    storages: [],
    bridges: [],
    usedVmids: [],
  });
  renderWithRouter(
    <HostingConnectorDialog open connector={connector} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await nextConnectorStep();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Physical host" })).toBeEnabled()
  );
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("combobox", { name: "Physical host" }));
  fireEvent.mouseDown(await screen.findByRole("button", { name: "Second host" }));
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeEnabled();
  fireEvent.click(screen.getByRole("combobox", { name: "Certificate verification" }));
  fireEvent.mouseDown(await screen.findByRole("button", { name: "Private CA certificate" }));
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("CA certificate"), { target: { value: "private-ca" } });
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
});

it("sends an explicit trust mode when switching a saved private CA to system trust", async () => {
  vi.mocked(api.getHostingConfiguration).mockResolvedValue({
    ...connector,
    settings: { ...connector.settings, caCertificate: "private-ca" },
  });
  renderWithRouter(
    <HostingConnectorDialog open connector={connector} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeEnabled()
  );
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), {
    target: { value: "fresh-token" },
  });
  await nextConnectorStep();
  fireEvent.click(screen.getByRole("combobox", { name: "Certificate verification" }));
  fireEvent.mouseDown(await screen.findByRole("button", { name: "System trust" }));
  await discoverConnectorHost();
  await nextConnectorStep(3);
  const request = vi.mocked(api.discoverHostingConnector).mock.calls[0][0];
  expect(request.tlsMode).toBe("system");
  expect(request.settings.caCertificate).toBeUndefined();
  expect(request.settings.certificateFingerprint).toBeUndefined();
});

it("puts Proxmox host and trust on a separate step with Cancel only on the first step", async () => {
  renderWithRouter(<HostingConnectorDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
  fireEvent.mouseDown(await screen.findByRole("button", { name: "Proxmox VE" }));
  expect(await screen.findByText("Step 1 of 5 — Connection")).toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Certificate verification" })
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "VM provisioning" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Test Connection" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Connector name"), { target: { value: "Lab" } });
  fireEvent.change(screen.getByLabelText("API origin"), { target: { value: connector.baseUrl } });
  fireEvent.change(screen.getByLabelText("Token ID"), {
    target: { value: connector.settings.tokenId },
  });
  fireEvent.change(screen.getByLabelText(/^API (?:key|token)$/), { target: { value: "secret" } });
  fireEvent.change(screen.getByLabelText("Token ID"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Token ID"), {
    target: { value: connector.settings.tokenId },
  });
  await nextConnectorStep();
  expect(api.discoverHostingConnector).not.toHaveBeenCalled();
  expect(screen.getByText("Step 2 of 5 — Proxmox host")).toBeInTheDocument();
  expect(screen.queryByLabelText("Connector name")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "VM provisioning", pressed: true })
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Stable cluster ID")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("CA certificate")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Certificate SHA-256 pin")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("combobox", { name: "Certificate verification" }));
  fireEvent.mouseDown(
    await screen.findByRole("button", { name: "Verified certificate fingerprint" })
  );
  expect(await screen.findByLabelText("Certificate SHA-256 pin")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Certificate SHA-256 pin"), {
    target: { value: "a".repeat(64) },
  });
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "VM provisioning" }));
  expect(screen.getByText("Step 2 of 3 — Proxmox host")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByLabelText(/^API (?:key|token)$/)).toHaveValue("secret");
  expect(screen.queryByLabelText("Certificate SHA-256 pin")).not.toBeInTheDocument();
  await nextConnectorStep();
  expect(screen.getByLabelText("Certificate SHA-256 pin")).toBeInTheDocument();
});

it("retains separators in cloud scopes and exposes labeled switches", async () => {
  const cloud = { ...connector, provider: "digitalocean" as const };
  vi.mocked(api.getHostingConfiguration).mockResolvedValue(cloud);
  const save = vi.spyOn(api, "updateHostingConnector").mockResolvedValue(connector);
  renderWithRouter(
    <HostingConnectorDialog open connector={cloud} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await nextConnectorStep();
  for (const name of ["Automatic sync", "Automatic adoption"])
    expect(screen.getByRole("button", { name, pressed: true })).toBeInTheDocument();
  expect(screen.queryByLabelText("Resource scope")).not.toBeInTheDocument();
  const field = screen.getByRole("textbox", { name: "Node scope" });
  fireEvent.change(field, { target: { value: `${connector.id},` } });
  expect(field).toHaveValue(`${connector.id},`);
  fireEvent.change(field, { target: { value: connector.id } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].settings.adoptionNodeIds).toEqual([connector.id]);
});

it("does not reset an open configuration draft on background account polling", async () => {
  const callbacks = { onClose: vi.fn(), onSaved: vi.fn() };
  const view = render(<HostingConnectorDialog open connector={connector} {...callbacks} />);
  await nextConnectorStep();
  await discoverConnectorHost();
  await nextConnectorStep(3);
  fireEvent.change(screen.getByLabelText("Sync interval"), {
    target: { value: "600" },
  });
  view.rerender(
    <HostingConnectorDialog
      open
      connector={{ ...connector, syncedAt: new Date().toISOString() }}
      {...callbacks}
    />
  );
  expect(screen.getByLabelText("Sync interval")).toHaveValue(600);
  expect(screen.getByText("Step 3 of 3 — Settings")).toBeInTheDocument();
  expect(api.getHostingConfiguration).toHaveBeenCalledOnce();
});

it("hides Proxmox raw scope inputs while preserving saved restrictions", async () => {
  const restricted = {
    ...connector,
    settings: {
      ...connector.settings,
      resourceIds: ["250", "251"],
      adoptionNodeIds: ["saved-node"],
    },
  };
  vi.mocked(api.getHostingConfiguration).mockResolvedValue(restricted);
  const save = vi.spyOn(api, "updateHostingConnector").mockResolvedValue(restricted);
  renderWithRouter(
    <HostingConnectorDialog open connector={restricted} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await nextConnectorStep();
  await discoverConnectorHost();
  await nextConnectorStep(3);
  expect(screen.queryByLabelText("Resource scope")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Node scope")).not.toBeInTheDocument();
  expect(screen.queryByText("250, 251")).not.toBeInTheDocument();
  expect(screen.getByText("saved-node")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].settings).toMatchObject({
    resourceIds: ["250", "251"],
    adoptionNodeIds: ["saved-node"],
  });
});

it.each([
  "click",
  "keyboard",
])("opens the connector from the card by %s without an Open button", async (method) => {
  vi.mocked(api.listHostingConnectors).mockResolvedValue([connector]);
  renderWithRouter(<HostingIntegrationsSection />, {
    path: "/settings/integrations",
    route: "/settings/integrations",
    extraRoutes: <Route path="/hosting/:id" element={<p>Connector destination</p>} />,
  });
  const card = await screen.findByRole("link", { name: "Open Lab" });
  expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  if (method === "click") fireEvent.click(card);
  else fireEvent.keyDown(card, { key: "Enter" });
  expect(screen.getByText("Connector destination")).toBeInTheDocument();
});

it("does not navigate when a connector card action is clicked", async () => {
  vi.mocked(api.listHostingConnectors).mockResolvedValue([connector]);
  renderWithRouter(<HostingIntegrationsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Test Lab" }));
  await waitFor(() => expect(api.testHostingConnector).toHaveBeenCalledOnce());
  expect(screen.getByRole("link", { name: "Open Lab" })).toBeInTheDocument();
});

it("uses a single ghost menu action for discovered VMs, including installation", async () => {
  login(["hosting:resources:create", "hosting:resources:recover", "nodes:create"]);
  const onInstall = vi.fn();
  const discovered = { ...resource, origin: "discovered" as const };
  render(
    <HostingResourcesTab
      connector={connector}
      resources={[discovered]}
      operations={[]}
      onInstall={onInstall}
    />
  );
  expect(screen.queryByRole("button", { name: "Install Gateway" })).not.toBeInTheDocument();
  const menu = screen.getByRole("button", { name: "Manage Test VM" });
  expect(menu).toBeEnabled();
  fireEvent.keyDown(menu, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Install Gateway" }));
  expect(onInstall).toHaveBeenCalledWith(discovered);
});

it("blocks saving defaults over a configuration that failed to load", async () => {
  vi.mocked(api.getHostingConfiguration).mockRejectedValue(new Error("Configuration unavailable"));
  const save = vi.spyOn(api, "updateHostingConnector");
  renderWithRouter(
    <HostingConnectorDialog open connector={connector} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Configuration unavailable"));
  expect(screen.queryByText("Configuration unavailable")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});

it("does not give another account's manager configuration authority", async () => {
  login(["integrations:hosting:manage:other-account"]);
  renderWithRouter(
    <HostingConnectorDialog open connector={connector} onClose={vi.fn()} onSaved={vi.fn()} />
  );
  await waitFor(() => expect(api.getHostingConfiguration).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: /^(Continue|Review)$/ })).toBeDisabled();
});

it.each([
  "proxmox",
  "hetzner",
] as const)("has no financial UI for %s even with billing rights", async (provider) => {
  login(["integrations:hosting:view", "hosting:billing:view"]);
  vi.mocked(api.getHostingConnector).mockResolvedValue({ ...connector, provider });
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await screen.findByRole("tab", { name: "Virtual machines" });
  expect(screen.queryByText("Finance")).not.toBeInTheDocument();
  expect(screen.queryByText("Account balance")).not.toBeInTheDocument();
});

it("hides DO finance when provider billing permission is absent despite Gateway billing scope", async () => {
  login(["integrations:hosting:view", "hosting:billing:view"]);
  vi.mocked(api.getHostingConnector).mockResolvedValue({
    ...connector,
    provider: "digitalocean",
    capabilities: { finance: false },
  });
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await screen.findByRole("tab", { name: "Virtual machines" });
  expect(screen.queryByRole("tab", { name: "Finance" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  expect(screen.queryByText("Account balance")).not.toBeInTheDocument();
});

it("shows cached account cards in overview and removes finance and operational stat cards", async () => {
  login(["integrations:hosting:view", "hosting:billing:view"]);
  vi.mocked(api.getHostingConnector).mockResolvedValue({
    ...connector,
    provider: "hostkey",
    syncedAt: "2026-09-06T10:00:00Z",
  });
  vi.mocked(api.getHostingAccountSummary).mockResolvedValue(finance);
  vi.mocked(api.listHostingOperations).mockResolvedValue([{ ...operation, action: "topup" }]);
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  expect(await screen.findByText("12.00 USD")).toBeInTheDocument();
  expect(screen.getByText("6.47 USD")).toBeInTheDocument();
  expect(screen.getByText("Last sync")).toBeInTheDocument();
  expect(screen.getByText("Last connection test")).toBeInTheDocument();
  for (const label of ["Finance", "Active operations", "Observed", "Tested", "Top up", "topup"])
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  act(() => login(["integrations:hosting:view"]));
  expect(screen.queryByText("12.00 USD")).not.toBeInTheDocument();
});

it.each([
  [true, true, "xl:grid-cols-4"],
  [false, true, "xl:grid-cols-3"],
  [true, false, "xl:grid-cols-3"],
  [false, false, "sm:grid-cols-2"],
] as const)("fills the overview row for balance %s and expenses %s", async (balance, expenses, columns) => {
  login(["integrations:hosting:view", "hosting:billing:view"]);
  vi.mocked(api.getHostingAccountSummary).mockResolvedValue({
    ...finance,
    balance: balance ? finance.balance : null,
    monthlyExpenses: expenses ? finance.monthlyExpenses : null,
  });
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await screen.findByText("Automatic adoption");
  await waitFor(() => {
    const grid = screen.getByText("Automatic adoption").closest(".grid");
    expect(grid).toHaveClass(columns);
    expect(grid?.children).toHaveLength(2 + Number(balance) + Number(expenses));
    if (!balance || !expenses) expect(grid).not.toHaveClass("xl:grid-cols-4");
  });
});

it("does not read another account summary through a foreign billing scope", async () => {
  login(["integrations:hosting:view", "hosting:billing:view:another-account"]);
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await screen.findByRole("tab", { name: "Overview" });
  expect(api.getHostingAccountSummary).not.toHaveBeenCalled();
});

it.each([
  ["provisioning", "Provisioning"],
  ["awaiting_payment", "Awaiting payment"],
] as const)("shows %s while the provider VM identity is still pending", (phase, label) => {
  login(["integrations:hosting:view"]);
  renderWithRouter(
    <HostingResourcesTab
      connector={{ ...connector, provider: "hostkey" }}
      resources={[]}
      operations={[
        {
          ...operation,
          action: "create",
          phase,
          resourceId: null,
          nodeId: "node-1",
          node: { id: "node-1", name: "New hostkey VM", type: "docker", location: "NL" },
        },
      ]}
    />
  );
  expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(screen.getByText("Awaiting provider VM")).toBeInTheDocument();
});

it("keeps the initial provider page loading until its resource projection arrives", async () => {
  login(["integrations:hosting:view"]);
  let resolve!: (resources: HostingResource[]) => void;
  vi.mocked(api.listHostingResources).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await waitFor(() => expect(api.listHostingResources).toHaveBeenCalledOnce());
  expect(screen.queryByRole("tab", { name: "Virtual machines" })).not.toBeInTheDocument();
  await act(async () => resolve([resource]));
  expect(screen.getByRole("tab", { name: "Virtual machines" })).toBeInTheDocument();
});

it("renders the provider page without waiting for auxiliary catalog metadata", async () => {
  login(["integrations:hosting:view"]);
  vi.mocked(api.getHostingCatalog).mockReturnValue(new Promise(() => {}));
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  expect(await screen.findByRole("tab", { name: "Virtual machines" })).toBeInTheDocument();
});

it("exposes configure and non-cascading delete in header overflow", async () => {
  const remove = vi.spyOn(api, "deleteHostingConnector").mockResolvedValue({ success: true });
  renderWithRouter(<HostingIntegrationDetail />, {
    path: "/hosting/:connectorId/:tab?",
    route: `/hosting/${connector.id}/overview`,
  });
  await screen.findByRole("tab", { name: "Virtual machines" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Page actions" }), { key: "Enter" });
  expect(await screen.findByRole("menuitem", { name: "Configure" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete connector" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(connector.id));
});

it("dispatches explicit VM actions without restoring saved browser operations", async () => {
  login(["hosting:resources:power"]);
  const action = vi
    .spyOn(api, "hostingResourceAction")
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce(operation);
  const openMenu = async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "Manage Test VM" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Power on" }));
  };
  const first = renderWithRouter(
    <HostingResourcesTab connector={connector} resources={[resource]} operations={[]} />
  );
  await openMenu();
  await waitFor(() => expect(action).toHaveBeenCalledOnce());
  expect(localStorage.length).toBe(0);
  const key = `gateway:hosting:action:user-1:${connector.id}:${resource.id}:${resource.incarnation}`;
  localStorage.setItem(
    key,
    JSON.stringify({ input: action.mock.calls[0][1], operationId: "old-operation" })
  );
  const get = vi.spyOn(api, "getHostingOperation");
  first.unmount();
  renderWithRouter(
    <HostingResourcesTab connector={connector} resources={[resource]} operations={[]} />
  );
  await openMenu();
  await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  expect(action.mock.calls[1][1].idempotencyKey).not.toBe(action.mock.calls[0][1].idempotencyKey);
  expect(get).not.toHaveBeenCalled();
});

it("denies VM actions with a scope for a different VM", () => {
  login(["hosting:resources:power:other-vm"]);
  renderWithRouter(
    <HostingResourcesTab connector={connector} resources={[resource]} operations={[]} />
  );
  expect(screen.getByRole("button", { name: "Manage Test VM" })).toBeDisabled();
});

it("retries installation from its VM menu and returns to the resource status", async () => {
  login(["hosting:resources:recover", "nodes:config:edit"]);
  const original = {
    ...operation,
    action: "create" as const,
    phase: "failed" as const,
    nodeId: "node-1",
  };
  const accepted = {
    ...original,
    id: "retry-1",
    action: "install" as const,
    phase: "pending" as const,
  };
  const retry = vi.spyOn(api, "retryHostingInstall").mockResolvedValue(accepted);
  const create = vi.spyOn(api, "provisionHostingNode");
  const lookup = vi.spyOn(api, "getHostingOperation");
  renderWithRouter(
    <HostingResourcesTab
      connector={connector}
      resources={[{ ...resource, powerState: "running" }]}
      operations={[original]}
    />
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Manage Test VM" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Retry installation" }));
  fireEvent.click(screen.getByRole("button", { name: "Retry installation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(retry).toHaveBeenCalledWith(original.id, { idempotencyKey: expect.any(String) });
  expect(screen.getByText("Pending")).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it("submits numeric Proxmox limits without a fake custom size identifier", async () => {
  login(["hosting:resources:resize"]);
  const action = vi
    .spyOn(api, "hostingResourceAction")
    .mockResolvedValue({ ...operation, action: "resize" });
  renderWithRouter(
    <HostingResourcesTab connector={connector} resources={[resource]} operations={[]} />
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Manage Test VM" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Resize configuration" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "CPU" }), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Resize resource" }));
  await waitFor(() => expect(action).toHaveBeenCalledOnce());
  expect(action.mock.calls[0][1]).toMatchObject({ action: "resize", cpu: 4 });
  expect(action.mock.calls[0][1]).not.toHaveProperty("size");
  expect(action.mock.calls[0][1]).not.toHaveProperty("memoryMb");
});
