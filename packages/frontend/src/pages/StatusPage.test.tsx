import { fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { StatusPage } from "@/pages/StatusPage";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { StatusPageConfig, StatusPageIncident, StatusPageServiceItem } from "@/types";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (index: number) => string | number;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 330,
      })),
    getTotalSize: () => count * 330,
    measureElement: vi.fn(),
  }),
}));

const baseConfig: StatusPageConfig = {
  enabled: true,
  title: "System Status",
  description: "Current service health",
  domain: "status.example.com",
  nodeId: null,
  sslCertificateId: null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: null,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: "warning",
  autoOutageSeverity: "critical",
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 60,
};

const exposedService: StatusPageServiceItem = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceType: "proxy_host",
  sourceId: "22222222-2222-4222-8222-222222222222",
  publicName: "Gateway API",
  publicDescription: null,
  publicGroup: "Core Infrastructure",
  sortOrder: 0,
  enabled: true,
  createThresholdSeconds: 600,
  resolveThresholdSeconds: 60,
  lastEvaluatedStatus: "operational",
  unhealthySince: null,
  healthySince: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  source: { label: "gateway.example.com", status: "operational", rawStatus: "online" },
  currentStatus: "operational",
  broken: false,
};

function incident(index: number): StatusPageIncident {
  return {
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    title: `Incident ${index + 1}`,
    message: `Incident message ${index + 1}`,
    severity: "warning",
    status: "resolved",
    type: "manual",
    autoManaged: false,
    affectedServiceIds: [],
    startedAt: new Date(Date.UTC(2026, 7, 28, 0, index)).toISOString(),
    resolvedAt: new Date(Date.UTC(2026, 7, 28, 0, index + 1)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 7, 28, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 28, 0, index + 1)).toISOString(),
    updates: [],
  };
}

describe("StatusPage", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
    useAuthStore.setState({
      user: makeUser({
        scopes: ["status-page:view", "status-page:manage"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getStatusPageSettings").mockResolvedValue(baseConfig);
    vi.spyOn(api, "listStatusPageServices").mockResolvedValue([]);
    vi.spyOn(api, "listStatusPageIncidents").mockResolvedValue([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listDatabases").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listDockerComposeProjects").mockResolvedValue([]);
    vi.spyOn(api, "listPageProjects").mockResolvedValue({ data: [] } as never);
  });

  afterEach(() => {
    api.resetSessionState();
  });

  it("tracks and saves general and auto-incident settings independently", async () => {
    const updateStatusPageSettings = vi.spyOn(api, "updateStatusPageSettings").mockResolvedValue({
      ...baseConfig,
      title: "Gateway Status",
      publicIncidentLimit: 10,
    });

    renderWithRouter(<StatusPage />, {
      path: "/status-page/:tab?",
      route: "/status-page/settings",
    });

    const title = (await screen.findByLabelText("Public title")) as HTMLInputElement;
    expect(title).toHaveAttribute("placeholder", "e.g. Acme Status");
    expect(screen.getByRole("heading", { name: "Public description" })).toBeInTheDocument();
    expect(screen.getByLabelText("Public description")).toHaveAttribute(
      "placeholder",
      "Short description shown beneath the public status page title"
    );
    const publicIncidentLimit = screen.getByLabelText("Public incident limit") as HTMLInputElement;
    const generalHeading = screen.getByRole("heading", { name: "General Settings" });
    const autoHeading = screen.getByRole("heading", { name: "Auto-Incident Settings" });
    const generalPanel = generalHeading.closest(".border");
    const autoPanel = autoHeading.closest(".border");
    expect(
      screen.getByRole("button", { name: "About Recent resolved incidents" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Public incident limit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "About Auto incidents for degraded services" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Create incident delay" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "About Public title" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "About Public description" })
    ).not.toBeInTheDocument();
    expect(generalHeading.querySelector("svg")).toBeInTheDocument();
    expect(autoHeading.querySelector("svg")).toBeInTheDocument();
    const [generalSave, autoSave] = screen.getAllByRole("button", { name: "Save" });

    expect(generalSave).toBeDisabled();
    expect(autoSave).toBeDisabled();
    expect(generalPanel).not.toHaveStyle({ borderColor: "var(--color-warning)" });
    expect(autoPanel).not.toHaveStyle({ borderColor: "var(--color-warning)" });

    fireEvent.change(title, { target: { value: "Gateway Status" } });
    fireEvent.change(publicIncidentLimit, { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Create incident after seconds"), {
      target: { value: "900" },
    });

    expect(generalSave).toBeEnabled();
    expect(autoSave).toBeEnabled();
    expect(generalPanel).toHaveStyle({ borderColor: "var(--color-warning)" });
    expect(autoPanel).toHaveStyle({ borderColor: "var(--color-warning)" });

    fireEvent.click(generalSave);

    await waitFor(() => {
      expect(updateStatusPageSettings).toHaveBeenCalledWith({
        title: "Gateway Status",
        description: "Current service health",
        recentIncidentDays: 14,
        publicIncidentLimit: 10,
      });
    });

    await waitFor(() => expect(generalSave).toBeDisabled());
    expect(screen.getByLabelText("Create incident after seconds")).toHaveValue(900);
    expect(autoSave).toBeEnabled();
    expect(generalPanel).not.toHaveStyle({ borderColor: "var(--color-warning)" });
    expect(autoPanel).toHaveStyle({ borderColor: "var(--color-warning)" });

    vi.mocked(api.updateStatusPageSettings).mockResolvedValue({
      ...baseConfig,
      title: "Gateway Status",
      publicIncidentLimit: 10,
      autoCreateThresholdSeconds: 900,
    });

    fireEvent.click(autoSave);

    await waitFor(() => {
      expect(updateStatusPageSettings).toHaveBeenLastCalledWith({
        autoDegradedEnabled: true,
        autoOutageEnabled: true,
        autoDegradedSeverity: "warning",
        autoOutageSeverity: "critical",
        autoCreateThresholdSeconds: 900,
        autoResolveThresholdSeconds: 60,
      });
    });
    await waitFor(() => expect(autoSave).toBeDisabled());
  });

  it("uses shared group headers and opens editing from the whole service row", async () => {
    vi.mocked(api.listStatusPageServices).mockResolvedValue([exposedService]);

    renderWithRouter(<StatusPage />, {
      path: "/status-page/:tab?",
      route: "/status-page/services",
    });

    expect(await screen.findByText("Core Infrastructure")).toBeInTheDocument();
    expect(screen.queryByText("PERSONAL")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reorder Core Infrastructure" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Gateway API editor" }));
    expect(await screen.findByText("Edit Exposed Service")).toBeInTheDocument();
  });

  it("shows placeholders, current source types, and a descriptive borderless visibility row", async () => {
    renderWithRouter(<StatusPage />, {
      path: "/status-page/:tab?",
      route: "/status-page/services",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Expose Service" }));

    expect(screen.getByPlaceholderText("Customer-facing service name")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Optional description shown on the public page")
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Core Infrastructure")).toBeInTheDocument();
    expect(screen.getByText(/Hidden services remain configured/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visible on public page" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Proxy Host").closest("button")!);
    expect(await screen.findByText("Docker Compose Project")).toBeInTheDocument();
    expect(screen.getByText("Pages Project")).toBeInTheDocument();
  });

  it("uses a closed searchable combobox for the source selector", async () => {
    vi.mocked(api.listProxyHosts).mockResolvedValue({
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          domainNames: ["gateway.example.com"],
          healthCheckEnabled: true,
          isSystem: false,
        },
      ],
    } as never);

    renderWithRouter(<StatusPage />, {
      path: "/status-page/:tab?",
      route: "/status-page/services",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Expose Service" }));
    const source = screen.getByRole("combobox", { name: "Source" });
    await waitFor(() => expect(source).not.toBeDisabled());
    fireEvent.focus(source);
    fireEvent.change(source, { target: { value: "gateway" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: "gateway.example.com" }));

    expect(source).toHaveValue("gateway.example.com");
  });

  it("loads incidents automatically when the virtualized page end is visible", async () => {
    const firstPage = Array.from({ length: 21 }, (_, index) => incident(index));
    const secondPage = [incident(20), incident(21)];
    vi.mocked(api.listStatusPageIncidents).mockImplementation(async (params) =>
      params?.offset === 20 ? secondPage : firstPage
    );

    renderWithRouter(<StatusPage />, {
      path: "/status-page/:tab?",
      route: "/status-page/incidents",
    });

    const firstTitle = await screen.findByRole("heading", { name: "Incident 1" });
    expect(firstTitle).toHaveClass("text-sm");

    expect(await screen.findByRole("heading", { name: "Incident 21" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Incident 22" })).toBeInTheDocument();
    expect(api.listStatusPageIncidents).toHaveBeenCalledWith({
      status: "all",
      limit: 21,
      offset: 20,
    });
    expect(screen.queryByText("Scroll to load more incidents")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Status page incidents")).not.toHaveClass("overflow-y-auto");
  });
});
