import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const CHATGPT: InferenceProviderCatalogItem = {
  id: "openai",
  label: "ChatGPT subscription",
  family: "openai",
  wireProtocol: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authTypes: ["oauth"],
  subscription: true,
  featured: true,
  termsVersion: "terms-v1",
  oauthFlow: "redirect",
  completionMode: "paste_callback",
};

describe("InferenceProviderConnectDialog", () => {
  afterEach(() => useConfirmDialog.getState().close());

  it("polls a device flow automatically and completes without a manual check button", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
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
    expect(openSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(api.startInferenceOAuth).toHaveBeenCalledWith({
      providerId: "xai",
      connectionName: "Grok team",
      acceptTerms: true,
      termsVersion: "terms-v1",
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /complete|check/i })).not.toBeInTheDocument();
    await waitFor(() => expect(api.getInferenceOAuthStatus).toHaveBeenCalledWith("session-1"), {
      timeout: 2_000,
    });
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not reset an active OAuth flow when realtime refresh replaces the catalog objects", async () => {
    vi.mocked(api.startInferenceOAuth).mockResolvedValue({
      id: "session-refresh",
      providerId: "xai",
      status: "pending",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      userCode: "KEEP-FLOW",
      pollIntervalSeconds: 30,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const onOpenChange = vi.fn();
    const onConnected = vi.fn();
    const view = renderConnectDialog({ onOpenChange, onConnected });
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    expect(await screen.findByText("KEEP-FLOW")).toBeInTheDocument();

    view.rerender(
      <>
        <InferenceProviderConnectDialog
          open
          catalog={[{ ...XAI }]}
          onOpenChange={onOpenChange}
          onConnected={onConnected}
        />
        <ConfirmDialog />
      </>
    );

    expect(screen.getByText("KEEP-FLOW")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Team account")).not.toBeInTheDocument();
  });

  it("does not discard an in-flight complete response when realtime refresh replaces callbacks", async () => {
    let resolveStatus:
      | ((session: Awaited<ReturnType<typeof api.getInferenceOAuthStatus>>) => void)
      | undefined;
    vi.mocked(api.startInferenceOAuth).mockResolvedValue({
      id: "session-in-flight",
      providerId: "xai",
      status: "pending",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      userCode: "IN-FLIGHT",
      pollIntervalSeconds: 1,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(api.getInferenceOAuthStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    const firstOpenChange = vi.fn();
    const firstConnected = vi.fn();
    const view = renderConnectDialog({
      onOpenChange: firstOpenChange,
      onConnected: firstConnected,
    });
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    await screen.findByText("IN-FLIGHT");
    await waitFor(() => expect(api.getInferenceOAuthStatus).toHaveBeenCalled(), { timeout: 2_000 });

    const refreshedOpenChange = vi.fn();
    const refreshedConnected = vi.fn();
    view.rerender(
      <>
        <InferenceProviderConnectDialog
          open
          catalog={[{ ...XAI }]}
          onOpenChange={refreshedOpenChange}
          onConnected={refreshedConnected}
        />
        <ConfirmDialog />
      </>
    );
    await act(async () =>
      resolveStatus?.({
        id: "session-in-flight",
        providerId: "xai",
        status: "complete",
        authorizationUrl: "https://auth.x.ai/device",
        completionMode: "device_poll",
        connectionId: "connection-in-flight",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })
    );

    await waitFor(() => expect(refreshedOpenChange).toHaveBeenCalledWith(false));
    expect(refreshedConnected).toHaveBeenCalledOnce();
  });

  it("keeps the terms confirmation open with a loading confirm button while authorization starts", async () => {
    vi.mocked(api.startInferenceOAuth).mockImplementation(() => new Promise(() => {}));
    renderConnectDialog();
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));

    const terms = screen.getByRole("dialog", { name: "Review provider terms" });
    const confirmButton = within(terms).getByRole("button", { name: "Continue to authorization" });
    expect(confirmButton).toBeDisabled();
    expect(confirmButton.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("Starting provider authorization…")).not.toBeInTheDocument();
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

  it("cancels a pending server session before returning from the locked onboarding flow", async () => {
    const onBack = vi.fn();
    vi.mocked(api.startInferenceOAuth).mockResolvedValue({
      id: "session-locked",
      providerId: "xai",
      status: "pending",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      userCode: "LOCK-ED",
      pollIntervalSeconds: 30,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(api.cancelInferenceOAuth).mockResolvedValue({
      id: "session-locked",
      providerId: "xai",
      status: "cancelled",
      authorizationUrl: "https://auth.x.ai/device",
      completionMode: "device_poll",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    render(
      <>
        <InferenceProviderConnectDialog
          open
          catalog={[XAI]}
          onOpenChange={vi.fn()}
          onConnected={vi.fn()}
          locked
          onBack={onBack}
        />
        <ConfirmDialog />
      </>
    );
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "Grok team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));

    await screen.findByText("LOCK-ED");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(api.cancelInferenceOAuth).toHaveBeenCalledWith("session-locked");
    expect(onBack).toHaveBeenCalledTimes(1);
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

  it("keeps the setup form mounted while switching providers", () => {
    renderConnectDialog({ catalog: [XAI, CHATGPT] });
    const nameInput = screen.getByPlaceholderText("Team account");

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "ChatGPT subscription" }));

    expect(screen.getByPlaceholderText("Team account")).toBe(nameInput);
  });

  it("labels a pasted callback flow with the selected provider and waits for confirmation", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onConnected = vi.fn<() => void>();
    vi.mocked(api.startInferenceOAuth).mockResolvedValue({
      id: "session-chatgpt",
      providerId: "openai",
      status: "pending",
      authorizationUrl: "https://auth.openai.com/authorize",
      completionMode: "paste_callback",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.mocked(api.completeInferenceOAuth).mockResolvedValue({
      id: "session-chatgpt",
      providerId: "openai",
      status: "complete",
      authorizationUrl: "https://auth.openai.com/authorize",
      completionMode: "paste_callback",
      connectionId: "connection-chatgpt",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    renderConnectDialog({ catalog: [CHATGPT], onOpenChange, onConnected });
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "ChatGPT team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));

    expect(await screen.findByText("Open ChatGPT authorization and sign in.")).toBeInTheDocument();
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
    const completeButton = screen.getByRole("button", {
      name: "Complete ChatGPT authorization",
    });
    expect(completeButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Paste code#state or callback URL"), {
      target: { value: "authorization-code#oauth-state" },
    });
    expect(completeButton).toBeEnabled();
    expect(api.completeInferenceOAuth).not.toHaveBeenCalled();
    fireEvent.click(completeButton);

    await waitFor(() =>
      expect(api.completeInferenceOAuth).toHaveBeenCalledWith(
        "session-chatgpt",
        "authorization-code#oauth-state"
      )
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the callback submit loading and polls until the core finishes authorization", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onConnected = vi.fn<() => void>();
    const pendingSession = {
      id: "session-callback-pending",
      providerId: "openai",
      status: "pending" as const,
      authorizationUrl: "https://auth.openai.com/authorize",
      completionMode: "paste_callback" as const,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    vi.mocked(api.startInferenceOAuth).mockResolvedValue(pendingSession);
    vi.mocked(api.completeInferenceOAuth).mockResolvedValue(pendingSession);
    vi.mocked(api.getInferenceOAuthStatus).mockResolvedValue({
      ...pendingSession,
      status: "complete",
      connectionId: "connection-callback-pending",
    });

    renderConnectDialog({ catalog: [CHATGPT], onOpenChange, onConnected });
    fireEvent.change(screen.getByPlaceholderText("Team account"), {
      target: { value: "ChatGPT team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    await screen.findByPlaceholderText("Paste code#state or callback URL");
    fireEvent.change(screen.getByPlaceholderText("Paste code#state or callback URL"), {
      target: { value: "authorization-code#oauth-state" },
    });
    const completeButton = screen.getByRole("button", {
      name: "Complete ChatGPT authorization",
    });
    fireEvent.click(completeButton);

    await waitFor(() => expect(api.completeInferenceOAuth).toHaveBeenCalledOnce());
    expect(completeButton).toBeDisabled();
    expect(completeButton.querySelector(".animate-spin")).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await waitFor(
      () => expect(api.getInferenceOAuthStatus).toHaveBeenCalledWith(pendingSession.id),
      {
        timeout: 2_000,
      }
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(api.completeInferenceOAuth).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

function renderConnectDialog({
  catalog = [XAI],
  onOpenChange = vi.fn(),
  onConnected = vi.fn(),
}: {
  catalog?: InferenceProviderCatalogItem[];
  onOpenChange?: (open: boolean) => void;
  onConnected?: () => void | Promise<void>;
} = {}) {
  const handleOpenChange = onOpenChange ?? vi.fn<(open: boolean) => void>();
  const handleConnected = onConnected ?? vi.fn<() => void>();
  return render(
    <>
      <InferenceProviderConnectDialog
        open
        catalog={catalog}
        onOpenChange={handleOpenChange}
        onConnected={handleConnected}
      />
      <ConfirmDialog />
    </>
  );
}
