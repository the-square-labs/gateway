import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useLicensePaywallStore } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { renderWithRouter } from "@/test/render";
import type { DockerInternalRegistryState, Node, SSLCertificate } from "@/types";
import { InternalRegistrySection } from "./InternalRegistrySection";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

const state: DockerInternalRegistryState = {
  status: "ready",
  writable: true,
  storageBackend: "filesystem",
  storageUsedBytes: 1024,
  storageCapacityBytes: null,
  externalAccessEnabled: false,
  externalHostname: null,
  externalNginxNodeId: null,
  externalCertificateId: null,
  maintenancePhase: "idle",
  lastGcAt: null,
  nextGcAt: null,
  lastError: null,
};

const nginxNode = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "nginx-1",
  type: "nginx",
  hostname: "nginx.example.com",
  displayName: "Ingress EU 1",
  appearanceColor: null,
  status: "online",
  serviceCreationLocked: false,
  daemonVersion: "1.0.0",
  osInfo: "linux",
  configVersionHash: null,
  capabilities: {},
  lastSeenAt: new Date("2026-08-24T00:00:00.000Z").toISOString(),
  metadata: {},
  isConnected: true,
  createdAt: new Date("2026-08-24T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-08-24T00:00:00.000Z").toISOString(),
} satisfies Node;

const certificate = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Registry wildcard",
  type: "acme",
  domainNames: ["*.example.com"],
  acmeProvider: "letsencrypt",
  acmeChallengeType: "dns-01",
  acmePendingOperation: null,
  acmePendingChallenges: null,
  internalCertId: null,
  notBefore: "2026-08-01T00:00:00.000Z",
  notAfter: "2026-11-01T00:00:00.000Z",
  autoRenew: true,
  autoRenewProvider: "cloudflare",
  autoRenewDnsBindings: null,
  autoRenewDisabledReason: null,
  autoRenewDisabledAt: null,
  lastRenewedAt: "2026-08-01T00:00:00.000Z",
  renewalError: null,
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies SSLCertificate;

describe("InternalRegistrySection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(useRealtime).mockClear();
    useLicensePaywallStore.setState({ request: null });
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "business", entitlements: { features: ["git-push-to-deploy"] } },
      } as never,
    });
    vi.spyOn(api, "getDockerInternalRegistryState").mockResolvedValue(state);
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [certificate] } as never);
    vi.spyOn(api, "searchDomains").mockResolvedValue([
      {
        id: "domain-1",
        domain: "registry.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: nginxNode.id,
      },
    ]);
  });

  it("moves retention to housekeeping and removes the object storage placeholder", async () => {
    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    expect(screen.queryByText("Retention")).not.toBeInTheDocument();
    expect(screen.queryByText("Object storage")).not.toBeInTheDocument();
    expect(screen.getByText(/managed in Housekeeping/)).toBeInTheDocument();
  });

  it("explains the unhealthy registry badge on hover", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDockerInternalRegistryState).mockResolvedValue({
      ...state,
      status: "unhealthy",
      writable: false,
      lastError: "Registry probe failed",
    });

    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    const unhealthy = await screen.findByText("unhealthy");
    const unhealthyTrigger = unhealthy.closest("button");
    if (!unhealthyTrigger) throw new Error("Unhealthy badge trigger not found");
    await user.hover(unhealthyTrigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Registry probe failed");
  });

  it("explains the read-only registry badge on hover", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDockerInternalRegistryState).mockResolvedValue({
      ...state,
      status: "read_only",
      writable: false,
      lastError: "Storage backend rejected writes",
    });

    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    const readOnlyTrigger = screen
      .getAllByText("Read only")
      .map((element) => element.closest("button"))
      .find((element): element is HTMLButtonElement => element !== null);
    if (!readOnlyTrigger) throw new Error("Read-only badge trigger not found");
    await user.hover(readOnlyTrigger);
    expect(
      await screen.findAllByText("Registry writes are disabled. Storage backend rejected writes")
    ).not.toHaveLength(0);
  });

  it("submits a real certificate id for licensed external exposure", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(api, "updateDockerInternalRegistrySettings").mockResolvedValue({
      ...state,
      externalAccessEnabled: true,
      externalHostname: "registry.example.com",
      externalNginxNodeId: nginxNode.id,
      externalCertificateId: certificate.id,
    });
    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    await user.click(screen.getByRole("button", { name: "External registry access" }));
    const domain = screen.getByPlaceholderText("registry.example.com");
    await user.click(domain);
    await user.click(screen.getByText("registry.example.com"));

    await user.click(screen.getByText("Select Nginx node").closest("button")!);
    await user.click(screen.getByText("Ingress EU 1"));
    await user.click(screen.getByText("Select certificate").closest("button")!);
    await user.click(screen.getByText(/Registry wildcard/));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        externalAccessEnabled: true,
        externalHostname: "registry.example.com",
        externalNginxNodeId: nginxNode.id,
        externalCertificateId: certificate.id,
      })
    );
  });

  it("keeps internal access available but opens the Business paywall when external access is enabled", async () => {
    const user = userEvent.setup();
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "community", entitlements: { features: [] } },
      } as never,
    });
    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    expect(screen.getByText("Business+")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "External registry access" }));

    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "External internal registry access",
      requiredPlan: "business",
    });
    expect(screen.queryByPlaceholderText("registry.example.com")).not.toBeInTheDocument();
  });

  it("hides the Business badge when the current Enterprise plan supports external access", async () => {
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "enterprise", entitlements: { features: ["git-push-to-deploy"] } },
      } as never,
    });

    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    expect(screen.queryByText("Business+")).not.toBeInTheDocument();
  });

  it("discards external draft fields when access is disabled", async () => {
    const user = userEvent.setup();
    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    await user.click(screen.getByRole("button", { name: "External registry access" }));
    await user.type(screen.getByPlaceholderText("registry.example.com"), "draft.example.com");
    await user.click(screen.getByRole("button", { name: "External registry access" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("refreshes runtime state on registry events and reconnect without overwriting an unsaved draft", async () => {
    const user = userEvent.setup();
    const getState = vi.mocked(api.getDockerInternalRegistryState);
    renderWithRouter(<InternalRegistrySection nodesList={[nginxNode]} />);

    await screen.findByText("Local volume");
    await user.click(screen.getByRole("button", { name: "External registry access" }));
    const domain = screen.getByPlaceholderText("registry.example.com");
    await user.type(domain, "draft.example.com");
    getState.mockResolvedValue({ ...state, status: "degraded" });

    const registration = [...vi.mocked(useRealtime).mock.calls]
      .reverse()
      .find(([channel]) => channel === "docker.registry.changed");
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (payload: unknown) => void;
    const options = registration?.[2] as { onReconnect?: () => void };

    await act(async () => handler({ id: "gateway-internal-registry", action: "health" }));
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    expect(domain).toHaveValue("draft.example.com");
    await act(async () => options.onReconnect?.());
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(3));
    expect(domain).toHaveValue("draft.example.com");
  });
});
