import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "Page actions" }));
    expect(
      await screen.findByRole("menuitem", { name: /Revoke certificate/i })
    ).toBeInTheDocument();
  });

  it("keeps every certificate export available in the overflow menu", async () => {
    const user = userEvent.setup();
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const width = this.hasAttribute("data-header-overflow-measure")
          ? 40
          : this.hasAttribute("data-header-action-item")
            ? 120
            : 1_200;
        return {
          width,
          height: 0,
          top: 0,
          right: width,
          bottom: 0,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    vi.spyOn(api, "getCertificate").mockResolvedValue(
      makeCertificate({ id: "cert-export", isSystem: false })
    );

    useAuthStore.setState({
      user: makeUser({ scopes: ["pki:cert:view", "pki:cert:export"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<CertificateDetail />, {
      path: "/certificates/:id",
      route: "/certificates/cert-export",
      extraRoutes: <Route path="/certificates" element={<div>Certificates</div>} />,
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "gateway-grpc" })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Page actions" }));

    for (const label of [
      "Download PEM bundle (ZIP)",
      "Download certificate as PEM",
      "Download certificate as DER",
      "Download intermediate CA chain",
      "Download full chain as PEM",
      "Download private key as PEM",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Download PKCS#12" }));
    expect(await screen.findByRole("heading", { name: "Export PKCS#12" })).toBeInTheDocument();
    rectSpy.mockRestore();
  });
});
