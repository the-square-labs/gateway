import { screen, waitFor } from "@testing-library/react";
import { Route } from "react-router-dom";
import { NotificationsPageGuard } from "@/App";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_GATEWAY_FEATURES, useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";

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
