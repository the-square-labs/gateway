import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
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
      screen.getByRole("heading", { name: "Resolve Cloudflare DNS conflict" })
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

    expect(await screen.findByRole("heading", { name: "Move ingress" })).toBeInTheDocument();
    expect(screen.getByText("Source node")).toBeInTheDocument();
    expect(screen.getByText("Target node")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Target" })).toBeInTheDocument();
    expect(screen.getByText("Route")).toBeInTheDocument();
  });
});
