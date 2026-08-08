import { screen } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import { SiemDestinationsTab } from "./SiemDestinationsTab";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

describe("SiemDestinationsTab", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    api.resetSessionState();
  });

  it("shows a compact last-delivery status without the page description or timestamp", async () => {
    vi.spyOn(api, "listSiemDestinations").mockResolvedValue({
      data: [
        {
          id: "siem-1",
          name: "Security Operations",
          url: "https://siem.example.test/gateway/audit",
          authType: "custom_header",
          customHeaderName: "X-API-Key",
          secretConfigured: true,
          enabled: true,
          pendingDeliveries: 0,
          lastDeliveryStatus: "delivered",
          lastDeliveryAt: "2026-08-08T00:51:50.000Z",
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(
      <SiemDestinationsTab
        canRead
        canManage={false}
        openCreateToken={0}
        onViewDeliveryLog={vi.fn()}
      />
    );

    await screen.findByText("Security Operations");
    const endpoint = screen.getByText("https://siem.example.test/gateway/audit");
    expect(endpoint).toHaveAttribute("title", "https://siem.example.test/gateway/audit");
    expect(endpoint).not.toHaveClass("max-w-[300px]");
    expect(screen.getByText("Custom header")).toBeInTheDocument();
    expect(screen.getByText("delivered")).toBeInTheDocument();
    expect(
      screen.queryByText(/Export privacy-reduced Gateway audit events/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
  });
});
