import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { INFERENCE_SELF_USAGE_UPDATED_EVENT } from "@/lib/inference-self-usage";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useUIStore } from "@/stores/ui";
import { renderWithRouter } from "@/test/render";
import type { AIMessage, AIPlanRuntimeSnapshot } from "@/types/ai";
import { AILitePanel } from "./AILitePanel";
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

function LocationProbe() {
  return <span data-testid="location-path">{useLocation().pathname}</span>;
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

function planInProgress(status: "drafting" | "validating"): AIPlanRuntimeSnapshot {
  return {
    id: "plan-1",
    conversationId: "conversation-1",
    revisionId: "revision-1",
    revision: 1,
    revisionStatus: "validating",
    publishedAt: null,
    timelineAnchorAt: "2026-08-12T00:01:00.000Z",
    acceptedAt: null,
    status,
    title: "Implementation plan",
    model: "test-model",
    reasoningEffort: "medium",
    goal: "Implement and verify the request.",
    scope: [],
    assumptions: [],
    steps: [],
    research: [],
    intentReview: null,
    securityReview: null,
    verification: [],
    changeSummary: null,
    noProgressRuns: 0,
    activeTimeMs: 0,
    activeSince: null,
    pauseReason: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

describe("AISidePanel autoscroll", () => {
  afterEach(() => {
    act(() => {
      useAIStore.setState({
        messages: [],
        isConnected: false,
        isStreaming: false,
        isStartingConversation: false,
        retryAfter: null,
        recentConversations: [],
        isLoadingRecentConversations: false,
        activeConversationId: null,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        connectionError: null,
        canContinueConversation: false,
        providerStatus: null,
        selectedModel: null,
        selectedReasoningEffort: null,
        contextUsageDialog: null,
      });
      useUIStore.setState({ aiPanelOpen: false, aiLiteMode: false, sidebarOpen: true });
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
      useDashboardBootstrapStore.getState().clear();
      usePinnedNodesStore.setState({ dashboardNodeIds: [], sidebarNodeIds: [] });
      useResolvedPageContext.setState({ routeKey: null, status: "idle", resource: null });
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

  it("uses the responsive default when the stored width is below the minimum", async () => {
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

    const panelContent = screen.getByText("New Work Session").closest<HTMLDivElement>("div[style]");
    expect(panelContent).toHaveStyle({ width: "410px" });
  });

  it("shows the starting title shimmer and Thinking before a new chat snapshot arrives", () => {
    act(() => {
      useAIStore.setState({
        messages: [
          {
            id: "starting:command-1:user",
            role: "user",
            content: "Check Docker",
            localOnly: true,
          },
          {
            id: "starting:command-1:assistant",
            role: "assistant",
            content: "",
            isStreaming: true,
          },
        ],
        isConnected: true,
        isStreaming: true,
        isStartingConversation: true,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        fetchRecentConversations: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    expect(screen.getByText("Starting Work Session...")).toHaveClass(
      "thinking-shimmer",
      "text-muted-foreground"
    );
    const log = screen.getByRole("log", { name: "AI messages" });
    expect(within(log).getByText("Check Docker")).toBeInTheDocument();
    expect(within(log).getByText("Thinking")).toBeInTheDocument();
    expect(log.textContent?.indexOf("Check Docker")).toBeLessThan(
      log.textContent?.indexOf("Thinking") ?? -1
    );
  });

  it("shows an active resume action for an interrupted turn and switches to send after typing", async () => {
    const user = userEvent.setup();
    const continueConversation = vi.fn();
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Finish checking Docker" }],
        activeConversationId: "conversation-1",
        savedName: "Docker check",
        isConnected: true,
        isStreaming: false,
        isStartingConversation: false,
        canContinueConversation: true,
        retryAfter: null,
        continueConversation,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        fetchRecentConversations: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const resume = screen.getByRole("button", { name: "Continue response" });
    expect(resume).toHaveClass("text-foreground");
    await user.click(resume);
    expect(continueConversation).toHaveBeenCalledTimes(1);

    await user.type(
      screen.getByPlaceholderText("Ask anything... (/ commands)"),
      "Use another check"
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue response" })).not.toBeInTheDocument();
  });

  it("does not show the Lite workspace disclaimer in the regular side panel", () => {
    act(() => {
      useAIStore.setState({
        messages: [
          {
            id: "assistant-approval",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tool-approval",
                name: "remove_docker_container",
                arguments: { containerId: "container-1" },
                status: "awaiting_approval",
              },
            ],
          },
        ],
        activeConversationId: "conversation-1",
        activeRunId: "run-1",
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        fetchRecentConversations: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    expect(
      screen.queryByText("AI can make mistakes. Check important information.")
    ).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("AI is responding...")).not.toBeInTheDocument();
  });

  it("focuses the composer when a new chat opens", async () => {
    act(() => {
      useAIStore.setState({
        messages: [],
        activeConversationId: null,
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

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask anything... (/ commands)")).toHaveFocus()
    );
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
    ).toEqual([
      "Open in AI Workspace",
      "New Work Session",
      "Work Session actions",
      "Close AI Workspace",
    ]);

    expect(screen.queryByRole("button", { name: "Pin Work Session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename Work Session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Work Session" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Work Session actions" }));
    expect(screen.getByRole("menuitem", { name: "Pin Work Session" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename Work Session" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete Work Session" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Pin Work Session" }));
    expect(togglePinnedAIConversation).toHaveBeenCalledWith("conversation-1");

    await user.click(screen.getByRole("button", { name: "New Work Session" }));
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

    const actions = screen.getByRole("button", { name: "Work Session actions" });
    const newChat = screen.getByRole("button", { name: "New Work Session" });
    expect(actions).toBeEnabled();
    expect(newChat).toBeEnabled();
    await user.click(actions);

    expect(screen.getByRole("menuitem", { name: "Pin Work Session" })).toHaveAttribute(
      "data-disabled"
    );
    expect(screen.getByRole("menuitem", { name: "Rename Work Session" })).toHaveAttribute(
      "data-disabled"
    );
    expect(screen.getByRole("menuitem", { name: "Delete Work Session" })).toHaveAttribute(
      "data-disabled"
    );
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
      name: "/new Start new Work Session",
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

  it("requests AI Workspace without changing the current session locally", () => {
    const onOpenAIWorkspace = vi.fn();
    window.addEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);
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

    fireEvent.click(screen.getByRole("button", { name: "Open in AI Workspace" }));

    expect(onOpenAIWorkspace).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().aiLiteMode).toBe(false);
    expect(useUIStore.getState().aiPanelOpen).toBe(true);
    window.removeEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);
  });

  it("shows resolved page context and can exclude it from the next request", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    const route = "/docker/containers/docker-src/api";
    act(() => {
      useAIStore.setState({
        messages: [],
        activeConversationId: "conversation-1",
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
        connect: vi.fn().mockResolvedValue(true),
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        sendMessage,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
      useResolvedPageContext.setState({
        routeKey: route,
        status: "ready",
        resource: {
          resourceType: "docker-container",
          resourceId: "api",
          nodeId: "node-1",
          label: "api",
        },
      });
    });

    renderWithRouter(
      <TooltipProvider>
        <AISidePanel />
      </TooltipProvider>,
      { route }
    );

    expect(screen.getByText("Viewing api")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Exclude this resource from the next request" })
    );
    await user.type(screen.getByPlaceholderText("Ask anything... (/ commands)"), "Inspect it");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith("Inspect it", { route }, [], {
      startNewConversation: true,
    });
    expect(await screen.findByText("Viewing api")).toBeInTheDocument();
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

  it("keeps the composer visible after an approved tool starts running", () => {
    act(() => {
      useAIStore.setState({
        messages: [
          assistantMessage([
            {
              id: "tool-1",
              name: "run_process",
              arguments: { command: ["sh", "-lc", "pwd"] },
              status: "running",
              approvalPolicy: "requires_approval",
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

  it("renders a durable-round question next to the composer instead of in message history", () => {
    act(() => {
      useAIStore.setState({
        messages: [
          assistantMessage([
            {
              id: "question-1",
              runId: "run-1",
              roundId: "round-1",
              position: 0,
              name: "ask_question",
              arguments: { question: "Create the container?", options: ["Yes", "No"] },
              status: "awaiting_approval",
            },
          ]),
        ],
        activeConversationId: "conversation-1",
        activeRunId: "run-1",
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const log = screen.getByRole("log", { name: "AI messages" });
    expect(within(log).queryByText("Create the container?")).not.toBeInTheDocument();
    expect(screen.getByText("Create the container?")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask anything... (/ commands)")).not.toBeInTheDocument();
  });

  it("replaces the composer with the plan decision question", () => {
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Prepare a plan" }],
        activeConversationId: "conversation-1",
        activePlan: {
          id: "plan-1",
          conversationId: "conversation-1",
          revisionId: "revision-1",
          revision: 1,
          revisionStatus: "published",
          publishedAt: "2026-08-12T00:01:00.000Z",
          timelineAnchorAt: "2026-08-12T00:01:00.000Z",
          acceptedAt: null,
          status: "awaiting_decision",
          title: "Implementation plan",
          model: "test-model",
          reasoningEffort: "medium",
          goal: "Implement and verify the request.",
          scope: [],
          assumptions: [],
          steps: [],
          research: [],
          intentReview: null,
          securityReview: null,
          verification: [],
          changeSummary: null,
          noProgressRuns: 0,
          activeTimeMs: 0,
          activeSince: null,
          pauseReason: null,
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        } satisfies AIPlanRuntimeSnapshot,
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    expect(screen.getByText("Implement this plan?")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask anything... (/ commands)")).not.toBeInTheDocument();
    const freeText = screen.getByPlaceholderText("Or type your answer...");
    expect(freeText).toHaveClass("border-0", "focus:ring-inset");
    expect(freeText.parentElement?.parentElement).toHaveClass("border-t", "border-border");
    expect(freeText.parentElement?.parentElement).not.toHaveClass("px-3", "py-2");
  });

  it.each([
    "drafting",
    "validating",
  ] as const)("shows the cancellation recovery control during %s in both assistant panels", (status) => {
    act(() => {
      useAIStore.setState({
        messages: [{ id: "user-1", role: "user", content: "Prepare a plan" }],
        activeConversationId: "conversation-1",
        activePlan: planInProgress(status),
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        fetchRecentConversations: vi.fn().mockResolvedValue(undefined),
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    const sidePanel = renderAISidePanel();
    const litePanel = renderWithRouter(
      <TooltipProvider>
        <AILitePanel />
      </TooltipProvider>
    );

    for (const panel of [sidePanel.container, litePanel.container]) {
      expect(
        within(panel).getByText(status === "drafting" ? "Preparing plan" : "Validating plan")
      ).toBeInTheDocument();
      expect(within(panel).getByRole("button", { name: "Cancel plan" })).toBeInTheDocument();
      expect(within(panel).queryByRole("button", { name: "Pause plan" })).not.toBeInTheDocument();
    }
  });

  it("renders a durable-round approval next to the composer instead of in message history", () => {
    act(() => {
      useAIStore.setState({
        messages: [
          assistantMessage([
            {
              id: "approval-1",
              runId: "run-1",
              roundId: "round-1",
              position: 0,
              name: "restart_docker_container",
              arguments: { containerId: "container-1" },
              status: "awaiting_approval",
              approvalPolicy: "requires_approval",
            },
          ]),
        ],
        activeConversationId: "conversation-1",
        activeRunId: "run-1",
        isConnected: true,
        isStreaming: true,
        retryAfter: null,
      });
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
    });

    renderAISidePanel();

    const log = screen.getByRole("log", { name: "AI messages" });
    expect(within(log).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask anything... (/ commands)")).not.toBeInTheDocument();
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
          scopes: ["feat:ai:use"],
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
          scopes: ["feat:ai:use"],
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
          scopes: ["feat:ai:use"],
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
          scopes: ["feat:ai:use"],
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
    expect(loadConversation).not.toHaveBeenCalled();

    await user.hover(screen.getByText("Recent chat"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Recent chat" }));
    expect(deleteConversation).toHaveBeenCalledWith("conversation-1");

    await user.click(screen.getByRole("button", { name: /User One/i }));
    expect(await screen.findByText("Administration")).toBeInTheDocument();
  });

  it("keeps the stop impersonating footer action available in expanded and collapsed lite modes", () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "member",
          scopes: ["feat:ai:use"],
          isBlocked: true,
          impersonation: {
            active: true,
            actor: { id: "admin-1", email: "admin@example.com", name: "System Admin" },
          },
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        recentConversations: [],
        conversationFolders: [],
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

    expect(screen.getByRole("button", { name: "Stop impersonating" })).toBeInTheDocument();

    act(() => useUIStore.setState({ sidebarOpen: false }));

    expect(screen.getByRole("button", { name: "Stop impersonating" })).toBeInTheDocument();
  });

  it("preserves lite sidebar row geometry and refreshes hover after deletion", async () => {
    const timestamp = new Date().toISOString();
    const deleteConversation = vi.fn(async (conversationId: string) => {
      useAIStore.setState((state) => ({
        recentConversations: state.recentConversations.filter(
          (conversation) => conversation.id !== conversationId
        ),
      }));
    });
    const conversations = ["First chat", "Second chat"].map((title, index) => ({
      id: `conversation-${index + 1}`,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUserMessageAt: timestamp,
      folderId: null,
      messageCount: 1,
      status: "active" as const,
      blockReason: null,
      activeRunStatus: null,
    }));

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
        recentConversations: conversations,
        conversationFolders: [],
        isLoadingRecentConversations: false,
        fetchRecentConversations: vi.fn(),
        fetchConversationFolders: vi.fn(),
        deleteConversation,
      });
      useUIStore.setState({ sidebarOpen: true });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>
    );

    const firstRow = screen.getByText("First chat").closest(".group") as HTMLElement;
    const secondRowBefore = screen.getByText("Second chat").closest(".group") as HTMLElement;
    vi.spyOn(secondRowBefore, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 260,
      top: 0,
      bottom: 36,
    } as DOMRect);
    const secondDateBefore = within(secondRowBefore).getByText("now");
    const firstTitleButton = screen.getByText("First chat").closest("button");
    expect(firstTitleButton).toHaveClass("pr-1");
    expect(firstTitleButton).not.toHaveClass("pr-20");

    fireEvent.mouseEnter(firstRow);
    const firstDelete = screen.getByRole("button", { name: "Delete First chat" });
    expect(firstDelete).toHaveClass("h-6", "w-6");

    fireEvent.click(firstDelete, { clientX: 100, clientY: 18, detail: 1 });

    await waitFor(() => expect(screen.queryByText("First chat")).not.toBeInTheDocument());
    const secondRowAfter = screen.getByText("Second chat").closest(".group") as HTMLElement;
    await waitFor(() => expect(secondDateBefore).not.toBeInTheDocument());
    expect(within(secondRowAfter).queryByText("now")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Second chat" })).toBeInTheDocument();
  });

  it("shows Dashboard, shared navigation, and Sidebar-pinned resources in lite mode", async () => {
    const user = userEvent.setup();
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "nodes:details"],
          isBlocked: false,
        } as any,
        isAuthenticated: true,
        isLoading: false,
      });
      useUIStore.setState({ sidebarOpen: true });
      usePinnedNodesStore.setState({ sidebarNodeIds: ["node-1"] });
      useDashboardBootstrapStore.setState({
        snapshot: {
          attention: { severity: "warning", notices: [] },
          pinned: {
            dashboard: { nodes: [], proxies: [], databases: [], dockerResources: [] },
            sidebar: {
              nodes: [
                {
                  id: "node-1",
                  slug: "edge-1",
                  hostname: "edge-1",
                  displayName: "Edge node",
                  status: "online",
                },
              ],
              proxies: [],
              databases: [],
              dockerResources: [],
            },
          },
        } as any,
      });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>,
      { route: "/" }
    );

    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /edge node/i })).toHaveAttribute(
      "href",
      "/nodes/edge-1"
    );
    expect((screen.getByPlaceholderText("Search...") as HTMLInputElement).readOnly).toBe(true);
    await user.click(screen.getByRole("button", { name: "All sections" }));
    expect(await screen.findByRole("menuitem", { name: "Nodes" })).toBeInTheDocument();
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
        clearMessages: vi.fn(() => {
          useAIStore.setState({
            messages: [],
            activeConversationId: null,
            sidebarActiveConversationId: null,
          });
        }),
      });
      useUIStore.setState({ sidebarOpen: true });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
        <LocationProbe />
      </TooltipProvider>,
      { route: "/ai/chats/conversation-1" }
    );

    const conversationRow = screen.getByText("Recent chat").closest(".group");
    expect(conversationRow).toHaveClass("bg-sidebar-accent");

    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("menuitem", { name: /New Work Session/ }));

    expect(useAIStore.getState().sidebarActiveConversationId).toBeNull();
    expect(useAIStore.getState().activeConversationId).toBeNull();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/");
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

  it("shows a shimmering starting chat item in the lite sidebar", () => {
    act(() => {
      useAIStore.setState({
        messages: [],
        recentConversations: [],
        isStartingConversation: true,
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

    expect(screen.getByText("Starting Work Session...")).toHaveClass(
      "thinking-shimmer",
      "text-muted-foreground"
    );
    expect(screen.queryByText("New Work Session")).not.toBeInTheDocument();
  });

  it("shows run status icons for chats in the collapsed lite sidebar", () => {
    const timestamp = new Date().toISOString();
    act(() => {
      useAIStore.setState({
        messages: [],
        recentConversations: [
          {
            id: "conversation-running",
            title: "Running chat",
            createdAt: timestamp,
            updatedAt: timestamp,
            lastUserMessageAt: timestamp,
            folderId: null,
            messageCount: 1,
            status: "active",
            blockReason: null,
            activeRunStatus: "running",
          },
          {
            id: "conversation-waiting",
            title: "Waiting chat",
            createdAt: timestamp,
            updatedAt: timestamp,
            lastUserMessageAt: timestamp,
            folderId: null,
            messageCount: 1,
            status: "active",
            blockReason: null,
            activeRunStatus: "waiting_for_approval",
          },
          {
            id: "conversation-plan",
            title: "Plan awaiting decision",
            createdAt: timestamp,
            updatedAt: timestamp,
            lastUserMessageAt: timestamp,
            folderId: null,
            messageCount: 1,
            status: "active",
            blockReason: null,
            activeRunStatus: null,
            planStatus: "awaiting_decision",
          },
        ],
        isStartingConversation: false,
        isLoadingRecentConversations: false,
        fetchRecentConversations: vi.fn(),
        fetchConversationFolders: vi.fn(),
      });
      useUIStore.setState({ sidebarOpen: false });
    });

    renderWithRouter(
      <TooltipProvider>
        <AILiteSidebar />
      </TooltipProvider>
    );

    expect(
      within(screen.getByRole("button", { name: "Running chat" })).getByRole("progressbar", {
        name: "Running chat in progress",
      })
    ).toHaveClass("animate-spin", "text-primary");
    expect(screen.getByRole("button", { name: "Waiting chat" }).querySelector("svg")).toHaveClass(
      "text-warning-foreground"
    );
    expect(
      screen.getByRole("button", { name: "Plan awaiting decision" }).querySelector("svg")
    ).toHaveClass("text-warning-foreground");
  });
});
