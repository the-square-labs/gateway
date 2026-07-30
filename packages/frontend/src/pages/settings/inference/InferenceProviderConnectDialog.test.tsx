import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import type { InferenceProviderCatalogItem } from "@/types/inference";
import { InferenceProviderConnectDialog } from "./InferenceProviderConnectDialog";

vi.mock("@/services/api", () => ({
  api: {
    startInferenceOAuth: vi.fn(),
    getInferenceOAuthStatus: vi.fn(),
    cancelInferenceOAuth: vi.fn(),
    createInferenceProviderConnection: vi.fn(),
    completeInferenceOAuth: vi.fn(),
  },
}));

const XAI: InferenceProviderCatalogItem = {
  id: "xai",
  label: "xAI Grok subscription",
  family: "custom",
  wireProtocol: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  authTypes: ["oauth"],
  subscription: true,
  featured: true,
  termsVersion: "terms-v1",
  oauthFlow: "device",
  completionMode: "device_poll",
};

describe("InferenceProviderConnectDialog", () => {
  afterEach(() => useConfirmDialog.getState().close());

  it("polls a device flow automatically and completes without a manual check button", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onConnected = vi.fn<() => void>();
    vi.mocked(api.startInferenceOAuth).mockResolvedValue({
      id: "session-1",
      providerId: "xai",
      status: "pending",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      userCode: "ABCD-EFGH",
      pollIntervalSeconds: 1,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(api.getInferenceOAuthStatus).mockResolvedValue({
      id: "session-1",
      providerId: "xai",
      status: "complete",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      connectionId: "connection-1",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    renderConnectDialog({ onOpenChange, onConnected });
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });
    expect(screen.queryByText("Connector terms")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    expect(screen.getByRole("dialog", { name: "Review provider terms" })).toBeInTheDocument();
    expect(api.startInferenceOAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));

    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(api.startInferenceOAuth).toHaveBeenCalledWith({
      providerId: "xai",
      connectionName: "Grok team",
      acceptTerms: true,
      termsVersion: "terms-v1",
    });
    expect(screen.queryByRole("button", { name: /complete|check/i })).not.toBeInTheDocument();
    await waitFor(() => expect(api.getInferenceOAuthStatus).toHaveBeenCalledWith("session-1"), {
      timeout: 2_000,
    });
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancels a pending server session when the dialog is closed", async () => {
    vi.mocked(api.startInferenceOAuth).mockResolvedValue({
      id: "session-2",
      providerId: "xai",
      status: "pending",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      pollIntervalSeconds: 30,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(api.cancelInferenceOAuth).mockResolvedValue({
      id: "session-2",
      providerId: "xai",
      status: "cancelled",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    renderConnectDialog();
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    const closeButtons = await screen.findAllByRole("button", { name: "Close" });
    fireEvent.click(closeButtons.at(-1)!);

    expect(api.cancelInferenceOAuth).toHaveBeenCalledWith("session-2");
  });

  it("returns to connection setup when the provider warning is cancelled", () => {
    renderConnectDialog();
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(api.startInferenceOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Connect inference provider" })).toBeInTheDocument();
  });
});

function renderConnectDialog({
  onOpenChange = vi.fn(),
  onConnected = vi.fn(),
}: {
  onOpenChange?: (open: boolean) => void;
  onConnected?: () => void | Promise<void>;
} = {}) {
  const handleOpenChange = onOpenChange ?? vi.fn<(open: boolean) => void>();
  const handleConnected = onConnected ?? vi.fn<() => void>();
  return render(
    <>
      <InferenceProviderConnectDialog
        open
        catalog={[XAI]}
        onOpenChange={handleOpenChange}
        onConnected={handleConnected}
      />
      <ConfirmDialog />
    </>
  );
}
