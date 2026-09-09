import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { makeNode } from "@/test/fixtures";
import type { CA, ProxyHost } from "@/types";
import { CertificateAuthoritiesCard } from "./CertificateAuthoritiesCard";
import { HealthOverviewCard } from "./HealthOverviewCard";
import { NodesCard } from "./NodesCard";

it("uses the standard accent hover on all three dashboard resource lists", () => {
  render(
    <MemoryRouter>
      <HealthOverviewCard
        hasScope={() => true}
        healthHosts={[
          {
            id: "proxy",
            slug: "proxy",
            domainNames: ["example.test"],
            healthStatus: "online",
            forwardHost: "localhost",
            forwardPort: 8080,
            forwardScheme: "http",
          } as ProxyHost,
        ]}
      />
      <NodesCard hasScope={() => true} nodesList={[makeNode()]} />
      <CertificateAuthoritiesCard
        hasScope={() => true}
        cas={[
          {
            id: "ca",
            commonName: "Test CA",
            status: "active",
            type: "root",
            keyAlgorithm: "rsa-2048",
          } as CA,
        ]}
      />
    </MemoryRouter>
  );
  for (const name of [/example.test/, /Edge 1/, /Test CA/]) {
    const row = screen.getByRole("link", { name });
    expect(row).toHaveClass("hover:bg-accent", "transition-colors");
    expect(row).not.toHaveClass("hover:bg-muted/50");
  }
});
