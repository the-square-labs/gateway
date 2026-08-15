import { screen } from "@testing-library/react";
import { Route } from "react-router-dom";
import { vi } from "vitest";
import { CertificateDetail } from "@/pages/CertificateDetail";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeCertificate, makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

describe("CertificateDetail", () => {
  it("shows the system badge and hides revoke for system certificates", async () => {
    vi.spyOn(api, "getCertificate").mockResolvedValue(
      makeCertificate({ id: "cert-system", isSystem: true })
    );

    useAuthStore.setState({
      user: makeUser({ scopes: ["pki:cert:view", "pki:cert:revoke"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<CertificateDetail />, {
      path: "/certificates/:id",
      route: "/certificates/cert-system",
      extraRoutes: <Route path="/certificates" element={<div>Certificates</div>} />,
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "gateway-grpc" })
    ).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Revoke Certificate" })).not.toBeInTheDocument();
  });

  it("shows revoke for normal active certificates when the user has scope", async () => {
    vi.spyOn(api, "getCertificate").mockResolvedValue(
      makeCertificate({ id: "cert-user", isSystem: false })
    );

    useAuthStore.setState({
      user: makeUser({ scopes: ["pki:cert:view", "pki:cert:revoke"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<CertificateDetail />, {
      path: "/certificates/:id",
      route: "/certificates/cert-user",
      extraRoutes: <Route path="/certificates" element={<div>Certificates</div>} />,
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "gateway-grpc" })
    ).toBeInTheDocument();

    expect(await screen.findByRole("button", { name: "Revoke Certificate" })).toBeInTheDocument();
  });
});
