import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
        recentConversations: [],
        isLoadingRecentConversations: false,
        activeConversationId: null,
        activeRunId: null,
        providerStatus: null,
        selectedModel: null,
        selectedReasoningEffort: null,
        contextUsageDialog: null,
      });
      useUIStore.setState({ aiPanelOpen: false, aiLiteMode: false, sidebarOpen: true });
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
      useConfirmDialog.getState().close();
    });
    localStorage.removeItem("gateway-ai-panel-width");
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

  it("uses a 360px minimum width for the normal side panel", async () => {
    localStorage.setItem("gateway-ai-panel-width", "320");
    act(() => {
      useAIStore.setState({
        messages: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        fetchRecentConversations: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const panelContent = screen.getByText("New chat").closest<HTMLDivElement>("div[style]");
    expect(panelContent).toHaveStyle({ width: "360px" });
  });

  it("loads and shows only the five most recent chats in an empty normal panel", async () => {
    const conversations = Array.from({ length: 6 }, (_, index) => ({
      id: `conversation-${index + 1}`,
      title: `Recent chat ${index + 1}`,
      createdAt: new Date(Date.now() - index * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      lastUserMessageAt: new Date(Date.now() - index * 60_000).toISOString(),
      folderId: null,
      messageCount: index + 1,
      status: "active" as const,
      blockReason: null,
      activeRunStatus: null,
    }));
    const fetchRecentConversations = vi.fn(async () => {
      useAIStore.setState({
        recentConversations: conversations,
        isLoadingRecentConversations: false,
      });
    });
    act(() => {
      useAIStore.setState({
        messages: [],
        recentConversations: [],
        isLoadingRecentConversations: false,
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        fetchRecentConversations,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    await waitFor(() => expect(fetchRecentConversations).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Recent chat 1")).toBeInTheDocument();
    expect(screen.getByText("Recent chat 5")).toBeInTheDocument();
    expect(screen.queryByText("Recent chat 6")).not.toBeInTheDocument();
  });

  it("groups chat actions in a menu and starts a new chat from the plus button", async () => {
    const user = userEvent.setup();
    const clearMessages = vi.fn();
    const togglePinnedAIConversation = vi.fn();
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        savedName: "Existing chat",
        activeConversationId: "conversation-1",
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        clearMessages,
      });
      useUIStore.setState({
        aiPanelOpen: true,
        aiLiteMode: false,
        pinnedAIConversationIds: [],
        togglePinnedAIConversation,
      });
    });

    renderAISidePanel();

    const header = screen.getByText("Existing chat").parentElement;
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Full screen", "New chat", "Chat actions", "Close AI Assistant"]);

    expect(screen.queryByRole("button", { name: "Pin chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete chat" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    expect(screen.getByRole("menuitem", { name: "Pin chat" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename chat" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete chat" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Pin chat" }));
    expect(togglePinnedAIConversation).toHaveBeenCalledWith("conversation-1");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(clearMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps chat actions available for a new draft and disables only persisted actions", async () => {
    const user = userEvent.setup();
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Unsaved draft" }],
        savedName: null,
        activeConversationId: null,
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const actions = screen.getByRole("button", { name: "Chat actions" });
    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(actions).toBeEnabled();
    expect(newChat).toBeEnabled();
    await user.click(actions);

    expect(screen.getByRole("menuitem", { name: "Pin chat" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Rename chat" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Delete chat" })).toHaveAttribute("data-disabled");
  });

  it("attaches the slash command palette directly to the composer", async () => {
    const user = userEvent.setup();
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        activeConversationId: "conversation-1",
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    await user.type(screen.getByPlaceholderText("Ask anything... (/ commands)"), "/");
    const newCommand = await screen.findByRole("button", {
      name: "/new Start new conversation",
    });

    expect(newCommand.parentElement).toHaveClass("bottom-full", "-mb-px");
    expect(newCommand.parentElement).toHaveClass("border-x-0");
    expect(newCommand.parentElement).not.toHaveStyle({ bottom: "calc(100% + 8px)" });
  });

  it("renders context usage in a modal instead of the message list", async () => {
    const user = userEvent.setup();
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        activeConversationId: "conversation-1",
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        contextUsageDialog: {
          messageCount: 1,
          estimatedTokens: 207,
          limit: 1000,
          percent: 21,
          chatTokens: 7,
          systemTokens: 120,
          toolsTokens: 80,
          overheadTokens: 200,
          toolCount: 3,
          systemBreakdown: [{ label: "Base instructions", chars: 480, tokens: 120 }],
          toolBreakdown: [{ label: "Discovery", chars: 320, tokens: 80 }],
          source: "server",
          reasoningEffort: "low",
        },
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    expect(screen.getByRole("heading", { name: "Context usage" })).toBeInTheDocument();
    expect(screen.getByText("207 / 1,000 (21%)")).toBeInTheDocument();
    expect(screen.getByText("~7 tokens · 1 message")).toBeInTheDocument();
    expect(screen.getByText("Base instructions")).toBeInTheDocument();
    expect(screen.getByText("Discovery")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(useAIStore.getState().contextUsageDialog).toBeNull();
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

  it("warns before changing the model of an existing conversation", async () => {
    const user = userEvent.setup();
    const setSelectedModel = vi.fn().mockResolvedValue(undefined);
    const providerStatus = {
      enabled: true,
      providerType: "gateway_inference" as const,
      defaultModel: "model-a",
      allowUserModelSelection: true,
      supportsImages: false,
      models: [
        {
          id: "model-a",
          displayName: "Model A",
          supportsImages: false,
          maxContextTokens: 1000,
          maxOutputTokens: null,
          reasoningEfforts: ["high"],
          defaultReasoningEffort: "high",
        },
        {
          id: "model-b",
          displayName: "Model B",
          supportsImages: false,
          maxContextTokens: 1000,
          maxOutputTokens: null,
          reasoningEfforts: ["max"],
          defaultReasoningEffort: "max",
        },
      ],
    };
    vi.spyOn(api, "getAIStatus").mockResolvedValue(providerStatus);
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        activeConversationId: "conversation-1",
        connect: vi.fn().mockResolvedValue(true),
        providerStatus,
        selectedModel: "model-a",
        selectedReasoningEffort: "high",
        setSelectedModel,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();
    await user.click(screen.getByRole("button", { name: "AI model" }));
    await user.click(await screen.findByText("Model B"));

    expect(useConfirmDialog.getState()).toMatchObject({
      open: true,
      title: "Change model?",
      description:
        "Changing the model during a conversation may increase costs and reduce performance.",
    });
    expect(setSelectedModel).not.toHaveBeenCalled();

    act(() => {
      useConfirmDialog.getState().onConfirm?.();
    });
    await waitFor(() => expect(setSelectedModel).toHaveBeenCalledWith("model-b"));
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
