import { screen, waitFor } from "@testing-library/react";
import { Route } from "react-router-dom";
import { CertificatesPageGuard, DomainsPageGuard, NotificationsPageGuard } from "@/App";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_GATEWAY_FEATURES, useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";

vi.mock("@/pages/Domains", () => ({
  Domains: () => <h1>Domains</h1>,
}));

vi.mock("@/pages/Certificates", () => ({
  Certificates: () => <h1>Certificates</h1>,
}));

describe("NotificationsPageGuard", () => {
  it("redirects a SIEM-only user when SIEM audit export is disabled", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["audit:siem:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.getState().setConfig({
      features: { ...DEFAULT_GATEWAY_FEATURES, siemEnabled: false },
    });

    renderWithRouter(<NotificationsPageGuard />, {
      path: "/notifications/:tab?",
      route: "/notifications/siem",
      extraRoutes: <Route path="/" element={<p>Dashboard home</p>} />,
    });

    await waitFor(() => expect(screen.getByText("Dashboard home")).toBeInTheDocument());
  });
});

describe("DomainsPageGuard", () => {
  it("allows a user with access to an individual domain", () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["domains:view:domain-1"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<DomainsPageGuard />, {
      path: "/domains",
      route: "/domains",
      extraRoutes: <Route path="/" element={<p>Dashboard home</p>} />,
    });

    expect(screen.queryByText("Dashboard home")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Domains" })).toBeInTheDocument();
  });

  it("redirects a user without domain access", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: [] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<DomainsPageGuard />, {
      path: "/domains",
      route: "/domains",
      extraRoutes: <Route path="/" element={<p>Dashboard home</p>} />,
    });

    await waitFor(() => expect(screen.getByText("Dashboard home")).toBeInTheDocument());
  });
});

describe("CertificatesPageGuard", () => {
  it("allows a user with access to an individual PKI certificate", () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["pki:cert:view:certificate-1"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.getState().setConfig({
      features: { ...DEFAULT_GATEWAY_FEATURES, pkiEnabled: true },
    });

    renderWithRouter(<CertificatesPageGuard />, {
      path: "/certificates",
      route: "/certificates",
      extraRoutes: <Route path="/" element={<p>Dashboard home</p>} />,
    });

    expect(screen.queryByText("Dashboard home")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Certificates" })).toBeInTheDocument();
  });
});
