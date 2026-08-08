import { screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { Notifications } from "@/pages/Notifications";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_GATEWAY_FEATURES, useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { AlertRule, SiemDelivery, SiemDestination } from "@/types";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

function makeAlertRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "alert-1",
    name: "CPU High",
    enabled: true,
    type: "threshold",
    category: "node",
    severity: "warning",
    metric: "cpu",
    metricTarget: null,
    operator: ">",
    thresholdValue: 80,
    durationSeconds: 300,
    fireThresholdPercent: 100,
    resolveAfterSeconds: 60,
    resolveThresholdPercent: 100,
    eventPattern: null,
    resourceIds: [],
    messageTemplate: null,
    webhookIds: ["webhook-1", "webhook-2"],
    cooldownSeconds: 900,
    isBuiltin: false,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

function makeSiemDestination(overrides: Partial<SiemDestination> = {}): SiemDestination {
  return {
    id: "siem-1",
    name: "Security Operations",
    url: "https://siem.example.test/gateway/audit",
    authType: "hmac_sha256",
    customHeaderName: null,
    secretConfigured: true,
    enabled: true,
    pendingDeliveries: 0,
    lastDeliveryStatus: null,
    lastDeliveryAt: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function emptySiemDeliveries(): {
  data: SiemDelivery[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
} {
  return { data: [], total: 0, page: 1, limit: 100, totalPages: 1 };
}

describe("Notifications page", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
    useSystemConfigStore.getState().reset();
    useAuthStore.setState({
      user: makeUser({ scopes: ["notifications:alerts:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    api.resetSessionState();
    useSystemConfigStore.getState().reset();
  });

  it("renders alert rules with formatted threshold conditions", async () => {
    const listAlertRules = vi.spyOn(api, "listAlertRules").mockResolvedValue({
      data: [makeAlertRule()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<Notifications />, {
      path: "/notifications/:tab?",
      route: "/notifications/alerts",
    });

    await waitFor(() => {
      expect(screen.getByText("CPU High")).toBeInTheDocument();
    });

    expect(listAlertRules).toHaveBeenCalledWith({ limit: 100 });
    expect(screen.getByText("cpu > 80 • fire 100% in 5m • resolve 100% in 1m")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("gives a SIEM-only reader the dedicated tabs without notification access", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["audit:siem:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "listSiemDestinations").mockResolvedValue({
      data: [makeSiemDestination()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    vi.spyOn(api, "listSiemDeliveries").mockResolvedValue(emptySiemDeliveries());

    renderWithRouter(<Notifications />, {
      path: "/notifications/:tab?",
      route: "/notifications/siem",
    });

    await waitFor(() => {
      expect(screen.getByText("Security Operations")).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: "SIEM" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "SIEM Delivery Log" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Alerts" })).not.toBeInTheDocument();
  });

  it("hides SIEM tabs and skips SIEM preloading when the Gateway feature is disabled", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["audit:siem:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.getState().setConfig({
      features: { ...DEFAULT_GATEWAY_FEATURES, siemEnabled: false },
    });
    const listSiemDestinations = vi.spyOn(api, "listSiemDestinations");
    const listSiemDeliveries = vi.spyOn(api, "listSiemDeliveries");

    renderWithRouter(<Notifications />, {
      path: "/notifications/:tab?",
      route: "/notifications/siem",
    });

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "SIEM" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("tab", { name: "SIEM Delivery Log" })).not.toBeInTheDocument();
    expect(listSiemDestinations).not.toHaveBeenCalled();
    expect(listSiemDeliveries).not.toHaveBeenCalled();
  });
});
