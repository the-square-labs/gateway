import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { HostingFirewallConfig, HostingFirewallView } from "@/types/hosting";
import { NodeFirewallTab } from "./NodeFirewallTab";

const mocks = vi.hoisted(() => ({
  api: {
    getNodeFirewall: vi.fn(),
    updateNodeFirewall: vi.fn(),
  },
  confirm: vi.fn(),
  realtime: {
    handler: null as ((payload: unknown) => void) | null,
    reconnect: null as (() => void) | null,
  },
}));

vi.mock("@/services/api", () => ({ api: mocks.api }));
vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: mocks.confirm }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (
    _channel: string | null,
    handler: (payload: unknown) => void,
    options?: { onReconnect?: () => void }
  ) => {
    mocks.realtime.handler = handler;
    mocks.realtime.reconnect = options?.onReconnect ?? null;
  },
}));

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  setPointerCapture: { configurable: true, value: () => undefined },
  releasePointerCapture: { configurable: true, value: () => undefined },
});

const rule = {
  id: "11111111-1111-4111-8111-111111111111",
  direction: "in" as const,
  action: "allow" as const,
  protocol: "tcp" as const,
  ports: "443",
  addresses: ["0.0.0.0/0"],
  description: "HTTPS",
};

function config(overrides: Partial<HostingFirewallConfig> = {}): HostingFirewallConfig {
  return {
    enabled: false,
    inboundPolicy: "deny",
    outboundPolicy: "allow",
    rules: [rule],
    ...overrides,
  };
}

function view(overrides: Partial<HostingFirewallView> = {}): HostingFirewallView {
  const nextConfig = overrides.config ?? config();
  return {
    resourceId: "resource-1",
    revision: 1,
    config: nextConfig,
    status: "ready",
    observation: {
      fingerprint: "fingerprint-1",
      enabled: nextConfig.enabled,
      matches: true,
      applying: false,
      remoteId: "vm-1",
      blockers: [],
      observedAt: "2026-09-06T00:00:00Z",
    },
    error: null,
    canEdit: true,
    ...overrides,
  };
}

function renderTab() {
  return render(
    <NodeFirewallTab
      nodeId="node-1"
      connectorId="connector-1"
      resourceId="resource-1"
      provider="digitalocean"
    />
  );
}

describe("NodeFirewallTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.realtime.handler = null;
    mocks.realtime.reconnect = null;
    mocks.confirm.mockResolvedValue(true);
    mocks.api.getNodeFirewall.mockResolvedValue(view());
    mocks.api.updateNodeFirewall.mockResolvedValue(view());
    useAuthStore.setState({
      user: makeUser({ id: "user-1", scopes: ["nodes:details", "nodes:config:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
  });
  it("uses Sonner for provider blockers and prevents opening or editing rules", async () => {
    mocks.api.getNodeFirewall.mockResolvedValue(
      view({
        observation: { ...view().observation!, blockers: ["Proxmox token lacks Sys.Audit"] },
      })
    );
    renderTab();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Proxmox token lacks Sys.Audit"),
        expect.anything()
      )
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Provider requirements")).not.toBeInTheDocument();
    for (const name of [
      "Add inbound firewall rule",
      "Add outbound firewall rule",
      "Edit inbound firewall rule",
      "Delete inbound firewall rule",
      "Enable firewall",
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("combobox", { name: "Default inbound policy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeDisabled();
    act(() => mocks.realtime.handler?.({ id: "connector-1" }));
    await waitFor(() => expect(mocks.api.getNodeFirewall).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
  it("allows saving an off policy when only activation is blocked", async () => {
    const initial = view({
      config: config({ enabled: true }),
      observation: {
        ...view().observation!,
        blockers: ["Cluster firewall disabled"],
        disableBlockers: [],
      },
    });
    mocks.api.getNodeFirewall.mockResolvedValue(initial);
    renderTab();
    await screen.findByText("HTTPS");
    expect(screen.getByRole("button", { name: "Delete inbound firewall rule" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));
    expect(mocks.api.updateNodeFirewall).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({
        config: expect.objectContaining({ enabled: false, rules: [rule] }),
      })
    );
  });
  it("keeps ownership blockers when disabling", async () => {
    mocks.api.getNodeFirewall.mockResolvedValue(
      view({
        config: config({ enabled: true }),
        observation: {
          ...view().observation!,
          enabled: true,
          blockers: ["Shared policy"],
          disableBlockers: ["Shared policy"],
        },
      })
    );
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeDisabled();
  });
  it("does not replace realtime Ready with a late PUT Pending response", async () => {
    let resolveSave!: (value: HostingFirewallView) => void;
    mocks.api.updateNodeFirewall.mockImplementation(
      () =>
        new Promise<HostingFirewallView>((resolve) => {
          resolveSave = resolve;
        })
    );
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));
    const ready = view({
      revision: 2,
      config: config({ enabled: true }),
      observation: { ...view().observation!, fingerprint: "applied", enabled: true },
    });
    mocks.api.getNodeFirewall.mockResolvedValue(ready);
    act(() => mocks.realtime.handler?.({ id: "connector-1" }));
    await waitFor(() => expect(mocks.api.getNodeFirewall).toHaveBeenCalledTimes(2));
    // Hold the final canonical read so it cannot hide an incorrect Pending overwrite.
    mocks.api.getNodeFirewall.mockImplementation(() => new Promise(() => {}));
    await act(async () =>
      resolveSave(view({ revision: 2, config: ready.config, status: "pending" }))
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable firewall" })).toBeEnabled();
  });
  it("ignores a pre-mutation GET and lower cached revisions after save acceptance", async () => {
    let resolveRead!: (value: HostingFirewallView) => void;
    renderTab();
    await screen.findByText("HTTPS");
    mocks.api.getNodeFirewall.mockImplementationOnce(
      () =>
        new Promise<HostingFirewallView>((resolve) => {
          resolveRead = resolve;
        })
    );
    act(() => mocks.realtime.handler?.({ id: "connector-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    mocks.api.updateNodeFirewall.mockResolvedValue(
      view({ revision: 2, config: config({ enabled: true }), status: "pending" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));
    await screen.findByText("Pending");
    await act(async () => resolveRead(view({ error: "old read" })));
    expect(screen.queryByText("old read")).not.toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("stages manual enable until Save and confirms the connectivity risk", async () => {
    renderTab();

    const toggle = await screen.findByRole("button", { name: "Enable firewall" });
    await userEvent.click(toggle);
    expect(mocks.api.updateNodeFirewall).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Confirm firewall change",
        description: expect.stringContaining("new connections"),
      })
    );
    await waitFor(() =>
      expect(mocks.api.updateNodeFirewall).toHaveBeenCalledWith("node-1", {
        config: expect.objectContaining({ enabled: true, rules: [rule] }),
        expectedRevision: 1,
        expectedFingerprint: "fingerprint-1",
        acknowledgeConnectivityRisk: true,
      })
    );
  });
  it("reacts to canonical connector id events and retains drafts across provider-only changes", async () => {
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    mocks.api.getNodeFirewall.mockResolvedValue(
      view({ observation: { ...view().observation!, fingerprint: "external-change" } })
    );
    act(() => mocks.realtime.handler?.({ id: "connector-1", provider: "hosting" }));
    await waitFor(() => expect(mocks.api.getNodeFirewall).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("button", { name: "Discard draft and reload" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeDisabled();
  });
  it("does not save after access context changes while confirmation is open", async () => {
    let approve!: (value: boolean) => void;
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        })
    );
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));
    act(() => useAuthStore.setState({ user: makeUser({ id: "user-2", scopes: [] }) }));
    await act(async () => {
      approve(true);
    });
    expect(mocks.api.updateNodeFirewall).not.toHaveBeenCalled();
  });

  it("retains rules when disabling and makes the supported default policies explicit", async () => {
    mocks.api.getNodeFirewall.mockResolvedValue(
      view({ config: config({ enabled: true, outboundPolicy: "deny" }) })
    );
    renderTab();

    expect(await screen.findByText(/TCP, UDP, or ICMP inbound rule/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default inbound policy" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default outbound policy" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Enable firewall" }));
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));

    expect(mocks.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.api.updateNodeFirewall).toHaveBeenCalledWith("node-1", {
        config: expect.objectContaining({ enabled: false, rules: [rule] }),
        expectedRevision: 1,
        expectedFingerprint: "fingerprint-1",
        acknowledgeConnectivityRisk: false,
      })
    );
  });

  it("keeps rule additions local until the firewall configuration is saved", async () => {
    renderTab();
    await screen.findByText("HTTPS");

    await userEvent.click(screen.getByRole("button", { name: "Add inbound firewall rule" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Source addresses" }), "10.0.0.0/8");
    await userEvent.type(screen.getByRole("textbox", { name: "Rule comment" }), "Private network");
    await userEvent.click(screen.getByRole("button", { name: "Save rule" }));

    expect(mocks.api.updateNodeFirewall).not.toHaveBeenCalled();
    expect(screen.getByText("Private network")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));
    await waitFor(() =>
      expect(mocks.api.updateNodeFirewall).toHaveBeenCalledWith(
        "node-1",
        expect.objectContaining({
          config: expect.objectContaining({
            rules: expect.arrayContaining([
              expect.objectContaining({
                addresses: ["10.0.0.0/8"],
                description: "Private network",
              }),
            ]),
          }),
        })
      )
    );
  });
  it("saves from the standard header and marks local changes with the PanelShell dirty border", async () => {
    renderTab();
    await screen.findByText("HTTPS");
    const save = screen.getByRole("button", { name: "Save firewall" });
    const heading = screen.getByRole("heading", { name: "Firewall Ready" });
    const panel = heading.closest(".overflow-hidden")!;
    expect(heading).toContainElement(screen.getByText("Ready"));
    expect(screen.getByText("Ready").parentElement).toHaveClass("h-5");
    expect(screen.getByText("Ready").parentElement?.tagName).toBe("SPAN");
    expect(panel.firstElementChild).toContainElement(save);
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    for (const name of [
      "Save firewall",
      "Add inbound firewall rule",
      "Add outbound firewall rule",
    ]) {
      expect(screen.getByRole("button", { name })).toHaveClass("h-9");
      expect(screen.getByRole("button", { name })).not.toHaveClass("h-8", "text-xs");
    }
    await userEvent.click(screen.getByRole("button", { name: "Delete inbound firewall rule" }));
    expect(panel).toHaveAttribute("style", "border-color: var(--color-warning);");
    expect(save).toBeEnabled();
  });
  it.each([
    "inbound",
    "outbound",
  ])("labels both endpoints and sends invalid %s rule feedback to Sonner", async (direction) => {
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: `Add ${direction} firewall rule` }));
    const addresses = screen.getByRole("textbox", {
      name: direction === "inbound" ? "Source addresses" : "Destination addresses",
    });
    expect(addresses).toHaveAttribute("placeholder", "192.0.2.10, 10.0.0.0/8, 2001:db8::/32");
    expect(
      screen.getByRole("textbox", {
        name: direction === "inbound" ? "Destination VM" : "Source VM",
      })
    ).toHaveValue("This VM");
    expect(screen.getByRole("textbox", { name: "Rule ports" })).toHaveAttribute("placeholder");
    expect(screen.getByRole("textbox", { name: "Rule comment" })).toHaveAttribute("placeholder");
    await userEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(toast.error).toHaveBeenCalledWith("Add at least one address or CIDR.");
    expect(screen.queryByText("Add at least one address or CIDR.")).not.toBeInTheDocument();
    expect(mocks.api.updateNodeFirewall).not.toHaveBeenCalled();
  });
  it("locks an already open rule dialog when provider permissions are revoked", async () => {
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: "Add inbound firewall rule" }));
    mocks.api.getNodeFirewall.mockResolvedValue(
      view({
        observation: {
          ...view().observation!,
          blockers: ["Proxmox token lacks Sys.Modify"],
          disableBlockers: [],
        },
      })
    );
    act(() => mocks.realtime.handler?.({ id: "connector-1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save rule" })).toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Source addresses" })).toBeDisabled();
    expect(mocks.api.updateNodeFirewall).not.toHaveBeenCalled();
  });
  it("does not delete a draft rule after permissions change during confirmation", async () => {
    let approve!: (value: boolean) => void;
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        })
    );
    renderTab();
    await screen.findByText("HTTPS");
    await userEvent.click(screen.getByRole("button", { name: "Delete inbound firewall rule" }));
    mocks.api.getNodeFirewall.mockResolvedValue(view({ canEdit: false }));
    act(() => mocks.realtime.handler?.({ id: "connector-1" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete inbound firewall rule" })).toBeDisabled()
    );
    await act(async () => approve(true));
    expect(screen.getByText("HTTPS")).toBeInTheDocument();
  });

  it("retains the dirty draft when the save request fails", async () => {
    mocks.api.updateNodeFirewall.mockRejectedValue(new Error("firewall save failed"));
    renderTab();

    await userEvent.click(await screen.findByRole("button", { name: "Enable firewall" }));
    await userEvent.click(screen.getByRole("button", { name: "Save firewall" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("firewall save failed", expect.anything())
    );
    expect(screen.queryByText("firewall save failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable firewall" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeEnabled();
  });

  it("blocks stale drafts after a filtered connector snapshot changes the revision", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Enable firewall" }));
    mocks.api.getNodeFirewall.mockResolvedValueOnce(
      view({ revision: 2, observation: { ...view().observation!, fingerprint: "fingerprint-2" } })
    );

    mocks.realtime.handler?.({ connectorId: "other-connector" });
    expect(mocks.api.getNodeFirewall).toHaveBeenCalledTimes(1);
    act(() => mocks.realtime.handler?.({ connectorId: "connector-1" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Remote revision 2 changed"),
        expect.anything()
      )
    );
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    expect(screen.getByRole("button", { name: "Save firewall" })).toBeDisabled();
  });

  it("ignores a late response from the previous auth context", async () => {
    let resolveFirst!: (value: HostingFirewallView) => void;
    const first = new Promise<HostingFirewallView>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.api.getNodeFirewall.mockReset();
    mocks.api.getNodeFirewall.mockImplementationOnce(() => first).mockResolvedValueOnce(view());
    renderTab();

    useAuthStore.setState({
      user: makeUser({ id: "user-2", scopes: ["nodes:details", "nodes:config:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    await waitFor(() => expect(mocks.api.getNodeFirewall).toHaveBeenCalledTimes(2));
    resolveFirst(view({ error: "stale auth snapshot" }));

    await waitFor(() => expect(screen.queryByText("stale auth snapshot")).not.toBeInTheDocument());
    expect(screen.getByText(/Deny rules take priority over Allow/)).toBeInTheDocument();
  });

  it("does not expose a provider refresh button", async () => {
    renderTab();
    await screen.findByText(/Deny rules take priority over Allow/);

    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(mocks.api.getNodeFirewall).toHaveBeenCalledTimes(1);
  });

  it("renders the rule delete action behind the standard confirmation", async () => {
    renderTab();
    await screen.findByText("HTTPS");
    mocks.confirm.mockResolvedValueOnce(true);

    await userEvent.click(screen.getByRole("button", { name: "Delete inbound firewall rule" }));

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Remove firewall rule" })
    );
    expect(screen.queryByText("HTTPS")).not.toBeInTheDocument();
  });
});
