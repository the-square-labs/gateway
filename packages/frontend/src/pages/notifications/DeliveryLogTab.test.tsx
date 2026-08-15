import { fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { WebhookDelivery } from "@/types";
import { DeliveryLogTab } from "./DeliveryLogTab";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

class TestIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: "delivery-1",
    webhookId: "webhook-1",
    webhookName: "Ops webhook",
    eventType: "alert.fired",
    severity: "critical",
    requestUrl: "https://hooks.example.test/ops",
    requestMethod: "POST",
    requestBody: null,
    status: "failed",
    responseStatus: 500,
    responseBody: null,
    responseTimeMs: 123,
    attempt: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    error: "Request failed",
    requestBodyPreview: '{"preview":true}',
    requestBodyTruncated: true,
    responseBodyPreview: "preview response",
    responseBodyTruncated: true,
    createdAt: "2026-06-21T00:00:00.000Z",
    completedAt: "2026-06-21T00:00:01.000Z",
    ...overrides,
  };
}

describe("DeliveryLogTab", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  });

  afterEach(() => {
    api.resetSessionState();
    vi.unstubAllGlobals();
  });

  it("loads deliveries, applies status filters, and opens hydrated delivery details", async () => {
    const listed = makeDelivery();
    const full = makeDelivery({
      requestBody: '{"full":true}',
      responseBody: '{"ok":false}',
    });
    const listDeliveries = vi
      .spyOn(api, "listDeliveries")
      .mockResolvedValueOnce({
        data: [listed],
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      })
      .mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
        totalPages: 1,
      });
    const getDelivery = vi.spyOn(api, "getDelivery").mockResolvedValue(full);

    renderWithRouter(<DeliveryLogTab refreshToken={0} />);

    await waitFor(() => {
      expect(screen.getByText("Ops webhook")).toBeInTheDocument();
    });
    expect(listDeliveries).toHaveBeenNthCalledWith(1, {
      page: 1,
      limit: 100,
      status: undefined,
    });

    fireEvent.click(screen.getByText("Ops webhook"));

    await waitFor(() => {
      expect(getDelivery).toHaveBeenCalledWith("delivery-1");
      expect(screen.getByText('{"full":true}')).toBeInTheDocument();
      expect(screen.getByText('{"ok":false}')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByText("Failed"));

    await waitFor(() => {
      expect(listDeliveries).toHaveBeenNthCalledWith(2, {
        page: 1,
        limit: 100,
        status: "failed",
      });
    });
  });

  it("keeps the end-of-log sentinel compact and centered after the final page", async () => {
    vi.spyOn(api, "listDeliveries").mockResolvedValue({
      data: [makeDelivery()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<DeliveryLogTab refreshToken={0} />);

    const footer = await screen.findByText("End of logs");
    expect(footer).toHaveClass("h-8", "w-full", "justify-center");
    expect(footer).not.toHaveClass("min-h-12");
  });

  it("offers a webhook CTA in the shared empty state", async () => {
    const onConfigureWebhook = vi.fn();
    vi.spyOn(api, "listDeliveries").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<DeliveryLogTab refreshToken={0} onConfigureWebhook={onConfigureWebhook} />);

    fireEvent.click(await screen.findByRole("button", { name: "Configure a webhook" }));
    expect(onConfigureWebhook).toHaveBeenCalledOnce();
  });
});
