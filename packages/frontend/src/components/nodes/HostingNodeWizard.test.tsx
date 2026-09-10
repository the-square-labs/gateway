import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { vi } from "vitest";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import {
  DEFAULT_HOSTING_SETTINGS,
  type HostingCatalog,
  type HostingConnector,
  type HostingOperation,
  type HostingProvisionInput,
} from "@/types/hosting";
import { HostingNodeWizard, hostingSizeDescription, hostingWizardPrice } from "./HostingNodeWizard";

const connector: HostingConnector = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "digitalocean",
  name: "DO account",
  baseUrl: "https://api.digitalocean.com",
  enabled: true,
  tokenLast4: "1234",
  settings: DEFAULT_HOSTING_SETTINGS,
  hasCustomCa: false,
  certificateFingerprint: null,
  capabilities: { create: true },
  syncStatus: "success",
  syncLastError: null,
  testedAt: null,
  syncedAt: null,
  createdAt: "2026-09-05T00:00:00Z",
};
const input: HostingProvisionInput = {
  connectorId: connector.id,
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  role: "docker",
  name: "worker",
  location: "ams3",
  size: "small",
  image: "debian",
  confirmedPrice: { amount: "6", currency: "USD" },
};
const operation: HostingOperation = {
  id: "33333333-3333-4333-8333-333333333333",
  connectorId: connector.id,
  resourceId: null,
  nodeId: "node",
  action: "create",
  phase: "pending",
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
  completedAt: null,
  result: null,
};
const catalog: HostingCatalog = {
  locations: [{ id: "ams3", name: "Amsterdam" }],
  sizes: [{ id: "small", name: "Small", price: { amount: "6", currency: "USD", estimated: true } }],
  images: [{ id: "debian", name: "Debian", supportedRoles: ["docker"] }],
};

beforeEach(() => {
  vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
  localStorage.clear();
  useAuthStore.setState({
    user: makeUser({
      scopes: ["integrations:hosting:view", "hosting:resources:create", "nodes:create"],
    }),
    isAuthenticated: true,
    isLoading: false,
  });
  vi.spyOn(api, "listHostingConnectors").mockResolvedValue([connector]);
  vi.spyOn(api, "getHostingCatalog").mockResolvedValue(catalog);
});
it("keeps the size placeholder when a default tariff is unavailable in the initial region", async () => {
  vi.mocked(api.listHostingConnectors).mockResolvedValue([{ ...connector, provider: "hetzner" }]);
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    ...catalog,
    sizes: [{ ...catalog.sizes[0], locations: ["ash"] }],
  });
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("combobox", { name: "Size" })).toHaveTextContent("Select a size");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("uses location-specific price", () => {
  expect(
    hostingWizardPrice(
      {
        ...catalog,
        sizes: [
          {
            ...catalog.sizes[0],
            locationPrices: { ams3: { amount: "7", currency: "USD", estimated: true } },
          },
        ],
      },
      "small",
      "ams3"
    )?.amount
  ).toBe("7");
});

it.each([
  "digitalocean",
  "hetzner",
  "hostkey",
] as const)("shows the %s review price once, keeps resources in Size and preserves the original quote", async (provider) => {
  const amount = " 5.9900000000000000 ";
  vi.mocked(api.listHostingConnectors).mockResolvedValue([{ ...connector, provider }]);
  const size = {
    ...catalog.sizes[0],
    cpu: 2,
    memoryMb: 2048,
    diskGb: 40,
    price: { amount: "9.9900", currency: "USD", period: "month" as const, estimated: true },
    locationPrices: {
      ams3: { amount, currency: "USD", period: "month" as const, estimated: true },
    },
  };
  vi.mocked(api.getHostingCatalog).mockResolvedValue({ ...catalog, sizes: [size] });
  const provision = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
  expect(hostingSizeDescription(size, "ams3")).toBe(
    "2 vCPU · 2 GiB RAM · 40 GB disk · 5.99 USD / month"
  );
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  const submit = await review();
  expect(screen.getByText("Small · small · 2 vCPU · 2 GiB RAM · 40 GB disk")).toBeInTheDocument();
  expect(screen.getAllByText(/5\.99 USD/)).toHaveLength(1);
  expect(screen.getByText("5.99 USD / month (estimate)")).toBeInTheDocument();
  expect(screen.queryByText(/5\.990000/)).not.toBeInTheDocument();
  fireEvent.click(submit);
  await waitFor(() =>
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedPrice: { amount, currency: "USD" } })
    )
  );
});

it("omits the automatic installation row and puts a spinner before the submitting label", async () => {
  let resolve!: (result: HostingOperation) => void;
  vi.spyOn(api, "provisionHostingNode").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const accepted = vi.fn();
  renderWithRouter(
    <HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} onCreated={accepted} />
  );
  const submit = await review();
  await waitFor(() => expect(submit).toBeEnabled());
  expect(screen.queryByText("Automatic")).not.toBeInTheDocument();
  expect(screen.queryByText("Installation")).not.toBeInTheDocument();
  fireEvent.click(submit);
  const busy = await screen.findByRole("button", { name: "Submitting…" });
  expect(busy).toBeDisabled();
  expect(busy.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  expect(busy.firstElementChild).toHaveClass("animate-spin");
  resolve(operation);
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(operation));
});

it.each([
  "pending",
  "unknown",
  "failed",
  "ready",
] as const)("ignores legacy browser operation %s and opens a fresh form without fetching or ordering", async (phase) => {
  const key = `hosting-node:user-1:${connector.id}:new`;
  localStorage.setItem(key, JSON.stringify({ input, operationId: operation.id }));
  const get = vi.spyOn(api, "getHostingOperation").mockResolvedValue({ ...operation, phase });
  const create = vi.spyOn(api, "provisionHostingNode");
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Node name" })).not.toHaveValue(input.name);
  expect(screen.queryByText(operation.id)).not.toBeInTheDocument();
  expect(get).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("does not order on selecting a profile or mounting the embedded hosting body", async () => {
  const create = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(api.getHostingCatalog).toHaveBeenCalled());
  expect(screen.getByRole("combobox", { name: "Node Type" })).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
});

it("does not allow creation without provider capability", async () => {
  vi.mocked(api.listHostingConnectors).mockResolvedValue([
    { ...connector, capabilities: { create: false } },
  ]);
  const create = vi.spyOn(api, "provisionHostingNode");
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(api.listHostingConnectors).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});

it("shows DO families and distinguishes same-name sizes by resources, ID and location price", async () => {
  const user = userEvent.setup();
  const sizes = [
    {
      id: "s-1vcpu-1gb",
      name: "Basic",
      cpu: 1,
      memoryMb: 1024,
      diskGb: 25,
      locations: ["ams3"],
      price: { amount: "6", currency: "USD", period: "month" as const, estimated: true },
    },
    {
      id: "s-2vcpu-4gb",
      name: "Basic",
      cpu: 2,
      memoryMb: 4096,
      diskGb: 80,
      locations: ["ams3"],
      locationPrices: {
        ams3: { amount: "24", currency: "USD", period: "month" as const, estimated: true },
      },
    },
    { id: "c-2", name: "CPU-Optimized", cpu: 2, memoryMb: 4096, diskGb: 25, locations: ["ams3"] },
    { id: "other-region", name: "Basic", cpu: 8, memoryMb: 8192, diskGb: 160, locations: ["nyc1"] },
  ];
  vi.mocked(api.getHostingCatalog).mockResolvedValue({ ...catalog, sizes });
  const create = vi.spyOn(api, "provisionHostingNode");
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("combobox", { name: "Plan family" })).toHaveTextContent("Basic");
  await user.click(screen.getByRole("combobox", { name: "Size" }));
  const larger = await screen.findByRole("option", { name: /s-2vcpu-4gb/ });
  expect(larger).toHaveTextContent("2 vCPU · 4 GiB RAM · 80 GB disk · 24 USD / month");
  expect(screen.getByRole("option", { name: /s-1vcpu-1gb/ })).toHaveTextContent(
    "1 vCPU · 1 GiB RAM · 25 GB disk · 6 USD / month"
  );
  expect(screen.queryByRole("option", { name: /c-2|other-region/ })).not.toBeInTheDocument();
  await user.click(larger);
  expect(screen.getByRole("combobox", { name: "Size" })).toHaveTextContent("s-2vcpu-4gb");
  expect(screen.getByText(hostingSizeDescription(sizes[1], "ams3"))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(/Basic · s-2vcpu-4gb · 2 vCPU/)).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(await screen.findByRole("combobox", { name: "Plan family" }));
  await user.click(await screen.findByRole("option", { name: "CPU-Optimized" }));
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Size" }));
  expect(await screen.findByRole("option", { name: /c-2/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /s-2vcpu-4gb/ })).not.toBeInTheDocument();
});

it("chooses per-VM resources instead of connector defaults and allocates IP server-side", async () => {
  vi.mocked(api.listHostingConnectors).mockResolvedValue([
    {
      ...connector,
      provider: "proxmox",
      settings: {
        ...DEFAULT_HOSTING_SETTINGS,
        proxmoxHost: "pve-01",
        proxmox: {
          nodes: ["pve-01"],
          templateId: 9000,
          templateNode: "pve-01",
          storage: "local-lvm",
          bridge: "vmbr0",
          cleanTemplate: true,
          network: "static",
          vmidRange: "250-260",
          ipRange: "192.0.2.100-192.0.2.110",
          defaultCpu: 4,
          defaultMemoryMb: 4096,
          defaultDiskGb: 32,
        },
      },
    },
  ]);
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    locations: [{ id: "pve-01", name: "PVE" }],
    sizes: [{ id: "custom", name: "Custom" }],
    images: [{ id: "9000", name: "Debian", diskGb: 16, supportedRoles: ["docker"] }],
  });
  const create = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByLabelText("vCPU")).toHaveValue(2);
  expect(screen.queryByLabelText("Location")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("vCPU"), { target: { value: "6" } });
  fireEvent.change(screen.getByLabelText("Memory (MiB)"), { target: { value: "8192" } });
  fireEvent.change(screen.getByLabelText("Disk (GiB)"), { target: { value: "40" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.queryByLabelText("Static IP")).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and create VM" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0]).toMatchObject({
    location: "pve-01",
    image: "9000",
    size: "custom",
    cpu: 6,
    memoryMb: 8192,
    diskGb: 40,
  });
  expect(create.mock.calls[0][0].ipAddress).toBeUndefined();
  expect(create.mock.calls[0][0].name).toMatch(/^gateway-/);
});

it("blocks continuation when the selected role has no supported OS image", async () => {
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    ...catalog,
    images: [{ id: "monitoring-only", name: "Monitoring image", supportedRoles: ["monitoring"] }],
  });
  const create = vi.spyOn(api, "provisionHostingNode");
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(api.getHostingCatalog).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});

it.each([
  "digitalocean",
  "hostkey",
  "hetzner",
] as const)("allows Relay on %s and submits its advertised address only after confirmation", async (provider) => {
  const user = userEvent.setup();
  vi.mocked(api.listHostingConnectors).mockResolvedValue([{ ...connector, provider }]);
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    ...catalog,
    images: [{ id: "debian", name: "Debian 12", supportedRoles: ["docker", "relay"] }],
  });
  const create = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  await user.click(screen.getByRole("combobox", { name: "Node Type" }));
  await user.click(screen.getByRole("option", { name: "Relay" }));
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.type(screen.getByPlaceholderText("relay.example.com"), "relay.example.test");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Confirm and create VM" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0]).toMatchObject({
    role: "relay",
    relayAddress: "relay.example.test",
  });
});

it("does not treat missing role metadata in an old catalog as universal support", async () => {
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    ...catalog,
    images: [{ id: "unknown", name: "Unknown Linux" }],
  });
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(api.getHostingCatalog).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("does not offer a GPU image on a CPU-only configuration", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    ...catalog,
    images: [
      ...catalog.images,
      {
        id: "gpu",
        name: "Ubuntu NVIDIA AI/ML",
        supportedRoles: ["docker"],
        compatibleSizes: ["gpu-h100x1-80gb"],
      },
    ],
  });
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(await screen.findByRole("combobox", { name: "Image" }));
  expect(await screen.findByRole("option", { name: "Debian" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /NVIDIA/ })).not.toBeInTheDocument();
});

it("allows reaching configuration before requiring a GPU-compatible size", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getHostingCatalog).mockResolvedValue({
    ...catalog,
    images: [
      {
        id: "gpu",
        name: "Ubuntu NVIDIA AI/ML",
        supportedRoles: ["docker"],
        compatibleSizes: ["gpu-h100x1-80gb"],
      },
    ],
  });
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("combobox", { name: "Size" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("creates an intent on HTTP origins without crypto.randomUUID", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    const create = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
    renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
    await waitFor(() => expect(api.getHostingCatalog).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox", { name: "Node name" }), {
      target: { value: "worker" },
    });
    for (let step = 0; step < 2; step++) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and create VM" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0].idempotencyKey).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
    );
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
    else Reflect.deleteProperty(globalThis.crypto, "randomUUID");
  }
});

it("retries the same HTTP payload only inside the current open form", async () => {
  const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "error");
  const create = vi
    .spyOn(api, "provisionHostingNode")
    .mockRejectedValueOnce(new Error("Network response lost"))
    .mockResolvedValueOnce(operation);
  const close = vi.fn();
  const accepted = vi.fn();
  const view = renderWithRouter(
    <HostingNodeWizard open connectorId={connector.id} onClose={close} onCreated={accepted} />
  );
  fireEvent.click(await review());
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith("Network response lost", { id: "hosting-node-error" })
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(accepted).toHaveBeenCalledWith(operation);
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  expect(localStorage.length).toBe(0);
  view.unmount();
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  expect(screen.queryByText(operation.id)).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledTimes(2);
});

it("does not let a late accepted response close a newly opened form", async () => {
  let resolve!: (value: HostingOperation) => void;
  const create = vi.spyOn(api, "provisionHostingNode").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const close = vi.fn();
  const accepted = vi.fn();
  const view = renderWithRouter(
    <HostingNodeWizard open connectorId={connector.id} onClose={close} onCreated={accepted} />
  );
  fireEvent.click(await review());
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  view.rerender(
    <HostingNodeWizard
      open={false}
      connectorId={connector.id}
      onClose={close}
      onCreated={accepted}
    />
  );
  view.rerender(
    <HostingNodeWizard open connectorId={connector.id} onClose={close} onCreated={accepted} />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  await act(async () => resolve(operation));
  expect(accepted).toHaveBeenCalledWith(operation);
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "Node Type" })).toBeInTheDocument();
});

it("can submit with browser persistence unavailable and no operation result step", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const create = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
  const close = vi.fn();
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={close} />);
  fireEvent.click(await review());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledOnce();
  expect(screen.queryByText("Provisioning")).not.toBeInTheDocument();
  read.mockRestore();
  write.mockRestore();
});

it.each([
  "HOSTING_GATEWAY_PRIVATE",
  "HOSTING_GATEWAY_INVALID",
  "HOSTING_GATEWAY_NOT_READY",
  "HOSTING_IMAGE_UNSUPPORTED",
  "HOSTING_ARCHITECTURE_MISMATCH",
])("unlocks editing after pre-admission rejection %s without showing retry internals", async (code) => {
  const create = vi
    .spyOn(api, "provisionHostingNode")
    .mockRejectedValueOnce(new ApiRequestError("Fix the settings", { status: 400, code }));
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  const submit = await review();
  expect(screen.queryByText("Resume saved request")).not.toBeInTheDocument();
  expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  fireEvent.click(submit);
  await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeEnabled());
  expect(create).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
});

async function review() {
  for (let step = 0; step < 2; step++) {
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }
  return screen.findByRole("button", { name: "Confirm and create VM" });
}

it("validates hostname before leaving the first step and submits a separate friendly name", async () => {
  const create = vi.spyOn(api, "provisionHostingNode").mockResolvedValue(operation);
  renderWithRouter(<HostingNodeWizard open connectorId={connector.id} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Node name" }), {
    target: { value: "Сборочный сервер" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Hostname" }), {
    target: { value: "bad hostname" },
  });
  expect(screen.getByRole("textbox", { name: "Hostname" })).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Hostname" }), {
    target: { value: "build-worker" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getByText("build-worker")).toBeVisible());
  expect(screen.getByText(/Сборочный сервер/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /Confirm and create VM/ }));
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ name: "build-worker", displayName: "Сборочный сервер" })
  );
});
