import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { DomainWithUsage } from "@/types";
import { DomainDetailDialog } from "./DomainDetailDialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
    expect(screen.getByText("Proxy Host")).toBeInTheDocument();
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
});
