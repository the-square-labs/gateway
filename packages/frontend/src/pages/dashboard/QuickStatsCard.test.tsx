import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { hasScopeBase } from "@/lib/scope-utils";
import type { DashboardStats } from "@/types";
import { CertificateExpiryCard } from "./CertificateExpiryCard";
import { QuickStatsCard } from "./QuickStatsCard";

const STATS: DashboardStats = {
  proxyHosts: { total: 2, enabled: 2, online: 2, offline: 0, degraded: 0 },
  sslCertificates: { total: 1, active: 1, expiringSoon: 1, expired: 0 },
  pkiCertificates: { total: 0, active: 0, revoked: 0, expired: 0 },
  cas: { total: 0, active: 0 },
};

// A MyProject user holds folder grants only; the server already scoped the counts to that folder.
const folderScopes = ["proxy:view:folder/f1", "ssl:cert:view:folder/f1"];
const hasScopedAccess = (base: string) => hasScopeBase(folderScopes, base);

describe("dashboard cards for folder-scoped users", () => {
  it("shows the route and certificate stats of the granted folder", () => {
    render(
      <MemoryRouter>
        <QuickStatsCard displayStats={STATS} nodesList={[]} hasScopedAccess={hasScopedAccess} />
      </MemoryRouter>
    );

    expect(screen.getByText("Routes")).toBeInTheDocument();
    expect(screen.getByText("SSL Certificates")).toBeInTheDocument();
    expect(screen.queryByText("Nodes")).not.toBeInTheDocument();
  });

  it("lists expiring certificates of the granted folder", () => {
    render(
      <MemoryRouter>
        <CertificateExpiryCard
          expiringItems={[
            {
              id: "cert-1",
              name: "app.example.com",
              type: "ssl",
              expiresAt: "2026-10-01T00:00:00.000Z",
              daysLeft: 6,
            },
            {
              id: "ca-1",
              name: "Root",
              type: "ca",
              expiresAt: "2026-10-01T00:00:00.000Z",
              daysLeft: 6,
            },
          ]}
          hasScopedAccess={hasScopedAccess}
        />
      </MemoryRouter>
    );

    expect(screen.getByText("app.example.com")).toBeInTheDocument();
    expect(screen.queryByText("Root")).not.toBeInTheDocument();
  });
});
