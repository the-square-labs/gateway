import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { NotificationWebhook } from "@/types";
import { WebhooksTab } from "./WebhooksTab";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

function makeWebhook(overrides: Partial<NotificationWebhook> = {}): NotificationWebhook {
  return {
    id: "webhook-1",
    name: "Ops Discord",
    url: "https://hooks.example.test/ops",
    method: "POST",
    enabled: true,
    signingSecret: null,
    signingHeader: null,
    templatePreset: "discord",
    bodyTemplate: null,
    headers: {},
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("WebhooksTab", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    api.resetSessionState();
  });

  it("loads webhooks and toggles enabled state when management is allowed", async () => {
    const listed = makeWebhook();
    const updated = makeWebhook({ enabled: false, updatedAt: "2026-06-21T00:01:00.000Z" });
    const listWebhooks = vi.spyOn(api, "listWebhooks").mockResolvedValue({
      data: [listed],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    const updateWebhook = vi.spyOn(api, "updateWebhook").mockResolvedValue(updated);
    const getWebhookPresets = vi.spyOn(api, "getWebhookPresets").mockResolvedValue([
      {
        id: "discord",
        name: "Discord",
        description: "Discord webhook",
        urlHint: "https://discord.com/api/webhooks/...",
        defaultHeaders: {},
        bodyTemplate: "{}",
      },
    ]);

    renderWithRouter(<WebhooksTab canRead canManage openCreateToken={0} />);

    await waitFor(() => {
      expect(screen.getByText("Ops Discord")).toBeInTheDocument();
    });
    expect(listWebhooks).toHaveBeenCalledWith({ limit: 100 });
    const endpoint = screen.getByText("https://hooks.example.test/ops");
    expect(endpoint).toHaveAttribute("title", "https://hooks.example.test/ops");
    expect(endpoint).not.toHaveClass("max-w-[300px]");
    expect(screen.getByText("discord")).toBeInTheDocument();

    const row = screen.getByText("Ops Discord").closest("tr");
    expect(row).not.toBeNull();
    const toggle = within(row as HTMLTableRowElement).getAllByRole("button")[0];

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateWebhook).toHaveBeenCalledWith("webhook-1", { enabled: false });
    });

    fireEvent.click(within(row as HTMLTableRowElement).getByText("Ops Discord"));

    await waitFor(() => {
      expect(screen.getByText("Edit Webhook")).toBeInTheDocument();
      expect(getWebhookPresets).toHaveBeenCalled();
    });
  });

  it("does not replay a stale create token when the webhooks tab mounts", async () => {
    vi.spyOn(api, "listWebhooks").mockResolvedValue({
      data: [makeWebhook()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<WebhooksTab canRead canManage openCreateToken={3} />);

    await screen.findByText("Ops Discord");
    expect(screen.queryByRole("heading", { name: "New Webhook" })).not.toBeInTheDocument();
  });

  it("uses the shared empty state with a create CTA and no duplicate description", async () => {
    vi.spyOn(api, "listWebhooks").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<WebhooksTab canRead canManage openCreateToken={0} />);

    expect(await screen.findByRole("button", { name: "Create a webhook" })).toBeInTheDocument();
    expect(
      screen.queryByText("Webhooks define where and how notifications are delivered.")
    ).not.toBeInTheDocument();
  });
});
