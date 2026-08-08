import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { SiemDelivery } from "@/types";
import { SiemDeliveryLogTab } from "./SiemDeliveryLogTab";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

class TestIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

function makeDelivery(overrides: Partial<SiemDelivery> = {}): SiemDelivery {
  return {
    id: "delivery-1",
    destinationId: "siem-1",
    destinationName: "Security Operations",
    destinationUrl: "https://siem.example.test/gateway/audit",
    auditLogId: "audit-1",
    action: "proxy_host.update",
    status: "failed",
    attempt: 2,
    maxAttempts: 8,
    nextRetryAt: null,
    responseStatus: 500,
    responseTimeMs: 123,
    error: "Collector returned HTTP 500",
    createdAt: "2026-08-07T00:00:00.000Z",
    completedAt: "2026-08-07T00:00:01.000Z",
    ...overrides,
  };
}

describe("SiemDeliveryLogTab", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  });

  afterEach(() => {
    api.resetSessionState();
    vi.unstubAllGlobals();
  });

  it("renders the frozen safe event but never a collector response body", async () => {
    const listed = makeDelivery();
    const full = {
      ...makeDelivery({
        payload: {
          id: "11111111-1111-4111-8111-111111111111",
          source: "urn:wiolett:gateway:installation-1",
          type: "com.wiolett.gateway.audit.v1",
          time: "2026-08-07T00:00:00.000Z",
          data: {
            action: "proxy_host.update",
            actor: { id: "user-1", email: "admin@example.test" },
            resource: { type: "proxy_host", id: "proxy-1" },
            sourceIp: "203.0.113.20",
          },
        },
      }),
      responseBody: "collector-secret-response",
    } as SiemDelivery;
    vi.spyOn(api, "listSiemDeliveries").mockResolvedValue({
      data: [listed],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    vi.spyOn(api, "listSiemDestinations").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    const getSiemDelivery = vi.spyOn(api, "getSiemDelivery").mockResolvedValue(full);

    renderWithRouter(<SiemDeliveryLogTab canManage refreshToken={0} />);

    await screen.findByText("Security Operations");
    fireEvent.click(screen.getByText("Security Operations"));

    await waitFor(() => {
      expect(getSiemDelivery).toHaveBeenCalledWith("delivery-1");
      expect(screen.getByText(/"id": "11111111-1111-4111-8111-111111111111"/)).toBeInTheDocument();
      expect(screen.getByText(/proxy-1/)).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("sm:max-w-3xl");
    expect(within(dialog).getByText("Status").parentElement).toHaveClass("rounded-md", "border");
    expect(within(dialog).getByText("Exported event").closest(".border")).toHaveClass("bg-card");
    expect(within(dialog).getByRole("button", { name: "Requeue delivery" })).toBeInTheDocument();
    expect(screen.queryByText("collector-secret-response")).not.toBeInTheDocument();
  });

  it("uses the selected destination when loading its delivery history", async () => {
    const listSiemDeliveries = vi.spyOn(api, "listSiemDeliveries").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    vi.spyOn(api, "listSiemDestinations").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(
      <SiemDeliveryLogTab canManage={false} initialDestinationId="siem-1" refreshToken={0} />
    );

    await waitFor(() => {
      expect(listSiemDeliveries).toHaveBeenCalledWith({
        page: 1,
        limit: 100,
        destinationId: "siem-1",
        status: undefined,
      });
    });
  });

  it("keeps the end-of-log sentinel compact after the final page", async () => {
    vi.spyOn(api, "listSiemDeliveries").mockResolvedValue({
      data: [makeDelivery()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    vi.spyOn(api, "listSiemDestinations").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<SiemDeliveryLogTab canManage refreshToken={0} />);

    const footer = await screen.findByText("End of logs");
    expect(footer).toHaveClass("h-8");
    expect(footer).toHaveClass("w-full", "justify-center");
    expect(footer).not.toHaveClass("min-h-12");
  });
});
