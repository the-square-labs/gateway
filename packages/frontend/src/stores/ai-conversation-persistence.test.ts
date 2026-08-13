import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConversation,
  listConversations,
  rollbackConversationToMessage,
  updateConversationProvider,
} from "@/services/ai-conversations";
import { api } from "@/services/api";
import { getAIContextUsage, resetAIStateForAuthChange, useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import type { AIPlanRuntimeSnapshot, WSServerMessage } from "@/types/ai";

vi.mock("@/services/ai-conversations", () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
  rollbackConversationToMessage: vi.fn(),
  updateConversationProvider: vi.fn(),
}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();

  constructor() {
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(message: WSServerMessage | { type: "auth_ok" }) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function setAuthenticatedUser() {
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
}

async function connectAI() {
  vi.stubGlobal("WebSocket", MockWebSocket);
  setAuthenticatedUser();
  vi.spyOn(api, "getAIStatus").mockResolvedValue({
    enabled: true,
    providerType: "openai_compatible",
    defaultModel: "test-model",
    allowUserModelSelection: false,
    supportsImages: false,
    models: [],
  });

  const connectPromise = useAIStore.getState().connect();
  const socket = MockWebSocket.instances[0];
  socket.emit({ type: "auth_ok" });
  await connectPromise;
  return socket;
}

function sentPayloads(socket: MockWebSocket): Array<Record<string, unknown>> {
  return vi.mocked(socket.send).mock.calls.map(([payload]) => JSON.parse(String(payload)));
}

function getToolCall(toolCallId: string) {
  return useAIStore
    .getState()
    .messages.flatMap((message) => message.toolCalls ?? [])
    .find((toolCall) => toolCall.id === toolCallId);
}

function runtimeRun(
  status:
    | "queued"
    | "running"
    | "waiting_for_approval"
    | "waiting_for_answer"
    | "waiting_for_credential"
) {
  return {
    id: "run-1",
    conversationId: "conversation-1",
    userId: "user-1",
    status,
    activeMessageId: "assistant-1",
    clientCommandId: "command-1",
    assistantDraftContent: null,
    error: null,
    startedAt: "2026-06-26T10:00:00.000Z",
    completedAt: null,
    stoppedAt: null,
    createdAt: "2026-06-26T10:00:00.000Z",
    updatedAt: "2026-06-26T10:00:01.000Z",
  };
}

function planSnapshot(overrides: Partial<AIPlanRuntimeSnapshot> = {}): AIPlanRuntimeSnapshot {
  return {
    id: "plan-1",
    conversationId: "conversation-1",
    status: "awaiting_decision",
    title: "Verified plan",
    model: "test-model",
    reasoningEffort: "medium",
    revisionId: "revision-1",
    revision: 1,
    revisionStatus: "published",
    publishedAt: "2026-08-12T00:01:00.000Z",
    timelineAnchorAt: "2026-08-12T00:01:00.000Z",
    acceptedAt: null,
    goal: "Previously verified plan",
    scope: [],
    assumptions: [],
    research: [],
    intentReview: null,
    securityReview: null,
    verification: [],
    changeSummary: null,
    steps: [],
    noProgressRuns: 0,
    activeTimeMs: 0,
    activeSince: null,
    pauseReason: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:01:00.000Z",
    ...overrides,
  };
}

describe("AI backend runtime store", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAIStateForAuthChange();
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    useUIStore.setState({
      aiApprovalMode: "normal",
    });
    MockWebSocket.instances = [];
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("restarts a failed initial connection and clears the transient error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    setAuthenticatedUser();
    vi.spyOn(api, "getAIStatus").mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      defaultModel: "test-model",
      allowUserModelSelection: false,
      supportsImages: false,
      models: [],
    });

    const firstConnect = useAIStore.getState().connect();
    MockWebSocket.instances[0].onerror?.();
    await firstConnect;

    expect(useAIStore.getState().connectionError).toBe("Reconnecting...");

    await vi.advanceTimersByTimeAsync(5_000);
    const replacement = MockWebSocket.instances.at(-1)!;
    replacement.emit({ type: "auth_ok" });
    await vi.advanceTimersByTimeAsync(0);

    expect(useAIStore.getState()).toMatchObject({
      isConnected: true,
      connectionError: null,
    });
  });

  it("sends user turns through the backend-owned runtime socket command", async () => {
    const socket = await connectAI();

    useAIStore.getState().sendMessage("hello");

    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.send_message",
          content: "hello",
        }),
      ])
    );
  });

  it("keeps an unverified refinement out of the plan timeline during live updates", async () => {
    const socket = await connectAI();
    const publishedPlan = planSnapshot();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activePlan: publishedPlan,
      plans: [publishedPlan],
    });

    socket.emit({
      type: "plan.status_changed",
      conversationId: "conversation-1",
      plan: planSnapshot({
        status: "validating",
        revisionId: "revision-2",
        revision: 2,
        revisionStatus: "validating",
        publishedAt: null,
        goal: "Unverified refinement",
      }),
    });

    expect(useAIStore.getState().activePlan).toMatchObject({
      revisionId: "revision-2",
      goal: "Unverified refinement",
    });
    expect(useAIStore.getState().plans).toEqual([publishedPlan]);

    socket.emit({
      type: "plan.status_changed",
      conversationId: "conversation-1",
      plan: planSnapshot({
        revisionId: "revision-2",
        revision: 2,
        publishedAt: "2026-08-12T00:05:00.000Z",
        goal: "Verified refinement",
      }),
    });

    expect(useAIStore.getState().plans).toEqual([
      expect.objectContaining({ revisionId: "revision-2", goal: "Verified refinement" }),
    ]);
  });

  it("continues an interrupted run without adding a user message", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      messages: [{ id: "user-1", role: "user", content: "Check Docker" }],
      activeConversationId: "conversation-1",
      activeRunId: null,
      canContinueConversation: true,
      isStreaming: false,
      lastContext: { route: "/nodes" },
    });

    useAIStore.getState().continueConversation({ route: "/docker/containers" });

    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.continue",
          conversationId: "conversation-1",
          context: { route: "/docker/containers" },
        }),
      ])
    );
    expect(useAIStore.getState()).toMatchObject({
      messages: [{ id: "user-1", role: "user", content: "Check Docker" }],
      canContinueConversation: false,
      isStreaming: true,
    });
  });

  it("restores the model and reasoning pinned to a saved conversation", async () => {
    vi.mocked(getConversation).mockResolvedValue({
      id: "conversation-1",
      title: "Pinned chat",
      messages: [],
      model: "model-b",
      reasoningEffort: "max",
      lastContext: null,
      createdAt: "2026-06-26T10:00:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
      lastUserMessageAt: null,
      folderId: null,
      status: "active",
      blockReason: null,
      activeRunStatus: null,
    });
    useAIStore.setState({
      providerStatus: {
        enabled: true,
        providerType: "gateway_inference",
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
      },
      selectedModel: "model-a",
      selectedReasoningEffort: "high",
    });

    await useAIStore.getState().loadConversation("conversation-1");

    expect(useAIStore.getState()).toMatchObject({
      selectedModel: "model-b",
      selectedReasoningEffort: "max",
    });
  });

  it("persists a model change and applies the returned timeline delimiter", async () => {
    vi.mocked(updateConversationProvider).mockResolvedValue({
      id: "conversation-1",
      title: "Pinned chat",
      messages: [
        {
          id: "model-change-1",
          role: "assistant",
          content: "",
          localOnly: true,
          modelChange: {
            fromModel: "model-a",
            toModel: "model-b",
            fromDisplayName: "Model A",
            toDisplayName: "Model B",
          },
        },
      ],
      model: "model-b",
      reasoningEffort: "max",
      lastContext: null,
      createdAt: "2026-06-26T10:00:00.000Z",
      updatedAt: "2026-06-26T10:00:01.000Z",
      lastUserMessageAt: null,
      folderId: null,
      status: "active",
      blockReason: null,
      activeRunStatus: null,
    });
    useAIStore.setState({
      activeConversationId: "conversation-1",
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      providerStatus: {
        enabled: true,
        providerType: "gateway_inference",
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
      },
      selectedModel: "model-a",
      selectedReasoningEffort: "high",
    });

    await useAIStore.getState().setSelectedModel("model-b");

    expect(updateConversationProvider).toHaveBeenCalledWith("conversation-1", {
      model: "model-b",
      reasoningEffort: "max",
    });
    expect(useAIStore.getState().messages[0]?.modelChange).toEqual({
      fromModel: "model-a",
      toModel: "model-b",
      fromDisplayName: "Model A",
      toDisplayName: "Model B",
    });
  });

  it("sends the selected model only for Gateway Inference", async () => {
    const socket = await connectAI();
    const models = [
      {
        id: "gateway-default",
        displayName: "Gateway Default",
        supportsImages: false,
        maxContextTokens: 100_000,
        maxOutputTokens: 16_000,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
      {
        id: "gateway-fast",
        displayName: "Gateway Fast",
        supportsImages: false,
        maxContextTokens: 80_000,
        maxOutputTokens: 8_000,
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
      },
    ];

    useAIStore.getState().setProviderStatus({
      enabled: true,
      providerType: "gateway_inference",
      defaultModel: "gateway-default",
      allowUserModelSelection: true,
      supportsImages: false,
      models,
    });
    useAIStore.getState().setSelectedModel("gateway-fast");
    useAIStore.getState().setSelectedReasoningEffort("max");
    useAIStore.getState().sendMessage("use gateway");

    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.send_message",
          content: "use gateway",
          model: "gateway-fast",
          reasoningEffort: "max",
        }),
      ])
    );

    useAIStore.getState().setProviderStatus({
      enabled: true,
      providerType: "openai_compatible",
      defaultModel: "oai-model",
      allowUserModelSelection: false,
      supportsImages: false,
      models: [],
    });
    useAIStore.setState({ isStreaming: false });
    useAIStore.getState().sendMessage("use oai");

    const oaiPayload = sentPayloads(socket).find((payload) => payload.content === "use oai");
    expect(oaiPayload).not.toHaveProperty("model");
    expect(oaiPayload).not.toHaveProperty("reasoningEffort");
  });

  it("reports context usage with server-estimated prompt and tool overhead", async () => {
    const socket = await connectAI();
    const estimateSpy = vi.spyOn(api, "getAIContextEstimate").mockResolvedValueOnce({
      systemTokens: 120,
      toolsTokens: 80,
      totalOverhead: 200,
      limit: 1000,
      reasoningEffort: "low",
      toolCount: 3,
      systemBreakdown: [{ label: "Base instructions", chars: 480, tokens: 120 }],
      toolBreakdown: [{ label: "Discovery", chars: 320, tokens: 80 }],
    });
    useAIStore.setState({
      activeConversationId: "11111111-1111-4111-8111-111111111111",
      lastContext: {
        route: "/docker/containers/container-1",
        resourceType: "docker container",
        resourceId: "container-1",
      },
      messages: [
        { id: "message-1", role: "user", content: "hello world" },
        { id: "local-1", role: "assistant", content: "local note", localOnly: true },
      ],
    });

    const handled = await useAIStore.getState().handleSlashCommand("/context");

    expect(handled).toBe(true);
    expect(estimateSpy).toHaveBeenCalledWith({
      context: {
        route: "/docker/containers/container-1",
        resourceType: "docker container",
        resourceId: "container-1",
      },
      conversationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(sentPayloads(socket)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "conversation.send_message" })])
    );
    expect(useAIStore.getState().messages).toHaveLength(2);
    expect(useAIStore.getState().contextUsageDialog).toMatchObject({
      estimatedTokens: 207,
      limit: 1000,
      percent: 21,
      chatTokens: 7,
      systemTokens: 120,
      toolsTokens: 80,
      toolCount: 3,
      systemBreakdown: [{ label: "Base instructions", chars: 480, tokens: 120 }],
      toolBreakdown: [{ label: "Discovery", chars: 320, tokens: 80 }],
    });
  });

  it("reports context usage after the backend deterministic message trim", async () => {
    vi.spyOn(api, "getAIContextEstimate").mockResolvedValueOnce({
      systemTokens: 100,
      toolsTokens: 100,
      totalOverhead: 200,
      limit: 260,
      reasoningEffort: "low",
      toolCount: 3,
      systemBreakdown: [],
      toolBreakdown: [],
    });

    const usage = await getAIContextUsage(
      [
        { id: "old-user", role: "user", content: "old ".repeat(400) },
        { id: "old-assistant", role: "assistant", content: "old answer ".repeat(400) },
        { id: "latest-user", role: "user", content: "latest question" },
      ],
      undefined,
      "11111111-1111-4111-8111-111111111111"
    );

    expect(usage.messageCount).toBe(1);
    expect(usage.chatTokens).toBe(8);
    expect(usage.estimatedTokens).toBe(208);
    expect(usage.percent).toBe(80);
  });

  it("refreshes all recent conversations without blanking an existing sidebar list", async () => {
    setAuthenticatedUser();
    useAIStore.setState({
      recentConversations: [
        {
          id: "existing-conversation",
          title: "Existing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUserMessageAt: new Date().toISOString(),
          folderId: null,
          messageCount: 1,
          status: "active",
          blockReason: null,
          activeRunStatus: null,
        },
      ],
      isLoadingRecentConversations: false,
    });

    let resolveList: (value: Awaited<ReturnType<typeof listConversations>>) => void = () => {};
    vi.mocked(listConversations).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );

    const fetchPromise = useAIStore.getState().fetchRecentConversations();
    expect(useAIStore.getState().isLoadingRecentConversations).toBe(false);
    expect(listConversations).toHaveBeenCalledWith();

    const conversations = Array.from({ length: 6 }, (_, index) => ({
      id: `conversation-${index + 1}`,
      title: `Conversation ${index + 1}`,
      createdAt: new Date(2026, 0, index + 1).toISOString(),
      updatedAt: new Date(2026, 0, index + 1).toISOString(),
      lastUserMessageAt: new Date(2026, 0, index + 1).toISOString(),
      folderId: null,
      messageCount: index + 1,
      status: "active" as const,
      blockReason: null,
      activeRunStatus: null,
    }));

    resolveList(conversations);
    await fetchPromise;

    expect(useAIStore.getState().recentConversations).toHaveLength(6);
  });

  it("starts an empty quick action in a new backend conversation instead of replacing the previous chat", async () => {
    const socket = await connectAI();

    useAIStore.setState({
      messages: [],
      activeConversationId: "old-conversation",
      sidebarActiveConversationId: "old-conversation",
      savedName: "Old conversation",
      lastContext: null,
    });

    useAIStore.getState().sendMessage("Give me an overview of the system status", undefined, [], {
      startNewConversation: true,
    });

    const payload = sentPayloads(socket).find((item) => item.type === "conversation.send_message");
    expect(payload).toMatchObject({
      content: "Give me an overview of the system status",
    });
    expect(payload).not.toHaveProperty("conversationId", "old-conversation");
    expect(useAIStore.getState().activeConversationId).toBeNull();
    expect(useAIStore.getState().sidebarActiveConversationId).toBeNull();
    expect(useAIStore.getState().isStartingConversation).toBe(true);
    expect(useAIStore.getState().messages).toMatchObject([
      {
        role: "user",
        content: "Give me an overview of the system status",
        localOnly: true,
      },
      {
        role: "assistant",
        content: "",
        isStreaming: true,
      },
    ]);
  });

  it("allows starting a new conversation while a previous run is still streaming", async () => {
    const socket = await connectAI();

    useAIStore.setState({
      messages: [],
      activeConversationId: "old-conversation",
      sidebarActiveConversationId: null,
      activeRunId: "old-run",
      isStreaming: true,
      savedName: "Old conversation",
      lastContext: null,
    });

    useAIStore.getState().sendMessage("Start a separate chat", undefined, [], {
      startNewConversation: true,
    });

    const payload = sentPayloads(socket).find((item) => item.type === "conversation.send_message");
    expect(payload).toMatchObject({
      content: "Start a separate chat",
    });
    expect(payload).not.toHaveProperty("conversationId", "old-conversation");
    expect(useAIStore.getState().activeConversationId).toBeNull();
    expect(useAIStore.getState().activeRunId).toBeNull();
  });

  it("does not reselect a stale conversation load after starting a new chat", async () => {
    const socket = await connectAI();
    let resolveConversation: (value: Awaited<ReturnType<typeof getConversation>>) => void =
      () => {};
    vi.mocked(getConversation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConversation = resolve;
        })
    );

    useAIStore.setState({
      messages: [{ id: "old-message", role: "user", content: "old chat" }],
      activeConversationId: "old-conversation",
      sidebarActiveConversationId: "old-conversation",
      savedName: "Old chat",
    });

    const loadPromise = useAIStore.getState().loadConversation("conversation-1");
    expect(useAIStore.getState().activeConversationId).toBe("old-conversation");
    expect(useAIStore.getState().sidebarActiveConversationId).toBe("conversation-1");
    expect(useAIStore.getState().messages).toEqual([
      expect.objectContaining({ id: "old-message", content: "old chat" }),
    ]);

    useAIStore.getState().clearMessages();
    expect(useAIStore.getState().activeConversationId).toBeNull();
    expect(useAIStore.getState().sidebarActiveConversationId).toBeNull();

    resolveConversation({
      id: "conversation-1",
      title: "Restored chat",
      messages: [{ id: "message-1", role: "user", content: "hello" }],
      lastContext: null,
      createdAt: "2026-06-26T09:59:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
      lastUserMessageAt: "2026-06-26T10:00:00.000Z",
      folderId: null,
      status: "active",
      blockReason: null,
      activeRunStatus: null,
    });
    await loadPromise;

    expect(useAIStore.getState().activeConversationId).toBeNull();
    expect(useAIStore.getState().sidebarActiveConversationId).toBeNull();
    expect(sentPayloads(socket)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.subscribe",
          conversationId: "conversation-1",
        }),
      ])
    );
  });

  it("does not reselect a chat from a late non-message command ack", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: null,
      sidebarActiveConversationId: null,
    });

    socket.emit({
      type: "command.ack",
      commandType: "question.answer",
      clientCommandId: "command-1",
      conversationId: "conversation-1",
      runId: "run-1",
    });

    expect(useAIStore.getState().activeConversationId).toBeNull();
    expect(useAIStore.getState().sidebarActiveConversationId).toBeNull();
    expect(useAIStore.getState().activeRunId).toBeNull();
  });

  it("normalizes restored conversations before they reach message renderers", async () => {
    const socket = await connectAI();
    vi.mocked(getConversation).mockResolvedValueOnce({
      id: "conversation-1",
      title: "Restored chat",
      messages: [
        {
          role: "assistant",
          content: "Still working",
          toolCalls: [
            {
              name: "find_resource",
              arguments: { query: "certificates" },
              status: "completed",
            },
          ],
        },
      ] as any,
      lastContext: null,
      createdAt: "2026-06-26T09:59:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
      lastUserMessageAt: "2026-06-26T10:00:00.000Z",
      folderId: null,
      status: "active",
      blockReason: null,
      activeRunStatus: null,
    });

    await useAIStore.getState().loadConversation("conversation-1");

    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.subscribe",
          conversationId: "conversation-1",
        }),
      ])
    );
    expect(useAIStore.getState().messages).toEqual([
      expect.objectContaining({
        id: "conversation-1:message:0",
        role: "assistant",
        content: "Still working",
        toolCalls: [
          expect.objectContaining({
            id: "conversation-1:message:0:tool:0",
            name: "find_resource",
            status: "completed",
          }),
        ],
      }),
    ]);
  });

  it("rolls a backend conversation back to an edited user message", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      messages: [
        { id: "user-1", role: "user", content: "old prompt" },
        { id: "assistant-1", role: "assistant", content: "old answer" },
      ],
    });
    vi.mocked(rollbackConversationToMessage).mockResolvedValueOnce({
      message: { id: "user-1", role: "user", content: "old prompt" },
      conversation: {
        id: "conversation-1",
        title: "Editable chat",
        messages: [],
        lastContext: null,
        createdAt: "2026-06-26T09:59:00.000Z",
        updatedAt: "2026-06-26T10:00:00.000Z",
        lastUserMessageAt: "2026-06-26T10:00:00.000Z",
        folderId: null,
        status: "active",
        blockReason: null,
        activeRunStatus: null,
      },
    });

    const message = await useAIStore.getState().rollbackToMessage("user-1");

    expect(rollbackConversationToMessage).toHaveBeenCalledWith("conversation-1", "user-1");
    expect(message).toEqual({ id: "user-1", role: "user", content: "old prompt" });
    expect(useAIStore.getState().messages).toEqual([]);
    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.sync",
          conversationId: "conversation-1",
        }),
      ])
    );
  });

  it("retries a failed turn by rolling it back and sending it again", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      lastContext: { route: "/settings" },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "old prompt",
          attachments: [],
        },
        {
          id: "assistant-error",
          role: "assistant",
          content: "**Error:** provider failed",
          localOnly: true,
          runError: true,
        },
      ],
    });
    vi.mocked(rollbackConversationToMessage).mockResolvedValueOnce({
      message: {
        id: "user-1",
        role: "user",
        content: "old prompt",
        attachments: [],
      },
      conversation: {
        id: "conversation-1",
        title: "Retry chat",
        messages: [],
        lastContext: { route: "/settings" },
        createdAt: "2026-06-26T09:59:00.000Z",
        updatedAt: "2026-06-26T10:00:00.000Z",
        lastUserMessageAt: "2026-06-26T10:00:00.000Z",
        folderId: null,
        status: "active",
        blockReason: null,
        activeRunStatus: null,
      },
    });

    await useAIStore.getState().retryMessage("user-1");

    expect(rollbackConversationToMessage).toHaveBeenCalledWith("conversation-1", "user-1");
    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.send_message",
          conversationId: "conversation-1",
          content: "old prompt",
          context: { route: "/settings" },
        }),
      ])
    );
  });

  it("cancels the active run when rolling back to a user message", async () => {
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      isStreaming: true,
      isCompactingContext: false,
      messages: [{ id: "user-1", role: "user", content: "old prompt" }],
    });
    vi.mocked(rollbackConversationToMessage).mockResolvedValueOnce({
      message: { id: "user-1", role: "user", content: "old prompt" },
      conversation: {
        id: "conversation-1",
        title: "Editable chat",
        messages: [],
        lastContext: null,
        createdAt: "2026-06-26T09:59:00.000Z",
        updatedAt: "2026-06-26T10:00:00.000Z",
        lastUserMessageAt: "2026-06-26T10:00:00.000Z",
        folderId: null,
        status: "active",
        blockReason: null,
        activeRunStatus: null,
      },
    });

    const message = await useAIStore.getState().rollbackToMessage("user-1");

    expect(rollbackConversationToMessage).toHaveBeenCalledWith("conversation-1", "user-1", "run-1");
    expect(message).toEqual({ id: "user-1", role: "user", content: "old prompt" });
    expect(useAIStore.getState()).toMatchObject({
      activeRunId: null,
      isStreaming: false,
      isCompactingContext: false,
    });
  });

  it("does not roll back while context compaction is running", async () => {
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "compact-run-1",
      isStreaming: true,
      isCompactingContext: true,
      messages: [{ id: "user-1", role: "user", content: "old prompt" }],
    });

    const message = await useAIStore.getState().rollbackToMessage("user-1");

    expect(message).toBeNull();
    expect(rollbackConversationToMessage).not.toHaveBeenCalled();
  });

  it("projects backend runtime snapshots into messages and pending approval state", async () => {
    const socket = await connectAI();
    useAIStore.setState({ isStartingConversation: true });

    socket.emit({
      type: "command.ack",
      commandType: "conversation.send_message",
      clientCommandId: "command-1",
      conversationId: "conversation-1",
      runId: "run-1",
    });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        resourceReferences: [
          {
            refId: "gwr_0123456789abcdef01234567",
            type: "docker_container",
            resourceId: "container-1",
            label: "runtime-container",
            relation: "created",
            nodeId: "node-1",
            nodeSlug: "docker-src",
          },
        ],
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          { id: "message-1", role: "assistant", content: "Checking..." },
          {
            id: "message-2",
            role: "assistant",
            content: "**Error:** provider failed",
            localOnly: true,
          },
        ],
        runtime: {
          activeRun: {
            id: "run-1",
            conversationId: "conversation-1",
            userId: "user-1",
            status: "waiting_for_approval",
            activeMessageId: "message-1",
            clientCommandId: "command-1",
            assistantDraftContent: null,
            error: null,
            startedAt: "2026-06-26T10:00:00.000Z",
            completedAt: null,
            stoppedAt: null,
            createdAt: "2026-06-26T10:00:00.000Z",
            updatedAt: "2026-06-26T10:00:01.000Z",
          },
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "comment-row",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: "message-1",
              toolCallId: "comment-1",
              toolName: "send_comment",
              toolArgs: { message: "Checking..." },
              classification: "system-never-ask",
              approvalPolicy: "system_skipped",
              requiredScopes: [],
              status: "created",
              decision: null,
              result: null,
              error: null,
            },
            {
              id: "approval-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: "message-1",
              toolCallId: "tool-1",
              toolName: "pull_docker_image",
              toolArgs: { imageRef: "redis:latest" },
              classification: "create",
              approvalPolicy: "normal",
              requiredScopes: [],
              status: "pending_approval",
              decision: null,
              result: null,
              error: null,
            },
          ],
        },
      },
    });

    expect(useAIStore.getState()).toMatchObject({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      pendingApprovalToolCallId: null,
      isStreaming: true,
      isStartingConversation: false,
      resourceReferences: [
        expect.objectContaining({
          refId: "gwr_0123456789abcdef01234567",
          type: "docker_container",
        }),
      ],
    });
    expect(useAIStore.getState().messages[0].toolCalls).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "pull_docker_image",
        status: "awaiting_approval",
      }),
    ]);
    expect(useAIStore.getState().messages[1]).toMatchObject({
      content: "**Error:** provider failed",
      localOnly: true,
    });
  });

  it("updates the sidebar from runtime snapshots without refetching conversations", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });
    vi.mocked(listConversations).mockClear();

    const snapshot = {
      conversation: {
        id: "conversation-1",
        title: "Runtime chat",
        createdAt: "2026-06-26T10:00:00.000Z",
        updatedAt: "2026-06-26T10:00:01.000Z",
        folderId: null,
        lastUserMessageAt: "2026-06-26T10:00:00.000Z",
        messageCount: 1,
        status: "active" as const,
        blockReason: null,
        lastContext: null,
        discoveredToolsets: [],
        checkpoint: null,
      },
      messages: [
        { id: "message-1", role: "user", content: "hello", createdAt: "2026-06-26T10:00:00.000Z" },
      ],
      runtime: {
        activeRun: runtimeRun("running"),
        pendingApprovals: [],
        pendingQuestion: null,
        pendingQuestions: [],
        toolCalls: [],
      },
    };

    socket.emit({ type: "conversation.snapshot", conversationId: "conversation-1", snapshot });
    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        ...snapshot,
        conversation: {
          ...snapshot.conversation,
          updatedAt: "2026-06-26T10:00:02.000Z",
        },
      },
    });

    expect(listConversations).not.toHaveBeenCalled();
    expect(useAIStore.getState().recentConversations).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        title: "Runtime chat",
        messageCount: 1,
        activeRunStatus: "running",
      }),
    ]);
  });

  it("streams assistant deltas without REST refetches and ignores stale draft snapshots", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      recentConversations: [
        {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:00.000Z",
          lastUserMessageAt: "2026-06-26T10:00:00.000Z",
          folderId: null,
          messageCount: 1,
          status: "active",
          blockReason: null,
          activeRunStatus: "running",
        },
      ],
    });
    vi.mocked(listConversations).mockClear();
    vi.mocked(getConversation).mockClear();

    socket.emit({
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Hel",
      version: 1,
    });
    socket.emit({
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "lo",
      version: 2,
    });

    expect(useAIStore.getState().messages).toEqual([
      expect.objectContaining({
        id: "run-1:runtime",
        role: "assistant",
        content: "Hello",
        isStreaming: true,
      }),
    ]);

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          {
            id: "run-1:draft",
            role: "assistant",
            content: "Hel",
            isStreaming: true,
          },
        ],
        runtime: {
          activeRun: runtimeRun("running"),
          assistantDraftContent: "Hel",
          assistantDraftVersion: 1,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState().messages[0]).toMatchObject({
      id: "run-1:draft",
      content: "Hello",
      isStreaming: true,
    });

    socket.emit({
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: " after approval",
      version: 3,
    });

    expect(useAIStore.getState().messages[0]).toMatchObject({
      id: "run-1:draft",
      content: "Hello after approval",
      isStreaming: true,
    });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:02.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          {
            id: "assistant-final",
            role: "assistant",
            content: "Hello after approval",
            isStreaming: false,
          },
        ],
        runtime: {
          activeRun: null,
          assistantDraftContent: null,
          assistantDraftVersion: null,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState()).toMatchObject({
      activeRunId: null,
      isStreaming: false,
    });
    expect(useAIStore.getState().messages).toEqual([
      expect.objectContaining({
        id: "assistant-final",
        content: "Hello after approval",
        isStreaming: false,
      }),
    ]);
    expect(listConversations).not.toHaveBeenCalled();
    expect(getConversation).not.toHaveBeenCalled();
  });

  it("merges pending ask_question runtime state into the saved assistant tool call", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_question_1",
                type: "function",
                function: {
                  name: "ask_question",
                  arguments: JSON.stringify({
                    question: "Убить все активные sandbox-процессы?",
                    options: [
                      { label: "yes", description: "Да" },
                      { label: "no", description: "Нет" },
                    ],
                    allowFreeText: false,
                  }),
                },
              },
            ],
          },
        ],
        runtime: {
          activeRun: runtimeRun("waiting_for_answer"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [
            {
              id: "question-row-1",
              runId: "run-1",
              conversationId: "conversation-1",
              toolCallId: "call_question_1",
              question: "Убить все активные sandbox-процессы?",
              status: "pending",
              answer: null,
            },
          ],
          toolCalls: [],
        },
      },
    });

    const questionToolCalls = useAIStore
      .getState()
      .messages.flatMap((message) => message.toolCalls ?? [])
      .filter((toolCall) => toolCall.name === "ask_question");

    expect(questionToolCalls).toEqual([
      expect.objectContaining({
        id: "call_question_1",
        status: "awaiting_approval",
        arguments: {
          question: "Убить все активные sandbox-процессы?",
          options: [
            { label: "yes", description: "Да" },
            { label: "no", description: "Нет" },
          ],
          allowFreeText: false,
        },
      }),
    ]);

    useAIStore.getState().answerQuestion("call_question_1", "yes");

    expect(getToolCall("call_question_1")).toMatchObject({
      status: "running",
      result: { answer: "yes" },
    });
    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "question.answer",
          questionId: "call_question_1",
          answer: "yes",
        }),
      ])
    );
  });

  it("restores an ask_question answer when the backend rejects the command", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      pendingApprovalToolCallId: "call_question_1",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_question_1",
              name: "ask_question",
              arguments: { question: "Continue?" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
    });

    useAIStore.getState().answerQuestion("call_question_1", "yes");
    const command = sentPayloads(socket).find((payload) => payload.type === "question.answer");

    socket.emit({
      type: "command.error",
      commandType: "question.answer",
      clientCommandId: command?.clientCommandId as string,
      conversationId: "conversation-1",
      runId: "run-1",
      code: "QUESTION_REJECTED",
      message: "Question is no longer pending",
    });

    expect(useAIStore.getState().pendingApprovalToolCallId).toBe("call_question_1");
    expect(getToolCall("call_question_1")).toMatchObject({
      status: "awaiting_approval",
      error: "Question is no longer pending",
    });
    expect(getToolCall("call_question_1")?.result).toBeUndefined();
  });

  it("marks answered questions complete and shows a runtime thinking placeholder", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      pendingApprovalToolCallId: "call_question_1",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_question_1",
              name: "ask_question",
              arguments: { question: "Continue?" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
    });

    socket.emit({
      type: "question.answered",
      conversationId: "conversation-1",
      runId: "run-1",
      duplicate: false,
      question: {
        id: "question-row-1",
        runId: "run-1",
        conversationId: "conversation-1",
        toolCallId: "call_question_1",
        question: "Continue?",
        status: "answered",
        answer: "yes",
      },
    });

    expect(useAIStore.getState().pendingApprovalToolCallId).toBeNull();
    expect(getToolCall("call_question_1")).toMatchObject({
      status: "completed",
      result: { answer: "yes" },
    });
    expect(useAIStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-1:runtime",
          isStreaming: true,
          content: "",
        }),
      ])
    );
  });

  it("separates consecutive streamed assistant comments with a thinking placeholder", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "assistant.comment_delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Первый комментарий.",
      version: 1,
    });

    socket.emit({
      type: "assistant.comment_done",
      conversationId: "conversation-1",
      runId: "run-1",
    });

    socket.emit({
      type: "assistant.comment_delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Второй комментарий.",
      version: 2,
    });

    expect(useAIStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-1:comment:1",
          content: "Первый комментарий.",
          isStreaming: false,
        }),
        expect.objectContaining({
          id: "run-1:comment:2",
          content: "Второй комментарий.",
          isStreaming: true,
        }),
      ])
    );
  });

  it("restores Thinking when comment completion races with a runtime draft", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      messages: [
        {
          id: "run-1:runtime",
          role: "assistant",
          content: "Учитываю уточнение пользователя.",
          sequence: 1,
          isStreaming: true,
        },
      ],
    });

    socket.emit({
      type: "assistant.comment_done",
      conversationId: "conversation-1",
      runId: "run-1",
    });

    expect(useAIStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "Учитываю уточнение пользователя.",
          isStreaming: false,
        }),
        expect.objectContaining({
          id: "run-1:runtime",
          content: "",
          isStreaming: true,
        }),
      ])
    );
  });

  it("ignores a stale comment draft snapshot received after comment completion", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "assistant.comment_delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Проверяю ресурсы.",
      version: 1,
    });
    socket.emit({
      type: "assistant.comment_done",
      conversationId: "conversation-1",
      runId: "run-1",
    });
    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        revision: 1,
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [],
        runtime: {
          activeRun: runtimeRun("running"),
          assistantDraftContent: "Проверяю ресурсы.",
          assistantDraftVersion: 1,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState().isStreaming).toBe(true);
    expect(useAIStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-1:comment:1",
          content: "Проверяю ресурсы.",
          isStreaming: false,
        }),
        expect.objectContaining({
          id: "run-1:runtime",
          content: "",
          isStreaming: true,
        }),
      ])
    );
    expect(
      useAIStore.getState().messages.some((message) => message.content === "Проверяю ресурсы.")
    ).toBe(true);
  });

  it("updates background chat runtime status from snapshots and status events", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-current",
      recentConversations: [
        {
          id: "conversation-1",
          title: "Background chat",
          createdAt: "2026-06-26T09:00:00.000Z",
          updatedAt: "2026-06-26T10:00:00.000Z",
          lastUserMessageAt: "2026-06-26T09:30:00.000Z",
          folderId: null,
          messageCount: 2,
          status: "active",
          blockReason: null,
          activeRunStatus: "running",
        },
      ],
    });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Background chat",
          createdAt: "2026-06-26T09:00:00.000Z",
          updatedAt: "2026-06-26T10:00:00.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [],
        runtime: {
          activeRun: runtimeRun("waiting_for_answer"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState().recentConversations[0].activeRunStatus).toBe("waiting_for_answer");
    expect(useAIStore.getState().activeConversationId).toBe("conversation-current");

    socket.emit({
      type: "run.status_changed",
      conversationId: "conversation-1",
      run: null,
    });

    expect(useAIStore.getState().recentConversations[0].activeRunStatus).toBeNull();
  });

  it("orders restored snapshot messages by backend sequence", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          {
            id: "assistant-1",
            sequence: 1,
            role: "assistant",
            content: "Answer",
          },
          {
            id: "user-1",
            sequence: 0,
            role: "user",
            content: "Question",
          },
        ],
        runtime: {
          activeRun: null,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState().messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("ignores a snapshot whose conversation revision is older than the applied snapshot", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });
    const snapshot = (revision: number, content: string) => ({
      revision,
      conversation: {
        id: "conversation-1",
        title: "Runtime chat",
        createdAt: "2026-06-26T10:00:00.000Z",
        updatedAt: "2026-06-26T10:00:01.000Z",
        lastContext: null,
        discoveredToolsets: [],
        checkpoint: null,
      },
      messages: [{ id: `message-${revision}`, sequence: 0, role: "assistant", content }],
      runtime: {
        activeRun: null,
        pendingApprovals: [],
        pendingQuestion: null,
        pendingQuestions: [],
        toolCalls: [],
      },
    });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: snapshot(12, "new state") as any,
    });
    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: snapshot(11, "stale state") as any,
    });
    socket.emit({
      type: "run.status_changed",
      conversationId: "conversation-1",
      revision: 11,
      run: { id: "stale-run", status: "running" } as any,
    });

    expect(useAIStore.getState().messages).toEqual([
      expect.objectContaining({ content: "new state" }),
    ]);
    expect(useAIStore.getState().activeRunId).toBeNull();
    expect(useAIStore.getState().isStreaming).toBe(false);
  });

  it("ignores a plan status event older than the applied conversation revision", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });
    const currentPlan = planSnapshot({
      status: "executing",
      revisionId: "revision-2",
      revision: 2,
      revisionStatus: "accepted",
      goal: "Current plan",
    });

    socket.emit({
      type: "plan.status_changed",
      conversationId: "conversation-1",
      plan: currentPlan,
      revision: 12,
    });
    socket.emit({
      type: "plan.status_changed",
      conversationId: "conversation-1",
      plan: planSnapshot({ goal: "Stale plan" }),
      revision: 11,
    });

    expect(useAIStore.getState().activePlan).toEqual(currentPlan);
    expect(useAIStore.getState().plans).toEqual([currentPlan]);
  });

  it("renders tool-only active turns in a runtime placeholder instead of the previous assistant reply", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          { id: "assistant-old", role: "assistant", content: "Previous answer" },
          { id: "user-new", role: "user", content: "Pull redis" },
        ],
        runtime: {
          activeRun: {
            id: "run-1",
            conversationId: "conversation-1",
            userId: "user-1",
            status: "waiting_for_approval",
            activeMessageId: "user-new",
            clientCommandId: "command-1",
            assistantDraftContent: null,
            error: null,
            startedAt: "2026-06-26T10:00:00.000Z",
            completedAt: null,
            stoppedAt: null,
            createdAt: "2026-06-26T10:00:00.000Z",
            updatedAt: "2026-06-26T10:00:01.000Z",
          },
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "approval-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: null,
              toolCallId: "tool-1",
              toolName: "pull_docker_image",
              toolArgs: { imageRef: "redis:latest" },
              classification: "create",
              approvalPolicy: "normal",
              requiredScopes: [],
              status: "pending_approval",
              decision: null,
              result: null,
              error: null,
            },
          ],
        },
      },
    });

    const { messages } = useAIStore.getState();
    expect(messages.find((message) => message.id === "assistant-old")?.toolCalls).toBeUndefined();
    expect(messages.at(-1)).toMatchObject({
      id: "run-1:runtime",
      role: "assistant",
      isStreaming: true,
      toolCalls: [expect.objectContaining({ id: "tool-1" })],
    });
  });

  it("creates a thinking placeholder for an active run before the first tool or text arrives", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [{ id: "user-1", sequence: 0, role: "user", content: "Check status" }],
        runtime: {
          activeRun: runtimeRun("running"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState().messages.at(-1)).toMatchObject({
      id: "run-1:runtime",
      role: "assistant",
      content: "",
      isStreaming: true,
    });
  });

  it("uses a runtime placeholder after completed active-run tools while waiting for the next response", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          { id: "user-1", sequence: 0, role: "user", content: "List databases" },
          { id: "tool-boundary-1", sequence: 1, role: "assistant", content: "" },
        ],
        runtime: {
          activeRun: runtimeRun("running"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "tool-row-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: "tool-boundary-1",
              toolCallId: "tool-1",
              toolName: "list_databases",
              toolArgs: {},
              classification: "read",
              approvalPolicy: "auto_approved",
              requiredScopes: [],
              status: "completed",
              decision: null,
              result: { data: [] },
              error: null,
            },
          ],
        },
      },
    });

    expect(
      useAIStore.getState().messages.find((message) => message.id === "tool-boundary-1")
    ).toMatchObject({
      isStreaming: false,
      toolCalls: [expect.objectContaining({ id: "tool-1", runId: "run-1", status: "completed" })],
    });
    expect(useAIStore.getState().messages.at(-1)).toMatchObject({
      id: "run-1:runtime",
      role: "assistant",
      content: "",
      isStreaming: true,
    });
  });

  it("keeps the active run tool boundary streaming while a tool is still running", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          { id: "user-1", sequence: 0, role: "user", content: "List databases" },
          { id: "tool-boundary-1", sequence: 1, role: "assistant", content: "" },
        ],
        runtime: {
          activeRun: runtimeRun("running"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "tool-row-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: "tool-boundary-1",
              toolCallId: "tool-1",
              toolName: "list_databases",
              toolArgs: {},
              classification: "read",
              approvalPolicy: "auto_approved",
              requiredScopes: [],
              status: "running",
              decision: null,
              result: null,
              error: null,
            },
          ],
        },
      },
    });

    expect(
      useAIStore.getState().messages.find((message) => message.id === "tool-boundary-1")
    ).toMatchObject({
      isStreaming: true,
      toolCalls: [expect.objectContaining({ id: "tool-1", runId: "run-1", status: "running" })],
    });
    expect(useAIStore.getState().messages.some((message) => message.id === "run-1:runtime")).toBe(
      false
    );
  });

  it("stops showing thinking on the tool boundary once assistant text starts streaming", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          { id: "user-1", sequence: 0, role: "user", content: "List databases" },
          { id: "tool-boundary-1", sequence: 1, role: "assistant", content: "" },
        ],
        runtime: {
          activeRun: runtimeRun("running"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "tool-row-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: "tool-boundary-1",
              toolCallId: "tool-1",
              toolName: "list_databases",
              toolArgs: {},
              classification: "read",
              approvalPolicy: "auto_approved",
              requiredScopes: [],
              status: "completed",
              decision: null,
              result: { data: [] },
              error: null,
            },
          ],
        },
      },
    });

    socket.emit({
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Done",
      version: 1,
    });

    expect(
      useAIStore.getState().messages.find((message) => message.id === "tool-boundary-1")
    ).toMatchObject({ isStreaming: false });
    expect(useAIStore.getState().messages.at(-1)).toMatchObject({
      id: "run-1:runtime",
      content: "Done",
      isStreaming: true,
    });
  });

  it("keeps an assistant comment snapshot separate from the following runtime answer", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          {
            id: "tool-boundary-1",
            role: "assistant",
            content: "",
            toolGroupBoundary: true,
          },
          {
            id: "assistant-comment-1",
            role: "assistant",
            content: "Проверяю доступность основных ресурсов.",
          },
        ],
        runtime: {
          activeRun: runtimeRun("running"),
          assistantDraftContent: null,
          assistantDraftVersion: 0,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "tool-row-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: "tool-boundary-1",
              toolCallId: "tool-1",
              toolName: "list_databases",
              toolArgs: {},
              classification: "read",
              approvalPolicy: "auto_approved",
              requiredScopes: [],
              status: "completed",
              decision: null,
              result: { data: [] },
              error: null,
            },
          ],
        },
      },
    });

    expect(useAIStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-comment-1",
          content: "Проверяю доступность основных ресурсов.",
          isStreaming: false,
        }),
        expect.objectContaining({
          id: "run-1:runtime",
          content: "",
          isStreaming: true,
        }),
      ])
    );

    socket.emit({
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Проверил доступность.",
      version: 1,
    });

    expect(
      useAIStore.getState().messages.find((message) => message.id === "assistant-comment-1")
    ).toMatchObject({
      content: "Проверяю доступность основных ресурсов.",
      isStreaming: false,
    });
    expect(
      useAIStore.getState().messages.find((message) => message.id === "run-1:runtime")
    ).toMatchObject({
      content: "Проверил доступность.",
      isStreaming: true,
    });
  });

  it("streams assistant comments into a separate live message from the final answer", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      messages: [
        {
          id: "run-1:runtime",
          role: "assistant",
          content: "",
          sequence: 1,
          isStreaming: true,
        },
      ],
    });

    socket.emit({
      type: "assistant.comment_delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Проверяю ресурсы.",
      version: 1,
    });
    socket.emit({
      type: "assistant.comment_done",
      conversationId: "conversation-1",
      runId: "run-1",
    });
    socket.emit({
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Проверил ресурсы.",
      version: 2,
    });

    expect(useAIStore.getState().messages).toEqual([
      expect.objectContaining({
        id: "run-1:comment:1",
        content: "Проверяю ресурсы.",
        isStreaming: false,
      }),
      expect.objectContaining({
        id: "run-1:runtime",
        content: "Проверил ресурсы.",
        isStreaming: true,
      }),
    ]);
  });

  it("keeps unassigned completed tool calls after the latest user turn", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Runtime chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [
          { id: "assistant-old", sequence: 0, role: "assistant", content: "Previous answer" },
          { id: "user-new", sequence: 1, role: "user", content: "Off-topic request" },
        ],
        runtime: {
          activeRun: null,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [
            {
              id: "tool-row-1",
              runId: "run-1",
              conversationId: "conversation-1",
              assistantMessageId: null,
              toolCallId: "tool-1",
              toolName: "end_conversation",
              toolArgs: { reason: "I can only help with Gateway infrastructure." },
              classification: "read",
              approvalPolicy: "auto_approved",
              requiredScopes: [],
              status: "completed",
              decision: null,
              result: { ended: true },
              error: null,
            },
          ],
        },
      },
    });

    const { messages } = useAIStore.getState();
    expect(messages.find((message) => message.id === "assistant-old")?.toolCalls).toBeUndefined();
    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      toolCalls: [expect.objectContaining({ id: "tool-1", name: "end_conversation" })],
    });
  });

  it("blocks new sends after a conversation status marker is restored", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Ended chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
          status: "ended",
          blockReason: "I can only help with Gateway infrastructure.",
        },
        messages: [
          { id: "user-1", sequence: 0, role: "user", content: "Give me a recipe" },
          {
            id: "status-1",
            sequence: 1,
            role: "assistant",
            content: "",
            conversationStatus: "ended",
            blockReason: "I can only help with Gateway infrastructure.",
          },
        ],
        runtime: {
          activeRun: null,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    useAIStore.getState().sendMessage("let me continue");

    expect(sentPayloads(socket)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "conversation.send_message", content: "let me continue" }),
      ])
    );
  });

  it("allows new sends after a compact marker supersedes a context-blocked marker", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "Compacted chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
          status: "active",
          blockReason: null,
        },
        messages: [
          { id: "user-1", sequence: 0, role: "user", content: "Need a lot of context" },
          {
            id: "status-1",
            sequence: 1,
            role: "assistant",
            content: "",
            conversationStatus: "context_blocked",
            blockReason: "Context window exceeded",
          },
          {
            id: "compact-1",
            sequence: 2,
            role: "assistant",
            content: "Compacted summary",
            compactMarker: true,
            compactTailMessageCount: 1,
          },
        ],
        runtime: {
          activeRun: null,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    useAIStore.getState().sendMessage("continue");

    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "conversation.send_message", content: "continue" }),
      ])
    );
  });

  it("ignores stale snapshots after the active conversation changes", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-new",
      messages: [{ id: "new-user", role: "user", content: "New chat" }],
    });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-old",
      snapshot: {
        conversation: {
          id: "conversation-old",
          title: "Old chat",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [{ id: "old-assistant", role: "assistant", content: "Old answer" }],
        runtime: {
          activeRun: null,
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState().activeConversationId).toBe("conversation-new");
    expect(useAIStore.getState().messages).toEqual([
      { id: "new-user", role: "user", content: "New chat" },
    ]);
  });

  it("opens a credential challenge immediately and preserves it across a stale active snapshot", async () => {
    const socket = await connectAI();
    useAIStore.setState({ activeConversationId: "conversation-1" });
    const challenge = {
      id: "challenge-1",
      runId: "run-1",
      conversationId: "conversation-1",
      userId: "user-1",
      provider: "gitlab" as const,
      connectorId: "connector-1",
      toolCallId: "tool-1",
      toolName: "gitlab_list_projects",
      status: "pending" as const,
      decisionClientCommandId: null,
      resolvedAt: null,
      createdAt: "2026-06-26T10:00:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
    };

    socket.emit({
      type: "credential.required",
      conversationId: "conversation-1",
      runId: "run-1",
      challenge,
    });

    expect(useAIStore.getState()).toMatchObject({
      activeRunId: "run-1",
      isStreaming: true,
      pendingCredentialChallenge: challenge,
    });

    socket.emit({
      type: "conversation.snapshot",
      conversationId: "conversation-1",
      snapshot: {
        conversation: {
          id: "conversation-1",
          title: "GitLab access",
          createdAt: "2026-06-26T10:00:00.000Z",
          updatedAt: "2026-06-26T10:00:01.000Z",
          lastContext: null,
          discoveredToolsets: [],
          checkpoint: null,
        },
        messages: [],
        runtime: {
          activeRun: runtimeRun("running"),
          pendingApprovals: [],
          pendingQuestion: null,
          pendingQuestions: [],
          pendingCredentialChallenge: null,
          toolCalls: [],
        },
      },
    });

    expect(useAIStore.getState()).toMatchObject({
      isStreaming: true,
      pendingCredentialChallenge: challenge,
    });

    socket.emit({
      type: "credential.updated",
      conversationId: "conversation-1",
      runId: "run-1",
      challenge: { ...challenge, status: "authorized" },
      duplicate: false,
    });
    expect(useAIStore.getState().pendingCredentialChallenge).toBeNull();
  });

  it("sends approval decisions idempotently to the backend runtime", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      pendingApprovalToolCallId: "tool-1",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "pull_docker_image",
              arguments: { imageRef: "redis:latest" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
    });

    useAIStore.getState().approveTool("tool-1");

    expect(getToolCall("tool-1")).toMatchObject({
      status: "running",
      approvalDecisionPending: true,
    });

    const command = sentPayloads(socket).find((payload) => payload.type === "approval.decide");
    expect(sentPayloads(socket)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval.decide",
          conversationId: "conversation-1",
          runId: "run-1",
          approvalId: "tool-1",
          decision: "approved",
        }),
      ])
    );

    socket.emit({
      type: "command.ack",
      commandType: "approval.decide",
      clientCommandId: command?.clientCommandId as string,
      conversationId: "conversation-1",
      runId: "run-1",
    });

    expect(getToolCall("tool-1")).toMatchObject({
      status: "running",
      approvalDecisionPending: false,
    });
  });

  it("installs a browser-only changed resources preview command", async () => {
    await connectAI();

    window.gatewayDev?.showChangedResources?.();

    const preview = useAIStore
      .getState()
      .messages.find((message) => message.id === "dev-changed-resources-preview-message");
    expect(preview?.changedResourceReferences).toEqual([
      expect.objectContaining({ type: "node", label: "docker-src", relation: "updated" }),
      expect.objectContaining({
        type: "docker_container",
        label: "ai-e2e-restart",
        relation: "created",
      }),
      expect.objectContaining({
        type: "docker_volume",
        label: "ai-e2e-restart-data",
        relation: "updated",
        nodeSlug: "docker-src",
      }),
    ]);

    window.gatewayDev?.hideChangedResources?.();
    expect(
      useAIStore
        .getState()
        .messages.some((message) => message.id === "dev-changed-resources-preview-message")
    ).toBe(false);
  });

  it("installs a browser-only plan progress preview command", async () => {
    await connectAI();

    window.gatewayDev?.showPlanProgress?.();

    const existingPlan = useAIStore.getState().activePlan;
    expect(useAIStore.getState().devPlanProgressPreview).toMatchObject({
      id: "dev-plan-progress-preview",
      status: "executing",
      steps: [
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "in_progress" }),
        expect.objectContaining({ status: "pending" }),
      ],
    });

    window.gatewayDev?.hidePlanProgress?.();
    expect(useAIStore.getState().devPlanProgressPreview).toBeNull();
    expect(useAIStore.getState().activePlan).toBe(existingPlan);
  });

  it("leaves approval retryable when the websocket is closed before send", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      pendingApprovalToolCallId: "tool-1",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "pull_docker_image",
              arguments: { imageRef: "redis:latest" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
    });
    socket.readyState = 3;

    useAIStore.getState().approveTool("tool-1");

    expect(sentPayloads(socket)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "approval.decide" })])
    );
    expect(getToolCall("tool-1")).toMatchObject({
      status: "awaiting_approval",
      error: "AI connection is not open",
    });
  });

  it("restores approval controls when the backend rejects an approval command", async () => {
    const socket = await connectAI();
    useAIStore.setState({
      activeConversationId: "conversation-1",
      activeRunId: "run-1",
      pendingApprovalToolCallId: "tool-1",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "pull_docker_image",
              arguments: { imageRef: "redis:latest" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
    });

    useAIStore.getState().approveTool("tool-1");
    expect(getToolCall("tool-1")).toMatchObject({ status: "running" });
    const command = sentPayloads(socket).find((payload) => payload.type === "approval.decide");

    socket.emit({
      type: "command.error",
      commandType: "approval.decide",
      clientCommandId: command?.clientCommandId as string,
      conversationId: "conversation-1",
      runId: "run-1",
      code: "APPROVAL_REJECTED",
      message: "Approval is no longer pending",
    });

    expect(useAIStore.getState().pendingApprovalToolCallId).toBe("tool-1");
    expect(getToolCall("tool-1")).toMatchObject({
      status: "awaiting_approval",
      approvalDecisionPending: false,
      error: "Approval is no longer pending",
    });
  });
});
