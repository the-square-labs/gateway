import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import {
  DEFAULT_SYSTEM_CONFIG,
  useSystemConfigStore,
  withDefaultSystemConfig,
} from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import type { SystemConfig } from "@/types";
import { Settings } from "./Settings";

vi.mock("@/components/layout/SidebarContent", () => ({
  SidebarContent: () => <aside>Sidebar</aside>,
}));
vi.mock("@/components/ai/AISidePanel", () => ({ AISidePanel: () => null }));
vi.mock("@/components/common/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/common/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/pages/settings/InferenceSettingsSection", () => ({
  InferenceSettingsSection: () => <div>Inference settings ready</div>,
}));

describe("Settings inference bootstrap", () => {
  it("keeps the primary loader until feature config is known and preserves the deep link", async () => {
    const user = makeUser({
      scopes: ["inference:use", "inference:providers:view"],
    });
    useAuthStore.setState({ user, isAuthenticated: true, isLoading: false });
    useSystemConfigStore.setState({
      config: DEFAULT_SYSTEM_CONFIG,
      loaded: false,
      isLoading: false,
    });

    let resolveConfig!: (config: SystemConfig) => void;
    const getSystemConfig = vi.spyOn(api, "getSystemConfig").mockReturnValue(
      new Promise<SystemConfig>((resolve) => {
        resolveConfig = resolve;
      })
    );
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listDatabases").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 200, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listTokens").mockResolvedValue([]);
    vi.spyOn(api, "listOAuthAuthorizations").mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/settings/inference"]}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route
              element={
                <>
                  <Outlet />
                  <LocationProbe />
                </>
              }
            >
              <Route path="/settings/:tab?" element={<Settings />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Inference settings ready")).not.toBeInTheDocument();

    await act(async () => {
      resolveConfig(
        withDefaultSystemConfig({
          ...DEFAULT_SYSTEM_CONFIG,
          features: { ...DEFAULT_SYSTEM_CONFIG.features, inferenceEnabled: true },
        })
      );
    });

    expect(await screen.findByText("Inference settings ready")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/inference");

    getSystemConfig.mockResolvedValue(
      withDefaultSystemConfig({
        ...DEFAULT_SYSTEM_CONFIG,
        features: { ...DEFAULT_SYSTEM_CONFIG.features, inferenceEnabled: false },
      })
    );
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(useSystemConfigStore.getState().config.features.inferenceEnabled).toBe(false);
    });
    expect(getSystemConfig).toHaveBeenCalledTimes(2);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}
