import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { DomainWithUsage } from "@/types";
import { DomainDetailDialog } from "./DomainDetailDialog";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

const domain: DomainWithUsage = {
  id: "domain-1",
  domain: "app.example.com",
  description: null,
  dnsStatus: "valid",
  lastDnsCheckAt: "2026-08-13T12:00:00.000Z",
  dnsRecords: {
    a: ["104.16.1.1", "104.16.2.1"],
    aaaa: [],
    cname: [],
    caa: [],
    mx: [],
    txt: [["verification=value"]],
  },
  dnsProvider: "cloudflare",
  dnsOwnership: "created",
  integrationConnectorId: "connector-1",
  providerZoneId: "zone-1",
  providerZoneName: "example.com",
  providerRecordIds: ["record-1"],
  dnsRecordType: "A",
  dnsTargetIps: ["8.8.8.8"],
  dnsTtl: 1,
  dnsProxied: true,
  cloudflareMigrationStatus: null,
  cloudflareMigrationCheckedAt: null,
  nginxNodeId: "node-1",
  nginxNode: {
    id: "node-1",
    slug: "edge-1",
    hostname: "edge-1",
    displayName: "Edge 1",
    appearanceColor: null,
    effectiveAddress: "8.8.8.8",
  },
  createdById: "user-1",
  createdAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-13T12:00:00.000Z",
  usage: {
    proxyHosts: [
      {
        id: "proxy-1",
        slug: "app-example-com",
        domainNames: ["app.example.com"],
        enabled: true,
        nodeId: "node-1",
      },
    ],
    sslCertificates: [
      {
        id: "certificate-1",
        domainNames: ["app.example.com"],
        status: "active",
        notAfter: "2026-11-13T12:00:00.000Z",
      },
    ],
  },
};

describe("DomainDetailDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(useRealtime).mockReset();
    // Editors' dialogs check DNS on open; unless a test cares, that check stays in flight.
    vi.spyOn(api, "checkDomainDns").mockReturnValue(new Promise(() => {}));
  });

  it("keeps the details hidden until they arrive to avoid resizing the dialog", () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <DomainDetailDialog
          domainId={domain.id}
          listDomain={domain}
          open
          onOpenChange={vi.fn()}
          onUpdated={vi.fn()}
        />
      </MemoryRouter>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveAttribute("data-reveal-phase", "revealed");
    expect(screen.getByRole("heading", { name: "app.example.com" })).toBeInTheDocument();
    expect(screen.queryByText("DNS Management")).not.toBeInTheDocument();
  });

  it("uses shared DNS rows, Cloudflare target rows, and Type/Target usage columns", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue(domain);

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "app.example.com" })).toBeInTheDocument();
    expect(screen.getByText("104.16.1.1, 104.16.2.1")).toBeInTheDocument();
    expect(screen.getByText("verification=value")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Target")).toBeInTheDocument();
    expect(screen.getByText("Edge 1")).toBeInTheDocument();
    expect(screen.getByText("8.8.8.8")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Target" })).toBeInTheDocument();
    expect(screen.getByText("Route")).toBeInTheDocument();
    expect(screen.getByText("SSL Certificate")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-xl");
    // Record values use the plain row value style; the dialog checks DNS by itself.
    expect(screen.getByText("104.16.1.1, 104.16.2.1")).toHaveClass("text-sm");
    expect(screen.getByText("104.16.1.1, 104.16.2.1")).not.toHaveClass("font-mono");
    expect(screen.queryByRole("button", { name: "Check" })).not.toBeInTheDocument();
  });

  it("omits Cloudflare Target when the domain is not proxied", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue({ ...domain, dnsProxied: false });

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "app.example.com" })).toBeInTheDocument();
    expect(screen.queryByText("Cloudflare Target")).not.toBeInTheDocument();
  });

  it("keeps a completed DNS check when an older realtime refresh resolves later", async () => {
    let resolveStaleLoad!: (value: DomainWithUsage) => void;
    const staleLoad = new Promise<DomainWithUsage>((resolve) => {
      resolveStaleLoad = resolve;
    });
    let resolveCheck!: (value: DomainWithUsage) => void;
    const check = new Promise<DomainWithUsage>((resolve) => {
      resolveCheck = resolve;
    });
    let domainChanged: ((payload: unknown) => void) | undefined;
    vi.mocked(useRealtime).mockImplementation((channel, handler) => {
      if (channel === "domain.changed") domainChanged = handler;
    });
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view", "domains:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    const emptyRecords: DomainWithUsage = {
      ...domain,
      dnsStatus: "pending",
      dnsProxied: false,
      dnsRecords: { a: [], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    };
    const checkedDomain: DomainWithUsage = {
      ...emptyRecords,
      dnsRecords: { ...emptyRecords.dnsRecords!, a: ["8.8.8.8"] },
    };
    vi.spyOn(api, "getDomain").mockResolvedValueOnce(emptyRecords).mockReturnValueOnce(staleLoad);
    vi.spyOn(api, "checkDomainDns").mockReturnValue(check);

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByText("No DNS records found")).toHaveClass("text-sm");
    expect(screen.getByRole("status")).toHaveTextContent("Checking…");
    act(() => domainChanged?.({ id: domain.id, action: "updated" }));
    await waitFor(() => expect(api.getDomain).toHaveBeenCalledTimes(2));

    await act(async () => resolveCheck(checkedDomain));
    expect(await screen.findByText("8.8.8.8")).toBeInTheDocument();

    await act(async () => resolveStaleLoad(emptyRecords));
    expect(screen.getByText("8.8.8.8")).toBeInTheDocument();
    expect(screen.queryByText("No DNS records found")).not.toBeInTheDocument();
  });

  it("checks DNS once per opening, read-only, and only for editors", async () => {
    const onUpdated = vi.fn();
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view", "domains:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue(domain);
    const checkDomainDns = vi.spyOn(api, "checkDomainDns").mockResolvedValue(domain);

    const { rerender } = render(
      <MemoryRouter>
        <DomainDetailDialog
          domainId={domain.id}
          open
          onOpenChange={vi.fn()}
          onUpdated={onUpdated}
        />
      </MemoryRouter>
    );

    await waitFor(() => expect(checkDomainDns).toHaveBeenCalledWith(domain.id, { repair: false }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(checkDomainDns).toHaveBeenCalledTimes(1);

    // Viewers see the last stored result; the check itself needs domains:edit.
    checkDomainDns.mockClear();
    useAuthStore.setState({ user: makeUser({ scopes: ["domains:view"] }) });
    rerender(
      <MemoryRouter>
        <DomainDetailDialog
          domainId={domain.id}
          open={false}
          onOpenChange={vi.fn()}
          onUpdated={onUpdated}
        />
      </MemoryRouter>
    );
    rerender(
      <MemoryRouter>
        <DomainDetailDialog
          domainId={domain.id}
          open
          onOpenChange={vi.fn()}
          onUpdated={onUpdated}
        />
      </MemoryRouter>
    );
    expect(await screen.findByText("104.16.1.1, 104.16.2.1")).toBeInTheDocument();
    expect(checkDomainDns).not.toHaveBeenCalled();
  });

  it("reuses a check from the last minute instead of probing again", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view", "domains:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue({
      ...domain,
      lastDnsCheckAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const checkDomainDns = vi.spyOn(api, "checkDomainDns").mockResolvedValue(domain);

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByText("104.16.1.1, 104.16.2.1")).toBeInTheDocument();
    expect(checkDomainDns).not.toHaveBeenCalled();
  });

  it("shows Cloudflare migration state as a shared detail row for external DNS", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue({
      ...domain,
      dnsProvider: "legacy",
      dnsOwnership: "legacy",
      integrationConnectorId: null,
      cloudflareMigrationStatus: "error",
      cloudflareMigrationCheckedAt: "2026-08-15T12:00:00.000Z",
    });

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByText("Cloudflare migration")).toBeInTheDocument();
    expect(screen.getByText("Migration failed")).toBeInTheDocument();
  });

  it("opens the shared conflict resolution flow with current and required DNS targets", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view", "domains:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue({
      ...domain,
      dnsProvider: "legacy",
      dnsOwnership: "legacy",
      integrationConnectorId: null,
      cloudflareMigrationStatus: "dns_conflict",
      dnsTargetIps: ["104.16.1.1"],
    });
    vi.spyOn(api, "listDomainNginxNodes").mockResolvedValue({
      eligibleNodes: [
        {
          id: "node-1",
          slug: "edge-1",
          hostname: "edge-1",
          displayName: "Edge 1",
          appearanceColor: null,
          effectiveAddress: "8.8.8.8",
        },
      ],
      unconfiguredNodes: [],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 0,
    });

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    const resolveButton = await screen.findByRole("button", { name: "Resolve conflict" });
    expect(resolveButton).toHaveClass("h-auto", "p-0", "text-[color:var(--color-link)]");
    await user.click(resolveButton);

    expect(
      screen.getByRole("heading", { name: "Resolve Cloudflare DNS Conflict" })
    ).toBeInTheDocument();
    expect(screen.getByText("Current DNS")).toBeInTheDocument();
    expect(screen.getByText("104.16.1.1, 104.16.2.1")).toBeInTheDocument();
    expect(screen.getByText("Required target")).toBeInTheDocument();
    expect(screen.getByText("8.8.8.8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass(
      "h-auto",
      "p-0",
      "text-[color:var(--color-link)]"
    );
    expect(screen.getByRole("button", { name: "Update DNS and migrate" })).toBeEnabled();
  });

  it("does not render footer actions", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view", "domains:edit", "ssl:cert:issue"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue({
      ...domain,
      dnsProxied: false,
      usage: { proxyHosts: [], sslCertificates: [] },
    });

    render(
      <MemoryRouter>
        <DomainDetailDialog domainId={domain.id} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "app.example.com" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Issue Let's Encrypt Certificate" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move ingress" })).not.toBeInTheDocument();
  });

  it("opens ingress migration with the shared routing rows and impact table", async () => {
    const sourceNode = {
      id: "node-1",
      slug: "edge-1",
      hostname: "edge-1",
      displayName: "Edge 1",
      appearanceColor: null,
      effectiveAddress: "8.8.8.8",
    };
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view", "domains:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getDomain").mockResolvedValue(domain);
    vi.spyOn(api, "listDomainNginxNodes").mockResolvedValue({
      eligibleNodes: [
        sourceNode,
        {
          id: "node-2",
          slug: "edge-2",
          hostname: "edge-2",
          displayName: "Edge 2",
          appearanceColor: null,
          effectiveAddress: "1.1.1.1",
        },
      ],
      unconfiguredNodes: [],
      totalNginxNodes: 2,
      unconfiguredNginxNodes: 0,
    });
    vi.spyOn(api, "previewDomainIngressMigration").mockResolvedValue({
      status: "ready",
      sourceNode,
      targetNode: {
        id: "node-2",
        slug: "edge-2",
        hostname: "edge-2",
        displayName: "Edge 2",
        appearanceColor: null,
        effectiveAddress: "1.1.1.1",
      },
      domains: [
        { id: domain.id, domain: domain.domain, dnsProvider: "cloudflare", dnsStatus: "valid" },
      ],
      proxyHosts: [
        { id: "proxy-1", slug: "app-example-com", domainNames: [domain.domain], enabled: true },
      ],
      targetIps: ["1.1.1.1"],
      requiresExternalDnsBeforeMove: false,
    });

    render(
      <MemoryRouter>
        <DomainDetailDialog
          domainId={domain.id}
          open
          initialView="ingress-migration"
          onOpenChange={vi.fn()}
          onUpdated={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Move Ingress" })).toBeInTheDocument();
    expect(screen.getByText("Source node")).toBeInTheDocument();
    expect(screen.getByText("Target node")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Target" })).toBeInTheDocument();
    expect(screen.getByText("Route")).toBeInTheDocument();
  });
});
