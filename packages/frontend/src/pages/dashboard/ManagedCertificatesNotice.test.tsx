import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DashboardManagedCertificate } from "@/types";
import { ManagedCertificatesNotice } from "./ManagedCertificatesNotice";

const certificate = (
  overrides: Partial<DashboardManagedCertificate>
): DashboardManagedCertificate => ({
  kind: "storage",
  id: "storage-1",
  slug: "backups",
  name: "Backups",
  reason: "renewal_failed",
  daysRemaining: 20,
  notAfter: "2027-01-01T00:00:00.000Z",
  ...overrides,
});

describe("ManagedCertificatesNotice", () => {
  it("renders nothing when every certificate renews on its own", () => {
    const { container } = render(
      <MemoryRouter>
        <ManagedCertificatesNotice certificates={[]} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each affected resource with a link and the reason", () => {
    render(
      <MemoryRouter>
        <ManagedCertificatesNotice
          certificates={[
            certificate({}),
            certificate({
              kind: "database",
              id: "db-1",
              slug: "orders",
              name: "Orders",
              reason: "expiring",
              daysRemaining: 3,
            }),
          ]}
        />
      </MemoryRouter>
    );
    expect(screen.getByText("2 managed TLS certificates need attention")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Backups" })).toHaveAttribute(
      "href",
      "/storage/backups"
    );
    expect(screen.getByRole("link", { name: "Orders" })).toHaveAttribute(
      "href",
      "/databases/orders"
    );
    expect(screen.getByText(/renewal failed/)).toBeInTheDocument();
    expect(screen.getByText(/expires in 3 days/)).toBeInTheDocument();
  });
});
