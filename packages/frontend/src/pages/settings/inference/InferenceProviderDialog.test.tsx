import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { InferenceProviderCatalogItem, InferenceProviderConnection } from "@/types/inference";
import { InferenceProviderDialog } from "./InferenceProviderDialog";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-testid="dialog-root" data-state={open ? "open" : "closed"}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/services/api", () => ({
  api: {
    updateInferenceProvider: vi.fn(),
    updateInferenceRouting: vi.fn(),
    syncInferenceProvider: vi.fn(),
    disconnectInferenceProvider: vi.fn(),
  },
}));

describe("InferenceProviderDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.updateInferenceProvider).mockResolvedValue(connection);
    vi.mocked(api.updateInferenceRouting).mockResolvedValue({
      providerId: connection.providerId,
      routingStrategy: "sequential",
    });
  });

  it("retains provider content while the shared dialog enters its closed state", () => {
    const { rerender } = render(
      <InferenceProviderDialog
        open
        connection={connection}
        provider={provider}
        canManage
        onOpenChange={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByTestId("dialog-root")).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Kimi account")).toBeInTheDocument();

    rerender(
      <InferenceProviderDialog
        open={false}
        connection={null}
        provider={null}
        canManage
        onOpenChange={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByTestId("dialog-root")).toHaveAttribute("data-state", "closed");
    expect(screen.getByText("Kimi account")).toBeInTheDocument();
  });

  it("renames a connection through the existing settings save action", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <InferenceProviderDialog
        open
        connection={connection}
        provider={provider}
        canManage
        onOpenChange={onOpenChange}
        onChanged={onChanged}
      />
    );

    fireEvent.change(screen.getByLabelText("Connection name"), {
      target: { value: "Primary Kimi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(api.updateInferenceProvider).toHaveBeenCalledWith(connection.id, {
        name: "Primary Kimi",
      })
    );
    expect(api.updateInferenceRouting).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("exposes provider-scoped routing strategy next to connection settings", () => {
    render(
      <InferenceProviderDialog
        open
        connection={connection}
        provider={provider}
        canManage
        onOpenChange={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("combobox", { name: "Routing strategy" })).toHaveTextContent(
      "Balanced"
    );
    expect(screen.getByText("Applies to all Kimi subscription connections")).toBeInTheDocument();
  });

  it("saves routing strategy for the whole provider without a redundant connection update", async () => {
    render(
      <InferenceProviderDialog
        open
        connection={connection}
        provider={provider}
        canManage
        onOpenChange={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Routing strategy" }), {
      key: "ArrowDown",
    });
    expect(
      await screen.findByText("Sends more new threads to connections with more remaining quota.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Distributes new threads equally across available connections.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Uses the highest connection until unavailable, then moves down the list.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /^Sequential/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(api.updateInferenceRouting).toHaveBeenCalledWith(connection.providerId, "sequential")
    );
    expect(api.updateInferenceProvider).not.toHaveBeenCalled();
  });
});

const provider: InferenceProviderCatalogItem = {
  id: "kimi",
  label: "Kimi subscription",
  family: "kimi",
  wireProtocol: "openai-chat",
  baseUrl: "https://api.kimi.com/coding/v1",
  authTypes: ["oauth"],
  subscription: true,
  featured: true,
  oauthFlow: "device",
  completionMode: "device_poll",
};

const connection: InferenceProviderConnection = {
  id: "kimi-account",
  providerId: "kimi",
  name: "Kimi account",
  authType: "oauth",
  baseUrl: "https://api.kimi.com/coding/v1",
  accountLabel: "Kimi user",
  enabled: true,
  routingOrder: 0,
  minimumRemainingPercent: 0,
  apiMonthlyLimitMicrodollars: null,
  apiMonthlySpentMicrodollars: 0,
  routingStrategy: "balanced",
  status: "healthy",
  healthReason: null,
  syncStatus: "success",
  syncLastError: null,
  lastSyncedAt: "2026-07-27T12:00:00.000Z",
  quota: [
    { dimension: "5h", status: "fresh", remainingFraction: 0.8 },
    { dimension: "7d", status: "fresh", remainingFraction: 0.85 },
  ],
  discoveredModels: [],
};
