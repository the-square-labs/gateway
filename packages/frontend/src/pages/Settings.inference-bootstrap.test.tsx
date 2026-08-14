import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { makeUser } from "@/test/fixtures";
import type { SystemConfig, UIBootstrapShell } from "@/types";
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
vi.mock("@/pages/settings/DockerRegistriesSection", () => ({
  DockerRegistriesSection: ({ nodesList }: { nodesList: unknown[] }) => (
    <div>Registry nodes: {nodesList.length}</div>
  ),
}));
vi.mock("@/pages/settings/AuthProvisioningSection", () => ({
  AuthProvisioningSection: ({ section }: { section: string }) => (
    <div>Gateway configuration: {section}</div>
  ),
}));
vi.mock("@/pages/settings/UpdateSection", () => ({
  UpdateSection: () => <div>About Gateway</div>,
}));
vi.mock("@/pages/settings/LicenseSection", () => ({
  LicenseSection: () => <div>Gateway license</div>,
}));

describe("Settings inference bootstrap", () => {
  it("keeps a stable application skeleton until feature config is known and preserves the deep link", async () => {
    const user = makeUser({
      scopes: ["feat:ai:use", "inference:providers:view"],
    });
    useAuthStore.setState({ user, isAuthenticated: true, isLoading: false });
    useSystemConfigStore.setState({
      config: DEFAULT_SYSTEM_CONFIG,
      loaded: false,
      isLoading: false,
    });

    useUIBootstrapStore.getState().clear();
    let resolveShell!: (shell: UIBootstrapShell) => void;
    const getUIBootstrap = vi.spyOn(api, "getUIBootstrap").mockReturnValue(
      new Promise<UIBootstrapShell>((resolve) => {
        resolveShell = resolve;
      })
    );
    const getInferenceSelfUsage = vi.spyOn(api, "getInferenceSelfUsage");
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

    expect(screen.getByLabelText("Loading application")).toBeInTheDocument();
    expect(screen.queryByText("Inference settings ready")).not.toBeInTheDocument();
    expect(getInferenceSelfUsage).not.toHaveBeenCalled();

    await act(async () => {
      resolveShell(makeShell(true));
    });

    expect(await screen.findByText("Inference settings ready")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/inference");
    expect(getInferenceSelfUsage).not.toHaveBeenCalled();

    getUIBootstrap.mockResolvedValue(makeShell(false));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(useSystemConfigStore.getState().config.features.inferenceEnabled).toBe(false);
    });
    expect(getUIBootstrap).toHaveBeenCalledTimes(2);
  });

  it("reuses the shell node projection for a settings tab instead of refetching nodes", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:registries:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.setState({
      config: DEFAULT_SYSTEM_CONFIG,
      loaded: true,
      isLoading: false,
    });
    useUIBootstrapStore.setState({ snapshot: makeShell(false) });
    const listNodes = vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });

    render(
      <MemoryRouter initialEntries={["/settings/advanced"]}>
        <Routes>
          <Route path="/settings/:tab?" element={<Settings />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Registry nodes: 0")).toBeInTheDocument();
    expect(listNodes).not.toHaveBeenCalled();
  });

  it("redirects the legacy Gateway settings URL to General", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["settings:gateway:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.setState({
      config: DEFAULT_SYSTEM_CONFIG,
      loaded: true,
      isLoading: false,
    });
    useUIBootstrapStore.setState({ snapshot: makeShell(false) });

    render(
      <MemoryRouter initialEntries={["/settings/gateway"]}>
        <Routes>
          <Route
            path="/settings/:tab?"
            element={
              <>
                <Settings />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Gateway configuration: general")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/general");
  });

  it("separates General settings from Advanced configuration", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "settings:gateway:view",
          "settings:gateway:edit",
          "docker:registries:view",
          "admin:update",
          "license:view",
          "license:manage",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.setState({
      config: DEFAULT_SYSTEM_CONFIG,
      loaded: true,
      isLoading: false,
    });
    useUIBootstrapStore.setState({ snapshot: makeShell(false) });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/settings/general"]}>
        <Routes>
          <Route
            path="/settings/:tab?"
            element={
              <>
                <Settings />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Gateway configuration: general")).toBeInTheDocument();
    expect(screen.getByText("About Gateway")).toBeInTheDocument();
    expect(screen.getByText("Gateway license")).toBeInTheDocument();
    expect(screen.getByText(/Powered by/).closest('[role="tabpanel"]')).toHaveAttribute(
      "data-state",
      "active"
    );
    expect(screen.queryByText("Gateway configuration: advanced")).not.toBeInTheDocument();
    expect(screen.queryByText(/Registry nodes:/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Advanced" }));

    expect(await screen.findByText("Gateway configuration: advanced")).toBeInTheDocument();
    expect(screen.getByText("Registry nodes: 0")).toBeInTheDocument();
    expect(screen.queryByText("About Gateway")).not.toBeInTheDocument();
    expect(screen.queryByText("Gateway license")).not.toBeInTheDocument();
    expect(screen.getByText(/Powered by/).closest('[role="tabpanel"]')).toHaveAttribute(
      "data-state",
      "active"
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/advanced");
  });
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function makeShell(inferenceEnabled: boolean): UIBootstrapShell {
  const config: SystemConfig = withDefaultSystemConfig({
    ...DEFAULT_SYSTEM_CONFIG,
    features: { ...DEFAULT_SYSTEM_CONFIG.features, inferenceEnabled },
  });
  return {
    access: { fingerprint: "test", scopes: [] },
    systemConfig: config,
    navigation: {
      hasNginxNodes: true,
      hasCloudflareIntegration: false,
      statusPageEnabled: false,
      dockerNodes: [],
      nodes: {
        data: [],
        revision: 1,
        observedAt: null,
        lastAttemptAt: null,
        lastError: null,
        refreshStatus: "success",
        availability: "available",
      },
    },
    update: null,
    aiStatus: null,
    aiWorkspace: { configured: false, installationOwner: false },
  };
}
