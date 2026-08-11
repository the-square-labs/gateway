import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router-dom";
import { vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { ProxyHostDetail } from "@/pages/ProxyHostDetail";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { ProxyHost } from "@/types";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("@/components/common/ConfirmDialog", () => ({
  confirm: vi.fn(),
}));

vi.mock("./proxy-detail/SettingsTab", () => ({
  SettingsTab: ({
    accessListId,
    onAccessListChange,
    healthCheckExpectedStatus,
    setHealthCheckExpectedStatus,
  }: {
    accessListId: string;
    onAccessListChange: (value: string) => void;
    healthCheckExpectedStatus: number | null;
    setHealthCheckExpectedStatus: (value: number | null) => void;
  }) => (
    <div>
      <div data-testid="access-list-value">{accessListId || "__none__"}</div>
      <button type="button" onClick={() => onAccessListChange("")}>
        Clear access list
      </button>
      <input
        aria-label="Expected status"
        value={healthCheckExpectedStatus ?? ""}
        onChange={(event) =>
          setHealthCheckExpectedStatus(event.target.value ? Number(event.target.value) : null)
        }
      />
    </div>
  ),
}));

vi.mock("@/components/proxy/CreateProxyHostDialog", () => ({
  CreateProxyHostDialog: ({
    open,
    existingHost,
    onSuccess,
  }: {
    open: boolean;
    existingHost: ProxyHost;
    onSuccess?: (hostId: string, host?: ProxyHost) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSuccess?.(existingHost.id, {
            ...existingHost,
            slug: "renamed-example-com",
            domainNames: ["renamed.example.com"],
          })
        }
      >
        Mock save renamed proxy host
      </button>
    ) : null,
}));

vi.mock("./proxy-detail/AdvancedTab", () => ({
  AdvancedTab: ({
    advancedConfig,
    setAdvancedConfig,
    onSaveAdvanced,
  }: {
    advancedConfig: string;
    setAdvancedConfig: (value: string) => void;
    onSaveAdvanced: () => void;
  }) => (
    <div>
      <textarea
        aria-label="Advanced config"
        value={advancedConfig}
        onChange={(event) => setAdvancedConfig(event.target.value)}
      />
      <button type="button" onClick={onSaveAdvanced}>
        Save advanced
      </button>
    </div>
  ),
}));

vi.mock("./proxy-detail/DetailsTab", () => ({
  DetailsTab: () => <div>Details tab</div>,
}));

vi.mock("./proxy-detail/LogsTab", () => ({
  LogsTab: () => <div>Logs tab</div>,
}));

vi.mock("./proxy-detail/RawConfigTab", () => ({
  RawConfigTab: ({ renderedConfig }: { renderedConfig: string }) => (
    <div>Raw config tab {renderedConfig}</div>
  ),
}));

function makeProxyHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "host-1",
    slug: "example.test",
    type: "proxy",
    enabled: true,
    maintenanceEnabled: false,
    maintenanceStartedAt: null,
    domainNames: ["example.com"],
    forwardHost: "backend",
    forwardPort: 8080,
    forwardScheme: "http",
    websocketSupport: false,
    sslEnabled: false,
    sslForced: false,
    sslCertificateId: null,
    internalCertificateId: null,
    forceHttps: false,
    http2Support: false,
    hstsEnabled: false,
    hstsSubdomains: false,
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitOptions: null,
    customHeaders: [],
    customRewrites: [],
    advancedConfig: "set $foo bar;",
    rawConfig: "",
    rawConfigEnabled: false,
    accessListId: "acl-1",
    folderId: null,
    sortOrder: 0,
    healthCheckEnabled: false,
    healthHistory: [],
    healthCheckUrl: "/",
    healthCheckInterval: 60,
    healthCheckExpectedStatus: null,
    healthCheckExpectedBody: "",
    healthCheckBodyMatchMode: "includes",
    healthCheckSlowThreshold: 3,
    healthStatus: "unknown",
    lastHealthCheckAt: null,
    nginxTemplateId: null,
    templateVariables: {},
    redirectUrl: null,
    redirectStatusCode: 301,
    isSystem: false,
    createdById: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ProxyHost;
}

describe("ProxyHostDetail", () => {
  beforeEach(() => {
    vi.mocked(confirm).mockReset();
    vi.spyOn(api, "getProxyHostHealthHistory").mockResolvedValue([]);
    vi.spyOn(api, "listAccessLists").mockResolvedValue({
      data: [
        {
          id: "acl-1",
          name: "Office ACL",
          description: null,
          ipRules: [],
          basicAuthEnabled: false,
          basicAuthUsers: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
    useAuthStore.setState({
      user: makeUser({
        scopes: ["proxy:edit", "proxy:advanced:host-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("clears the access list with an explicit null and keeps the resynced none state", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());
    vi.spyOn(api, "updateProxyHost").mockResolvedValue(
      makeProxyHost({
        accessListId: null,
      })
    );

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/settings",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect(await screen.findByTestId("access-list-value")).toHaveTextContent("acl-1");

    fireEvent.click(screen.getByRole("button", { name: "Clear access list" }));

    await waitFor(() => {
      expect(api.updateProxyHost).toHaveBeenCalledWith("host-1", {
        accessListId: null,
      });
    });
    expect(screen.getByTestId("access-list-value")).toHaveTextContent("__none__");
  });

  it("does not update settings when the user cannot edit the proxy host", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["proxy:view:host-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());
    const updateSpy = vi.spyOn(api, "updateProxyHost").mockResolvedValue(makeProxyHost());

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/settings",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect(await screen.findByTestId("access-list-value")).toHaveTextContent("acl-1");
    fireEvent.click(screen.getByRole("button", { name: "Clear access list" }));

    await waitFor(() => {
      expect(updateSpy).not.toHaveBeenCalled();
    });
    expect(screen.getByTestId("access-list-value")).toHaveTextContent("acl-1");
  });

  it("clears advanced config with an explicit null and keeps the editor empty after resync", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());
    vi.spyOn(api, "updateProxyHost").mockResolvedValue(
      makeProxyHost({
        advancedConfig: null,
      })
    );

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/advanced",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    const textarea = (await screen.findByLabelText("Advanced config")) as HTMLTextAreaElement;
    expect(textarea.value).toBe("set $foo bar;");

    fireEvent.change(textarea, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save advanced" }));

    await waitFor(() => {
      expect(api.updateProxyHost).toHaveBeenCalledWith("host-1", {
        advancedConfig: null,
      });
    });
    expect(textarea.value).toBe("");
  });

  it("clears health check expected status with an explicit null", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(
      makeProxyHost({
        healthCheckEnabled: true,
        healthCheckExpectedStatus: 204,
      })
    );
    vi.spyOn(api, "updateProxyHost").mockResolvedValue(
      makeProxyHost({
        healthCheckEnabled: true,
        healthCheckExpectedStatus: null,
      })
    );

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/settings",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    const input = (await screen.findByLabelText("Expected status")) as HTMLInputElement;
    expect(input.value).toBe("204");

    fireEvent.change(input, { target: { value: "" } });

    await waitFor(() => {
      expect(api.updateProxyHost).toHaveBeenCalledWith(
        "host-1",
        expect.objectContaining({
          healthCheckExpectedStatus: null,
        })
      );
    });
    expect(input.value).toBe("");
  });

  it("keeps proxy host detail mounted after editing domains", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());

    renderWithRouter(
      <ProxyHostDetail resolvedProxyHostId="host-1" resolvedProxySlug="example.test" />,
      {
        path: "/proxy-hosts/:proxySlug/:tab",
        route: "/proxy-hosts/example.test/details",
        extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
      }
    );

    expect(await screen.findByRole("heading", { name: "example.com" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock save renamed proxy host" }));

    expect(await screen.findByRole("heading", { name: "renamed.example.com" })).toBeInTheDocument();
    expect(screen.queryByText("Proxy Hosts")).not.toBeInTheDocument();
  });

  it("loads rendered config when reloading directly on the raw tab", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["proxy:raw:read:host-1"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());
    vi.spyOn(api, "getRenderedProxyConfig").mockResolvedValue({
      rendered: "server { listen 80; }",
    });

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/raw",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect(await screen.findByText(/Raw config tab server/)).toBeInTheDocument();
    expect(api.getRenderedProxyConfig).toHaveBeenCalledWith("host-1");
  });

  it("vertically centers the shared back button in the detail header", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/details",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    const backButton = await screen.findByRole("button", { name: "Back" });
    expect(backButton.parentElement).toHaveClass("items-center");
    expect(backButton.parentElement).not.toHaveClass("items-start");
  });

  it("shows the Secure Link badge only after cutover is active", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(
      makeProxyHost({
        upstreamKind: "docker_container",
        dockerContainerName: "application",
        secureLinkActive: true,
      })
    );

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/details",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect(await screen.findByText("application")).toBeInTheDocument();
    expect(screen.getByText("Secure Link")).toBeInTheDocument();
  });

  it("does not show the Secure Link badge before cutover is active", async () => {
    vi.spyOn(api, "getProxyHost").mockResolvedValue(
      makeProxyHost({
        upstreamKind: "docker_container",
        dockerContainerName: "application",
        secureLinkActive: false,
      })
    );

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/details",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect(await screen.findByText("application")).toBeInTheDocument();
    expect(screen.queryByText("Secure Link")).not.toBeInTheDocument();
  });

  it("shows maintenance as the primary state with a disable action in the overflow menu", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getProxyHost").mockResolvedValue(
      makeProxyHost({ maintenanceEnabled: true, maintenanceStartedAt: new Date().toISOString() })
    );

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/details",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect((await screen.findAllByText("Maintenance")).length).toBeGreaterThan(0);
    expect(screen.getByText(/User requests receive HTTP 503/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More proxy host actions" }));
    expect(
      await screen.findByRole("menuitem", { name: /Disable Maintenance/ })
    ).toBeInTheDocument();
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("uses the standard confirmation before enabling maintenance", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());
    vi.mocked(confirm).mockResolvedValue(true);
    const toggle = vi
      .spyOn(api, "toggleProxyMaintenance")
      .mockResolvedValue(makeProxyHost({ maintenanceEnabled: true }));

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/details",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    await user.click(await screen.findByRole("button", { name: "More proxy host actions" }));
    const action = await screen.findByRole("menuitem", { name: /Enable Maintenance/ });
    await user.click(action);

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Enable Maintenance Mode",
        confirmLabel: "Enable Maintenance",
      })
    );
    await waitFor(() => expect(toggle).toHaveBeenCalledWith("host-1", true));
  });

  it("keeps maintenance and delete actions inside the overflow menu", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ scopes: ["proxy:edit", "proxy:delete"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getProxyHost").mockResolvedValue(makeProxyHost());

    renderWithRouter(<ProxyHostDetail />, {
      path: "/proxy-hosts/:id/:tab",
      route: "/proxy-hosts/host-1/details",
      extraRoutes: <Route path="/proxy-hosts" element={<div>Proxy Hosts</div>} />,
    });

    expect(
      await screen.findByRole("button", { name: "More proxy host actions" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More proxy host actions" }));
    expect(await screen.findByRole("menuitem", { name: /Enable Maintenance/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});
