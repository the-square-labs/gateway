import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { useLicensePaywallStore } from "@/stores/license-paywall";
import { LicenseUpgradeDialog } from "./LicenseUpgradeDialog";

const USER = {
  id: "user-1",
  oidcSubject: "oidc-user",
  email: "admin@example.com",
  name: "Admin",
  avatarUrl: null,
  groupId: "group-1",
  groupName: "admin",
  scopes: ["license:manage"],
  isBlocked: false,
};

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}:${JSON.stringify(location.state)}`}</output>;
}

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={["/docker"]}>
      <LicenseUpgradeDialog />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  useLicensePaywallStore.setState({ request: null });
  useAuthStore.setState({ user: null, isAuthenticated: false });
});

describe("LicenseUpgradeDialog", () => {
  it("reuses the settings navigation target for license managers", () => {
    useAuthStore.setState({ user: USER as never, isAuthenticated: true });
    useLicensePaywallStore.getState().open({
      capability: "Secure Runtime",
      requiredPlan: "business",
      currentPlan: "personal",
    });

    renderDialog();
    expect(screen.getByRole("heading", { name: "Business plan required" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade license key" }));

    expect(screen.getByText(/\/settings\/general.*gateway-license/)).toBeInTheDocument();
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("shows administrator guidance without an upgrade CTA for other users", () => {
    useAuthStore.setState({
      user: { ...USER, scopes: [] } as never,
      isAuthenticated: true,
    });
    useLicensePaywallStore.getState().open({
      capability: "Internal PKI",
      requiredPlan: "enterprise",
      currentPlan: "community",
    });

    renderDialog();

    expect(
      screen.getByText("Contact your administrator to upgrade the Gateway license.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade license key" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
  });
});
