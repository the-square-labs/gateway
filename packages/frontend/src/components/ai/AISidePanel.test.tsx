import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { INFERENCE_SELF_USAGE_UPDATED_EVENT } from "@/lib/inference-self-usage";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import { renderWithRouter } from "@/test/render";
import type { AIMessage } from "@/types/ai";
import { AILiteSidebar } from "./AILiteSidebar";
import { AISidePanel } from "./AISidePanel";
import { getInferenceQuotaState } from "./InferenceQuotaStatus";

function renderAISidePanel() {
  return renderWithRouter(
    <TooltipProvider>
      <AISidePanel />
    </TooltipProvider>
  );
}

function setScrollMetrics(node: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(node, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

function assistantMessage(toolStatus?: AIMessage["toolCalls"]): AIMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "I will check that.",
    isStreaming: true,
    toolCalls: toolStatus,
  };
}

describe("AISidePanel autoscroll", () => {
  afterEach(() => {
    act(() => {
      useAIStore.setState({
        messages: [],
        isConnected: false,
        isStreaming: false,
        retryAfter: null,
        providerStatus: null,
        selectedModel: null,
        selectedReasoningEffort: null,
      });
      useUIStore.setState({ aiPanelOpen: false, aiLiteMode: false, sidebarOpen: true });
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
      useConfirmDialog.getState().close();
    });
  });

  it("keeps the message viewport pinned when a tool call appears at the bottom", async () => {
    act(() => {
      useAIStore.setState({
        messages: [assistantMessage()],
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
      });
      useUIStore.setState({ aiPanelOpen: true });
    });

    renderAISidePanel();

    const log = screen.getByRole("log", { name: "AI messages" });
    setScrollMetrics(log, 1000, 400);
    log.scrollTop = 600;
    fireEvent.scroll(log);

    setScrollMetrics(log, 1200, 400);
    act(() => {
      useAIStore.setState({
        messages: [
          assistantMessage([
            {
              id: "tool-1",
              name: "find_resource",
              arguments: { query: "api" },
              status: "awaiting_approval",
            },
          ]),
        ],
      });
    });

    await waitFor(() => expect(log.scrollTop).toBe(1200));
  });

  it("does not force-scroll when the user has scrolled away from the bottom", async () => {
    act(() => {
      useAIStore.setState({
        messages: [assistantMessage()],
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
      });
      useUIStore.setState({ aiPanelOpen: true });
    });

    renderAISidePanel();

    const log = screen.getByRole("log", { name: "AI messages" });
    setScrollMetrics(log, 1000, 400);
    log.scrollTop = 300;
    fireEvent.scroll(log);

    setScrollMetrics(log, 1200, 400);
    act(() => {
      useAIStore.setState({
        messages: [
          assistantMessage([
            {
              id: "tool-1",
              name: "find_resource",
              arguments: { query: "api" },
              status: "awaiting_approval",
            },
          ]),
        ],
      });
    });

    await waitFor(() => expect(log.scrollTop).toBe(300));
  });

  it("prompts before switching the side panel into persisted lite mode", async () => {
    act(() => {
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    expect(useConfirmDialog.getState().open).toBe(true);
    expect(useUIStore.getState().aiLiteMode).toBe(false);

    act(() => {
      useConfirmDialog.getState().onConfirm?.();
    });

    await waitFor(() => {
      expect(useUIStore.getState().aiLiteMode).toBe(true);
      expect(useUIStore.getState().aiPanelOpen).toBe(false);
    });
  });

  it("allows sending an empty new chat while another chat is running in the background", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();

    act(() => {
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
        activeConversationId: "background-conversation",
        activeRunId: "background-run",
        connect: vi.fn().mockResolvedValue(true),
        sendMessage,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const composer = screen.getByPlaceholderText("Ask anything... (/ commands)");
    await user.type(composer, "start another check");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith("start another check", expect.any(Object), [], {
      startNewConversation: true,
    });
  });

  it("keeps the composer visible for auto-approved running tool calls", () => {
    act(() => {
      useAIStore.setState({
        messages: [
          assistantMessage([
            {
              id: "tool-1",
              name: "run_process",
              arguments: { command: ["sh", "-lc", "pwd"] },
              status: "running",
              approvalPolicy: "auto_approved",
            },
          ]),
        ],
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    expect(screen.queryByText("Sending approval decision...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run process/i })).toBeInTheDocument();
  });

  it("shows the selected model reasoning levels even when model selection is locked", async () => {
    const user = userEvent.setup();

    act(() => {
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        providerStatus: {
          enabled: true,
          providerType: "gateway_inference",
          defaultModel: "k3",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [
            {
              id: "k3",
              displayName: "K3",
              supportsImages: false,
              maxContextTokens: 100_000,
              maxOutputTokens: 16_000,
              reasoningEfforts: ["low", "high", "max"],
              defaultReasoningEffort: "high",
            },
          ],
        },
        selectedModel: "k3",
        selectedReasoningEffort: "high",
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    await user.click(screen.getByRole("button", { name: "Reasoning effort" }));
    await user.click(screen.getByRole("menuitem", { name: /max/i }));

    expect(useAIStore.getState().selectedReasoningEffort).toBe("max");
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("max");
  });

  it("warns about inference quota windows with 10% or less remaining", async () => {
    vi.spyOn(api, "getInferenceSelfUsage").mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 90, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": { configured: true, percentage: 89, recoveryAt: "2030-01-07T00:00:00.000Z" },
        "30d": {
          configured: true,
          percentage: 96.4,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    });

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "inference:usage:view:self"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        providerStatus: {
          enabled: true,
          providerType: "gateway_inference",
          defaultModel: "k3",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [],
        },
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Inference quota is almost exhausted: 5-hour 10% remaining, monthly 4% remaining."
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("weekly");
  });

  it("updates the composer quota as soon as another usage surface refreshes it", async () => {
    const initialUsage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": { configured: true, percentage: 98.1, recoveryAt: "2030-01-07T00:00:00.000Z" },
        "30d": {
          configured: false,
          percentage: 0,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    };
    vi.spyOn(api, "getInferenceSelfUsage").mockResolvedValue(initialUsage);

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "inference:usage:view:self"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        providerStatus: {
          enabled: true,
          providerType: "gateway_inference",
          defaultModel: "k3",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [],
        },
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();
    expect(await screen.findByRole("status")).toHaveTextContent("weekly 2% remaining");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(INFERENCE_SELF_USAGE_UPDATED_EVENT, {
          detail: {
            ...initialUsage,
            subscription: {
              ...initialUsage.subscription,
              "7d": {
                ...initialUsage.subscription["7d"],
                percentage: 98.6,
              },
            },
          },
        })
      );
    });

    expect(screen.getByRole("status")).toHaveTextContent("weekly 1% remaining");
  });

  it("replaces the composer with a blocking quota banner below 0.5% remaining", async () => {
    const exhaustedUsage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": {
          configured: true,
          percentage: 99.6,
          recoveryAt: "2030-01-07T00:00:00.000Z",
        },
        "30d": {
          configured: false,
          percentage: 0,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    };
    vi.spyOn(api, "getInferenceSelfUsage").mockResolvedValue(exhaustedUsage);

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "inference:usage:view:self"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        providerStatus: {
          enabled: true,
          providerType: "gateway_inference",
          defaultModel: "k3",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [],
        },
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const quotaBlock = await screen.findByRole("status");
    expect(quotaBlock).toHaveTextContent("Inference quota exhausted");
    expect(quotaBlock).toHaveTextContent(/Quota resets in /);
    expect(quotaBlock).toHaveClass("bg-muted/40", "px-3", "py-3");
    expect(quotaBlock.querySelector(".font-medium")).toBeInTheDocument();
    expect(quotaBlock.querySelector(".text-muted-foreground")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask anything... (/ commands)")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(INFERENCE_SELF_USAGE_UPDATED_EVENT, { detail: exhaustedUsage })
      );
    });
    expect(screen.getByRole("button", { name: "System overview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expiring soon" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Health summary" })).toBeDisabled();
  });

  it("keeps the composer available at exactly 0.5% remaining", () => {
    const usage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": {
          configured: true,
          percentage: 99.5,
          recoveryAt: "2030-01-07T00:00:00.000Z",
        },
        "30d": {
          configured: false,
          percentage: 0,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    };

    expect(getInferenceQuotaState(usage).exhausted).toBe(false);
    expect(
      getInferenceQuotaState({
        ...usage,
        subscription: {
          ...usage.subscription,
          "7d": { ...usage.subscription["7d"], percentage: 99.5001 },
        },
      }).exhausted
    ).toBe(true);
  });

  it("does not request inference usage for an OpenAI-compatible chat", async () => {
    const getInferenceSelfUsage = vi.spyOn(api, "getInferenceSelfUsage");

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "inference:usage:view:self"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        providerStatus: {
          enabled: true,
          providerType: "openai_compatible",
          defaultModel: "",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [],
        },
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask anything... (/ commands)")).toBeInTheDocument()
    );

    expect(getInferenceSelfUsage).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders lite sidebar conversations and wires load and delete actions", async () => {
    const user = userEvent.setup();
    const fetchRecentConversations = vi.fn();
    const fetchConversationFolders = vi.fn();
    const loadConversation = vi.fn().mockResolvedValue(undefined);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "admin:groups"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [{ id: "message-1", role: "user", content: "hello" }],
        activeConversationId: "conversation-1",
        sidebarActiveConversationId: "conversation-1",
        recentConversations: [
          {
            id: "conversation-1",
            title: "Recent chat",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastUserMessageAt: new Date().toISOString(),
            folderId: null,
            messageCount: 3,
            status: "active",
            blockReason: null,
            activeRunStatus: null,
          },
        ],
        isLoadingRecentConversations: false,
        fetchRecentConversations,
        fetchConversationFolders,
        loadConversation,
        deleteConversation,
      });
      useUIStore.setState({ sidebarOpen: true });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>,
      { route: "/settings" }
    );

    expect(fetchRecentConversations).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Recent chat"));
    expect(loadConversation).toHaveBeenCalledWith("conversation-1");

    await user.hover(screen.getByText("Recent chat"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Recent chat" }));
    expect(deleteConversation).toHaveBeenCalledWith("conversation-1");

    await user.click(screen.getByRole("button", { name: /User One/i }));
    expect(await screen.findByText("Administration")).toBeInTheDocument();
  });

  it("clears the active lite sidebar conversation when starting a new chat", async () => {
    const user = userEvent.setup();
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [{ id: "message-1", role: "user", content: "hello" }],
        activeConversationId: "conversation-1",
        sidebarActiveConversationId: "conversation-1",
        recentConversations: [
          {
            id: "conversation-1",
            title: "Recent chat",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastUserMessageAt: new Date().toISOString(),
            folderId: null,
            messageCount: 3,
            status: "active",
            blockReason: null,
            activeRunStatus: null,
          },
        ],
        isLoadingRecentConversations: false,
        fetchRecentConversations: vi.fn(),
        fetchConversationFolders: vi.fn(),
      });
      useUIStore.setState({ sidebarOpen: true });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>
    );

    const conversationRow = screen.getByText("Recent chat").closest(".group");
    expect(conversationRow).toHaveClass("bg-sidebar-accent");

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: /New chat/ }));

    expect(useAIStore.getState().sidebarActiveConversationId).toBeNull();
    expect(conversationRow).not.toHaveClass("bg-sidebar-accent");
  });

  it("does not highlight a saved chat while the current chat draft is empty", () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        messages: [],
        activeConversationId: "conversation-1",
        sidebarActiveConversationId: "conversation-1",
        recentConversations: [
          {
            id: "conversation-1",
            title: "Recent chat",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastUserMessageAt: new Date().toISOString(),
            folderId: null,
            messageCount: 3,
            status: "active",
            blockReason: null,
            activeRunStatus: null,
          },
        ],
        isLoadingRecentConversations: false,
        fetchRecentConversations: vi.fn(),
        fetchConversationFolders: vi.fn(),
      });
      useUIStore.setState({ sidebarOpen: true });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>
    );

    expect(screen.getByText("Recent chat").closest(".group")).not.toHaveClass("bg-sidebar-accent");
  });

  it("hides lite sidebar administration link without admin access", async () => {
    const user = userEvent.setup();
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "viewer",
          scopes: ["feat:ai:use"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        recentConversations: [],
        isLoadingRecentConversations: false,
        fetchRecentConversations: vi.fn(),
        fetchConversationFolders: vi.fn(),
      });
      useUIStore.setState({ sidebarOpen: true });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>
    );

    await user.click(screen.getByRole("button", { name: /User One/i }));
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
  });
});
